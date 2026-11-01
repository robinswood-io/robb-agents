/**
 * Safe Mode Configuration
 *
 * Allows customization of Safe Mode rules per workspace and per source.
 * Users can create permissions.json files to extend the default rules.
 *
 * File locations:
 * - Workspace: ~/.craft-agent/workspaces/{slug}/permissions.json
 * - Per-source: ~/.craft-agent/workspaces/{slug}/sources/{sourceSlug}/permissions.json
 *
 * Rules are additive - custom configs extend the defaults (more permissive).
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolveConfigDir } from "../../config/paths.ts";
import { join } from "path";
import { debug } from "../../utils/debug.ts";
import { safeJsonParse } from "../../utils/files.ts";
import { getBundledAssetsDir } from "../../utils/paths.ts";
import { isValidPermissionsFile } from "../../config/validators.ts";
import { type PermissionsConfigFile, type BlockedCommandHintRule } from "../mode-types.ts";
import type { PermissionsCustomConfig } from './contracts.ts';
import { parsePermissionsJson } from './validation.ts';

// ============================================================
// App-level Permissions Directory
// ============================================================

// Track if permissions have been initialized this session (prevents re-init on hot reload)
let permissionsInitialized = false;

// These exact patterns shipped as application defaults, not user-authored
// workspace rules. They admitted output-file or executable options, so keeping
// them during the otherwise-additive default migration would preserve a
// privilege-boundary bypass after an upgrade.
const REVOKED_BUNDLED_BASH_PATTERNS = new Set([
  '^tree\\b',
  '^file\\b',
  '^less\\b',
  '^more\\b',
  '^bat\\b',
  '^markitdown\\b',
  '^pdf-tool\\s+(extract|info)\\b',
  '^xlsx-tool\\s+(read|info|export)\\b',
  '^doc-diff\\b',
  '^img-tool\\s+info\\b',
  '^docx-tool\\s+(info|extract)\\b',
  '^pptx-tool\\s+(info|extract)\\b',
  '^ical-tool\\s+(read|filter)\\b',
  '^rg\\b',
  '^rg\\b(?![^\\r\\n]*\\s--pre(?:=\\S*)?(?:\\s|$))',
  '^ag\\b',
  '^ack\\b',
  '^fd\\b',
  '^fzf\\b',
  '^git\\s+((-[A-Za-z]|--[a-z][-a-z]*)(\\s+[^\\s-][^\\s]*)?\\s+)*(status|log|diff|show|branch|tag|remote|stash\\s+list|describe|rev-parse|config\\s+--get|config\\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\\b',
  '^gh\\s+api\\b.*--method\\s+GET\\b',
  '^gh\\s+api\\b(?!.*--method)',
  '^npm\\s+(ls|list|view|info|show|outdated|audit|search|explain|why|config\\s+get|config\\s+list)\\b',
  '^pnpm\\s+(list|ls|why|outdated|audit)\\b',
  '^hostname\\b',
  '^date\\b',
  '^htop\\b',
  '^docker-compose\\s+(ps|logs|config|images|top|version)\\b',
  '^docker\\s+compose\\s+(ps|logs|config|images|top|version)\\b',
  '^kubectl\\s+(get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\\s+view|config\\s+get-contexts|version)\\b',
  '^kubectl\\s+(?:get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\\s+view|config\\s+get-contexts|version)\\b(?![^\\r\\n]*\\s--output-directory(?:=\\S*)?(?:\\s|$))',
  '^sed\\s+-n\\b',
  '^sed\\s+-n\\b(?![^\\r\\n]*\\s(?:-i\\S*|--in-place(?:=\\S*)?)(?:\\s|$))',
  '^sort\\b',
  '^uniq\\b',
  '^(?:gawk|mawk|nawk|awk)\\b',
  '^yq\\b',
  '^xq\\b',
  '^xmllint\\b',
  '^python\\s+-m\\s+json\\.tool\\b',
  '^ip\\s+(addr|link|route|neigh)\\s*(show)?\\b',
  '^ifconfig\\b',
  '^node\\s+(--version|-v)\\b',
  '^npm\\s+(--version|-v)\\b',
  '^yarn\\s+(--version|-v)\\b',
  '^pnpm\\s+(--version|-v)\\b',
  '^bun\\s+(--version|-v)\\b',
  '^python\\s+(--version|-V)\\b',
  '^python3\\s+(--version|-V)\\b',
  '^ruby\\s+(--version|-v)\\b',
  '^go\\s+version\\b',
  '^rustc\\s+(--version|-V)\\b',
  '^cargo\\s+(--version|-V)\\b',
  '^java\\s+(-version|--version)\\b',
  '^dotnet\\s+--version\\b',
  '^php\\s+(--version|-v)\\b',
  '^perl\\s+(--version|-v)\\b',
  '^man\\b',
  '--help\\b',
  '-h\\b$',
]);

const getBlockedCommandHintKey = (hint: Pick<BlockedCommandHintRule, 'command' | 'reason' | 'whenNotMatching'>): string =>
  `${hint.command}::${hint.whenNotMatching || ''}::${hint.reason}`;

const REVOKED_BUNDLED_BLOCKED_COMMAND_HINT_KEYS = new Set([
  getBlockedCommandHintKey({
    command: 'sed',
    reason: 'Only print-only sed is allowed in Explore mode by default.',
    whenNotMatching: '^sed\\s+-n\\b',
  }),
  ...['awk', 'gawk', 'mawk', 'nawk'].map(command => getBlockedCommandHintKey({
    command,
    reason: `${command} is blocked when the command appears to execute external commands.`,
  })),
]);

/**
 * Get the app-level permissions directory.
 * Default permissions are stored at ~/.craft-agent/permissions/
 * Reads env var dynamically so tests can override via CRAFT_CONFIG_DIR.
 */
