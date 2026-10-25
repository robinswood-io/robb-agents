import { resolve } from "node:path";
import { detectConfigFileType, detectAppConfigFileType, type ConfigFileDetection } from "../../../config/validators.ts";
import { CLI_DOMAIN_POLICIES, CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES, CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES, type CliDomainNamespace } from "../../../config/cli-domains.ts";
import { CONFIG_WRITE_TOOLS, LABELS_BLOCKED_FILE_TOOLS } from './tool-names.ts';

function buildCliDomainBlockMessage(namespace: CliDomainNamespace, context: string): string {
  const policy = CLI_DOMAIN_POLICIES[namespace]
  const noun = namespace === 'automation' ? 'automation' : namespace
  const quickExamplesHeading = namespace === 'label' ? 'Quick examples:' : 'Examples:'

  return [
    `${context}`,
    `Use \`craft-agent ${namespace} ...\` instead.`,
    `Run \`${policy.helpCommand}\` for the full ${noun} command reference.`,
    '',
    quickExamplesHeading,
    ...policy.quickExamples.map(example => `  ${example}`),
  ].join('\n')
}

function getWorkspaceRelativePath(
  filePath: string,
  workspaceRootPath: string,
  workingDirectory?: string,
): string | null {
  const normalizedWorkspaceRoot = resolve(workspaceRootPath).replace(/\\/g, '/').replace(/\/?$/, '/');
  const resolvedPath = filePath.startsWith('/')
    ? resolve(filePath)
    : resolve(workingDirectory ?? workspaceRootPath, filePath);
  const normalizedPath = resolvedPath.replace(/\\/g, '/');
  if (!normalizedPath.startsWith(normalizedWorkspaceRoot)) return null;

  return normalizedPath.slice(normalizedWorkspaceRoot.length);
}

function matchesPathScope(relativePath: string, scope: string): boolean {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3)
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  }

  if (scope.includes('*')) {
    const escaped = scope
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]+')
    return new RegExp(`^${escaped}$`).test(relativePath)
  }

  return relativePath === scope
}

function detectCliNamespaceFromConfigDetection(detection: ConfigFileDetection): CliDomainNamespace | null {
  if (detection.type === 'labels') return 'label'
  if (detection.type === 'automations') return 'automation'
  if (detection.type === 'source') return 'source'
  if (detection.type === 'skill') return 'skill'
  return null
}

/**
 * For selected config domains, enforce CLI usage instead of direct file operations.
 * - labels/**: strict block on Read/Write/Edit
 * - sources/{slug}/config.json: redirect on Write/Edit
 * - skills/{slug}/SKILL.md: redirect on Write/Edit
 * - automations.json: redirect on Write/Edit
 */
export function getConfigCliRedirect(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRootPath: string,
  workingDirectory?: string,
): { message: string } | null {
  const filePath = input.file_path as string | undefined;

  if (filePath && LABELS_BLOCKED_FILE_TOOLS.has(toolName)) {
    const relativePath = getWorkspaceRelativePath(filePath, workspaceRootPath, workingDirectory)
    if (relativePath) {
      const labelsScopeMatch = CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES.find(
        entry => entry.namespace === 'label' && matchesPathScope(relativePath, entry.scope)
      )
      if (labelsScopeMatch) {
        return {
          message: buildCliDomainBlockMessage(
            'label',
            `Direct ${toolName} operations in labels/ are blocked.`
          ),
        }
      }
    }
  }

  if (!CONFIG_WRITE_TOOLS.has(toolName)) return null;
  if (!filePath) return null;

  const detection =
    detectConfigFileType(filePath, workspaceRootPath) ?? detectAppConfigFileType(filePath);
  if (!detection) return null;

  const namespace = detectCliNamespaceFromConfigDetection(detection)
  if (!namespace) return null

  return {
    message: buildCliDomainBlockMessage(
      namespace,
      `Direct ${toolName} operations in ${detection.displayFile} are blocked.`
    ),
  }
}

/**
 * Block bash commands that operate on guarded config paths unless they use craft-agent commands.
 * Current guarded domains in Bash are declared in shared CLI domain policy.
 */
export function getConfigDomainBashRedirect(
  input: Record<string, unknown>,
  workspaceRootPath: string,
  workingDirectory?: string,
): { message: string } | null {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return null;

  if (/^craft-agent\s+(label|automation|source|skill)\b/.test(command)) {
    return null;
  }

  const baseDir = resolve(workingDirectory ?? workspaceRootPath);
  const tokenRegex = /'([^']+)'|"([^"]+)"|([^\s'";|&()<>]+)/g;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(command)) !== null) {
    const candidate = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!candidate) continue;
    if (!candidate.includes('/') && !candidate.includes('\\') && !candidate.endsWith('.json') && !candidate.endsWith('.jsonl')) {
      continue;
    }
    candidates.push(candidate);
  }

  const bashGuardEntries: Array<{ namespace: CliDomainNamespace; scope: string }> = CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES

  for (const candidate of candidates) {
    const relativePath = getWorkspaceRelativePath(candidate, workspaceRootPath, baseDir);
    if (!relativePath) continue;

    for (const entry of bashGuardEntries) {
      if (!matchesPathScope(relativePath, entry.scope)) continue

      const context = entry.namespace === 'label'
        ? 'Direct Bash operations targeting the workspace labels/ folder are blocked.'
        : `Direct Bash operations targeting \`${relativePath}\` are blocked.`

      return {
        message: buildCliDomainBlockMessage(entry.namespace, context),
      }
    }
  }

  return null;
}
