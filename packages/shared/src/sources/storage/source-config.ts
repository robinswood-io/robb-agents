/**
 * Source Storage
 *
 * CRUD operations for workspace-scoped sources.
 * Sources are stored at {workspaceRootPath}/sources/{sourceSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedSource.workspaceId` is derived via basename().
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, basename, resolve, sep } from "path";
import type { FolderSourceConfig, LoadedSource } from "../types.ts";
import { validateSourceConfig } from "../../config/validators.ts";
import { debug } from "../../utils/debug.ts";
import { readJsonFileSync } from "../../utils/files.ts";
import { expandPath, toPortablePath } from "../../utils/paths.ts";
import { getWorkspaceSourcesPath } from "../../workspaces/storage.ts";
// Circular import (credential-manager imports from this file) is safe here:
// getSourceCredentialManager is only referenced lazily inside saveSourceConfig,
// not at module-eval time.
import { getSourceCredentialManager } from "../credential-manager.ts";
import { assertMcpTransportWriteAllowed } from "../mcp-transport-policy.ts";

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Get path to a source folder within a workspace
 */
export function getSourcePath(workspaceRootPath: string, sourceSlug: string): string {
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath);
  if (
    typeof sourceSlug !== 'string'
    || sourceSlug.length === 0
    || sourceSlug === '.'
    || sourceSlug === '..'
    || sourceSlug.includes('/')
    || sourceSlug.includes('\\')
    || sourceSlug.includes('\0')
  ) {
    throw new Error(`Invalid source slug: ${sourceSlug}`);
  }
  const baseDir = resolve(sourcesDir);
  const candidate = resolve(baseDir, sourceSlug);
  const prefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`Invalid source slug: ${sourceSlug}`);
  }
  return join(sourcesDir, sourceSlug);
}

/**
 * Ensure sources directory exists for a workspace
 */
export function ensureSourcesDir(workspaceRootPath: string): void {
  const dir = getWorkspaceSourcesPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load source config.json
 */
export function loadSourceConfig(
  workspaceRootPath: string,
  sourceSlug: string
): FolderSourceConfig | null {
  const configPath = join(getSourcePath(workspaceRootPath, sourceSlug), 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const config = readJsonFileSync<FolderSourceConfig>(configPath);

    // Expand path variables in local source paths for portability.
    // This is safe to do at load time because local paths are only used
    // for working directory resolution, not persisted back by source_test.
    // MCP field expansion happens at build time in server-builder.ts to avoid
    // persisting expanded values back to config.json.
    if (config.type === 'local' && config.local?.path) {
      config.local.path = expandPath(config.local.path);
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Mark a source as authenticated and connected.
 * Updates isAuthenticated, connectionStatus, and clears any connection error.
 *
 * @returns true if the source was found and updated, false otherwise
 */
export function markSourceAuthenticated(
  workspaceRootPath: string,
  sourceSlug: string
): boolean {
  const config = loadSourceConfig(workspaceRootPath, sourceSlug);
  if (!config) {
    debug(`[markSourceAuthenticated] Source ${sourceSlug} not found`);
    return false;
  }

  config.isAuthenticated = true;
  config.connectionStatus = 'connected';
  delete config.connectionError

  saveSourceConfig(workspaceRootPath, config);
  debug(`[markSourceAuthenticated] Marked ${sourceSlug} as authenticated`);
  return true;
}

/**
 * Save source config.json
 * @throws Error if config is invalid
 */
export function saveSourceConfig(
  workspaceRootPath: string,
  config: FolderSourceConfig
): void {
  const dir = getSourcePath(workspaceRootPath, config.slug);
  const configPath = join(dir, 'config.json');
  let previous: FolderSourceConfig | null = null;
  if (existsSync(configPath)) {
    try {
      previous = readJsonFileSync<FolderSourceConfig>(configPath);
    } catch {
      // Validation below remains authoritative for the replacement config.
    }
  }
  assertMcpTransportWriteAllowed(config, previous);

  // Validate config before writing
  const validation = validateSourceConfig(config);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    debug('[saveSourceConfig] Validation failed:', errorMessages);
    throw new Error(`Invalid source config: ${errorMessages}`);
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Convert local source paths to portable form
  const storageConfig: FolderSourceConfig = { ...config, updatedAt: Date.now() };
  if (storageConfig.type === 'local' && storageConfig.local?.path) {
    storageConfig.local = {
      ...storageConfig.local,
      path: toPortablePath(storageConfig.local.path),
    };
  }

  writeFileSync(configPath, JSON.stringify(storageConfig, null, 2));

  // Orphan-credential cleanup: when an API source is set to authType:'none',
  // any credential previously stored for this slug (e.g. from authType:'header')
  // becomes addressable garbage. getCredentialId() maps 'none', 'header', and
  // 'query' to the same source_apikey slot, so a stored value can silently
  // override defaultHeaders on a future config change. Delete it here.
  if (storageConfig.type === 'api' && storageConfig.api?.authType === 'none') {
    deleteApiKeyCredentialBestEffort(workspaceRootPath, storageConfig);
  }
}

/**
 * Best-effort delete of the source_apikey credential slot for an API source.
 * Never throws — credential cleanup must not block config saves.
 */
function deleteApiKeyCredentialBestEffort(
  workspaceRootPath: string,
  config: FolderSourceConfig
): void {
  try {
    const cm = getSourceCredentialManager();
    // Minimal LoadedSource shape: getCredentialId() only reads config + workspaceId.
    const source: LoadedSource = {
      config,
      guide: null,
      folderPath: getSourcePath(workspaceRootPath, config.slug),
      workspaceRootPath,
      workspaceId: basename(workspaceRootPath),
    };
    cm.deleteSync(source);
  } catch (err) {
    debug('[saveSourceConfig] orphan credential cleanup threw:', err);
  }
}