export function getAppPermissionsDir(): string {
  const configDir = resolveConfigDir();
  return join(configDir, 'permissions');
}

/**
 * Sync bundled default permissions to disk on launch.
 * Handles migrations when bundled version is newer:
 * - If file doesn't exist → copy from bundle
 * - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
 * - If file exists and bundled is newer → merge new patterns, update version
 * - If file exists and same/older version → no-op (preserve user changes)
 *
 * User customizations in workspace/source permissions.json files
 * are never touched by this function.
 */
export function ensureDefaultPermissions(): void {
  // Skip if already initialized this session (prevents re-init on hot reload)
  if (permissionsInitialized) {
    return;
  }
  permissionsInitialized = true;

  const permissionsDir = getAppPermissionsDir();

  // Create permissions directory if it doesn't exist
  if (!existsSync(permissionsDir)) {
    mkdirSync(permissionsDir, { recursive: true });
  }

  // Resolve bundled permissions directory via shared asset resolver
  const bundledPermissionsDir = getBundledAssetsDir('permissions');
  if (!bundledPermissionsDir) {
    return;
  }

  const destPath = join(permissionsDir, 'default.json');
  const srcPath = join(bundledPermissionsDir, 'default.json');

  if (!existsSync(srcPath)) {
    return;
  }

  // New install or corrupt file - copy fresh from bundle
  if (!existsSync(destPath) || !isValidPermissionsFile(destPath)) {
    try {
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, content, 'utf-8');
      debug('[Permissions] Installed default.json');
    } catch (error) {
      debug('[Permissions] Error installing default.json:', error);
    }
    return;
  }

  // Check if migration needed (bundled version > installed version)
  try {
    const installedContent = readFileSync(destPath, 'utf-8');
    const bundledContent = readFileSync(srcPath, 'utf-8');

    const installed = safeJsonParse(installedContent) as PermissionsConfigFile;
    const bundled = safeJsonParse(bundledContent) as PermissionsConfigFile;

    const installedVersion = installed.version || '2000-01-01';
    const bundledVersion = bundled.version || '2000-01-01';

    if (bundledVersion > installedVersion) {
      const merged = migratePermissions(installed, bundled);
      writeFileSync(destPath, JSON.stringify(merged, null, 2), 'utf-8');
      debug('[Permissions] Migrated from', installedVersion, 'to', bundledVersion);
    } else {
      debug('[Permissions] Already up to date:', installedVersion);
    }
  } catch (error) {
    debug('[Permissions] Migration error:', error);
  }
}

/**
 * Merge new patterns from bundled config into existing installed config.
 * Preserves user customizations, adds new patterns, updates version.
 */
function migratePermissions(
  installed: PermissionsConfigFile,
  bundled: PermissionsConfigFile
): PermissionsConfigFile {
  // Get existing pattern strings for deduplication
  const getPatternString = (p: string | { pattern: string }): string =>
    typeof p === 'string' ? p : p.pattern;

  const retainedInstalledBashPatterns = (installed.allowedBashPatterns || [])
    .filter(pattern => !REVOKED_BUNDLED_BASH_PATTERNS.has(getPatternString(pattern)));
  const existingBashPatterns = new Set(retainedInstalledBashPatterns.map(getPatternString));
  const existingMcpPatterns = new Set(
    (installed.allowedMcpPatterns || []).map(getPatternString)
  );

  // Find new patterns not already in installed
  const newBashPatterns = (bundled.allowedBashPatterns || []).filter(
    p => !existingBashPatterns.has(getPatternString(p))
  );
  const newMcpPatterns = (bundled.allowedMcpPatterns || []).filter(
    p => !existingMcpPatterns.has(getPatternString(p))
  );

  // Merge blocked command hints (dedupe by command + whenNotMatching + reason)
  const installedHints = installed.blockedCommandHints || [];
  const retainedInstalledHints = installedHints.filter(
    hint => !REVOKED_BUNDLED_BLOCKED_COMMAND_HINT_KEYS.has(getBlockedCommandHintKey(hint))
  );
  const installedHintKeys = new Set(
    retainedInstalledHints.map(getBlockedCommandHintKey)
  );
  const newBlockedCommandHints = (bundled.blockedCommandHints || []).filter(
    h => !installedHintKeys.has(getBlockedCommandHintKey(h))
  );

  debug('[Permissions] Adding', newBashPatterns.length, 'new bash patterns');
  debug('[Permissions] Adding', newMcpPatterns.length, 'new MCP patterns');
  debug('[Permissions] Adding', newBlockedCommandHints.length, 'new blocked command hints');

  return {
    ...installed,
    version: bundled.version,
    allowedBashPatterns: [
      ...retainedInstalledBashPatterns,
      ...newBashPatterns,
    ],
    allowedMcpPatterns: [
      ...(installed.allowedMcpPatterns || []),
      ...newMcpPatterns,
    ],
    blockedCommandHints: [
      ...retainedInstalledHints,
      ...newBlockedCommandHints,
    ],
  };
}

/**
 * Load default permissions from ~/.craft-agent/permissions/default.json
 * Returns null if file doesn't exist or is invalid.
 */
export function loadDefaultPermissions(): PermissionsCustomConfig | null {
  const defaultPath = join(getAppPermissionsDir(), 'default.json');
  if (!existsSync(defaultPath)) {
    debug('[Permissions] No default.json found at', defaultPath);
    return null;
  }

  try {
    const content = readFileSync(defaultPath, 'utf-8');
    const config = parsePermissionsJson(content);
    debug('[Permissions] Loaded default permissions from', defaultPath);
    return config;
  } catch (error) {
    debug('[Permissions] Error loading default permissions:', error);
    return null;
  }
}
