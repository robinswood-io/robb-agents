import { createHash } from "node:crypto";
import { shouldAllowToolInMode, isApiEndpointAllowed, isReadOnlyBashCommandWithConfig } from "../../mode-manager.ts";
import { permissionsConfigCache, type PermissionsContext } from "../../permissions-config.ts";
import type { PermissionManagerLike, ToolEffectDescriptor } from './contracts.ts';
import { FILE_WRITE_TOOLS } from './tool-names.ts';

// ============================================================
// ASK-MODE PROMPT DECISION (centralized across backends)
// ============================================================

interface PromptInfo {
  promptType: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
  description: string;
  command?: string;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
}

function hashCommand(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}

function toDisplayName(token: string): string {
  return token.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function classifyAdminApproval(command: string): PromptInfo | null {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();
  const tokens = normalized.split(/\s+/);

  if (tokens[0] === 'brew' && tokens[1] === 'install' && tokens[2] === '--cask' && tokens[3]) {
    const appToken = tokens[3];
    return {
      promptType: 'admin_approval',
      description: `Admin approval required for cask install: ${appToken}`,
      command: trimmed,
      appName: toDisplayName(appToken),
      reason: 'Homebrew needs admin access to complete post-install steps.',
      impact: 'May install files in /Applications and system-managed directories.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 10,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  if (tokens[0] === 'brew' && tokens[1] === 'upgrade' && tokens[2] === '--cask' && tokens[3]) {
    const appToken = tokens[3];
    return {
      promptType: 'admin_approval',
      description: `Admin approval required for cask upgrade: ${appToken}`,
      command: trimmed,
      appName: toDisplayName(appToken),
      reason: 'Homebrew needs admin access to replace app files in protected locations.',
      impact: 'May replace app binaries in /Applications and system-managed directories.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 10,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  const packageFlagIndex = tokens.indexOf('-pkg');
  const targetFlagIndex = tokens.indexOf('-target');
  if (
    tokens[0] === 'installer'
    && packageFlagIndex >= 0
    && Boolean(tokens[packageFlagIndex + 1])
    && targetFlagIndex > packageFlagIndex
    && tokens[targetFlagIndex + 1] === '/'
  ) {
    return {
      promptType: 'admin_approval',
      description: 'Admin approval required for macOS installer package',
      command: trimmed,
      appName: 'Installer Package',
      reason: 'The installer writes files to protected system locations.',
      impact: 'May install system services, app files, or startup items.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 5,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  return null;
}

export function wrapCommandForMacAdminPrompt(command: string): string {
  // Escape for AppleScript shell string: \ -> \\, " -> \", $ -> \$
  const escaped = command
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');

  return `osascript -e 'do shell script "${escaped}" with administrator privileges'`;
}

/**
 * Determine if user approval is needed in 'ask' mode.
 *
 * Returns prompt info if user should be asked, null if auto-allowed.
 * This is the single source of truth for ask-mode decisions across all agents.
 * `shouldAllowToolInMode()` always returns `{allowed: true}` in ask mode, so
 * the prompt decision lives here rather than being inferred from a permission
 * check.
 */
export function shouldPromptInAskMode(
  toolName: string,
  input: Record<string, unknown>,
  permissionManager: PermissionManagerLike,
  permissionsContext: PermissionsContext,
  plansFolderPath?: string,
  onDebug?: (message: string) => void,
  toolEffect?: ToolEffectDescriptor,
): PromptInfo | null {

  if (toolEffect?.kind === 'read') {
    onDebug?.(`Auto-allowing typed read-only tool: ${toolName}`);
    return null;
  }

  // --- File writes ---
  if (FILE_WRITE_TOOLS.has(toolName)) {
    if (permissionManager.isCommandWhitelisted(toolName)) {
      onDebug?.(`Auto-allowing "${toolName}" (previously approved)`);
      return null;
    }
    const filePath = (input["file_path"] as string) || (input["notebook_path"] as string) || 'unknown';
    return {
      promptType: 'file_write',
      description: `${toolName}: ${filePath}`,
      command: filePath,
    };
  }

  // --- Bash commands ---
  if (toolName === 'Bash') {
    const command = typeof input["command"] === 'string' ? input["command"] : '';
    const baseCommand = permissionManager.getBaseCommand(command);

    const adminPrompt = classifyAdminApproval(command);
    if (adminPrompt) {
      return adminPrompt;
    }

    // Auto-allow read-only commands using full AST-based validation
    // (same pipeline as Explore mode — catches redirects, substitutions, pipes to write commands)
    const mergedConfig = permissionsConfigCache.getMergedConfig(permissionsContext);
    if (isReadOnlyBashCommandWithConfig(command, mergedConfig)) {
      onDebug?.(`Auto-allowing read-only command: ${baseCommand}`);
      return null;
    }

    // Check session whitelist (not dangerous)
    if (permissionManager.isCommandWhitelisted(baseCommand) &&
        !permissionManager.isDangerousCommand(baseCommand)) {
      onDebug?.(`Auto-allowing "${baseCommand}" (previously approved)`);
      return null;
    }

    // Check domain whitelist for curl/wget
    if (['curl', 'wget'].includes(baseCommand)) {
      const domain = permissionManager.extractDomainFromNetworkCommand(command);
      if (domain && permissionManager.isDomainWhitelisted(domain)) {
        onDebug?.(`Auto-allowing ${baseCommand} to "${domain}" (domain whitelisted)`);
        return null;
      }
    }

    return {
      promptType: 'bash',
      description: `Execute: ${command}`,
      command,
    };
  }

  // --- MCP mutations ---
  if (toolName.startsWith('mcp__')) {
    // Check if it would be blocked in safe mode (= it's a mutation)
    const safeModeResult = shouldAllowToolInMode(
      toolName, input, 'safe', { ...(plansFolderPath !== undefined ? { plansFolderPath } : {}) }
    );
    if (!safeModeResult.allowed) {
      // It's a mutation — check whitelist
      if (permissionManager.isCommandWhitelisted(toolName)) {
        onDebug?.(`Auto-allowing "${toolName}" (previously approved)`);
        return null;
      }
      const serverAndTool = toolName.replace('mcp__', '').replace(/__/g, '/');
      return {
        promptType: 'mcp_mutation',
        description: `MCP: ${serverAndTool}`,
        command: toolName,
      };
    }
    // Read-only MCP tool — no prompt needed
    return null;
  }

  // --- API mutations ---
  if (toolName.startsWith('api_')) {
    const method = ((input?.["method"] as string) || 'GET').toUpperCase();
    const path = input?.["path"] as string | undefined;

    if (method !== 'GET') {
      const apiDescription = `${method} ${path || ''}`;

      // Check permissions.json whitelist
      if (isApiEndpointAllowed(method, path, permissionsContext)) {
        onDebug?.(`Auto-allowing API "${apiDescription}" (whitelisted in permissions.json)`);
        return null;
      }

      // Check session whitelist
      if (permissionManager.isCommandWhitelisted(apiDescription)) {
        onDebug?.(`Auto-allowing API "${apiDescription}" (previously approved)`);
        return null;
      }

      return {
        promptType: 'api_mutation',
        description: `API: ${apiDescription}`,
        command: apiDescription,
      };
    }
  }

  return null;
}
