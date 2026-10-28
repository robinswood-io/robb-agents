import { isUnknownArray } from '../../utils/json.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { createWorkspaceAtPath, isValidWorkspace } from "../../workspaces/storage.ts";
import { initializeDocs } from "../../docs/index.ts";
import { expandPath, toPortablePath } from "../../utils/paths.ts";
import { debug } from "../../utils/debug.ts";
import { atomicWriteFileSync, readJsonFileSync } from "../../utils/files.ts";
import { CONFIG_DIR } from "../paths.ts";
import { StoredConfigSchema } from "../validators.ts";
import { CONFIG_BACKUP_DATE_RE, MAX_CONFIG_BACKUPS, ensureConfigDefaults } from './config-defaults.ts';
import type { StoredConfig } from './config-types.ts';
import { CONFIG_FILE, STORED_CONFIG_SCHEMA_VERSION } from './config-types.ts';
import { ensureToolIcons } from './tool-icons.ts';

let configDirInitialized = false;

/**
 * Snapshot an existing config.json into a dated file (config.json.bak-YYYY-MM-DD)
 * and keep only the newest MAX_CONFIG_BACKUPS. Runs once at startup, before any
 * path can mutate or (in failure paths) overwrite the workspace registry.
 * Best-effort: failures are logged and swallowed so a backup never blocks startup.
 */
export function backupConfigFile(): void {
  try {
    if (!existsSync(CONFIG_FILE)) return;

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dated = join(CONFIG_DIR, `config.json.bak-${stamp}`);
    // One backup per day, never overwritten: the first snapshot of the day is taken
    // before any mutation, so it holds the good pre-reset state. A second startup that
    // day (e.g. after a reset already nuked the registry) must NOT clobber it.
    if (existsSync(dated)) return;
    writeFileSync(dated, readFileSync(CONFIG_FILE, 'utf-8'), 'utf-8');

    // ISO date in the name → lexical sort is chronological; drop all but the newest few.
    const backups = readdirSync(CONFIG_DIR).filter(f => CONFIG_BACKUP_DATE_RE.test(f)).sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_CONFIG_BACKUPS))) {
      try { rmSync(join(CONFIG_DIR, stale)); } catch { /* ignore individual cleanup errors */ }
    }
  } catch (error) {
    debug('[config] backupConfigFile failed:', error instanceof Error ? error.message : error);
  }
}

export function ensureConfigDir(): void {
  if (configDirInitialized) return;

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Snapshot an existing config.json (dated, keep last 3) before anything can
  // mutate or — in a failure path — overwrite the workspace registry.
  backupConfigFile();
  // Initialize bundled docs (creates ~/.craft-agent/docs/ with sources.md, agents.md, permissions.md)
  initializeDocs();

  // Initialize config defaults
  ensureConfigDefaults();

  // Initialize tool icons (CLI tool icons for turn card display)
  ensureToolIcons();

  configDirInitialized = true;
}

export function loadStoredConfig(): StoredConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    const raw = readJsonFileSync<unknown>(CONFIG_FILE);
    const migrated = migrateStoredConfig(raw);
    const parsed = StoredConfigSchema.safeParse(migrated);
    if (!parsed.success) {
      debug('[config] Stored config validation failed:', parsed.error.issues.map((issue) =>
        `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; '));
      return null;
    }
    const config = parsed.data as StoredConfig;
    if ((raw as { schemaVersion?: unknown }).schemaVersion !== STORED_CONFIG_SCHEMA_VERSION) {
      backupConfigFile();
      atomicWriteFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
    }

    // Expand path variables (~ and ${HOME}) for portability
    for (const workspace of config.workspaces) {
      workspace.rootPath = expandPath(workspace.rootPath);
    }

    // Validate active workspace exists
    const activeWorkspace = config.workspaces.find(w => w.id === config.activeWorkspaceId);
    if (!activeWorkspace) {
      // Default to first workspace
      config.activeWorkspaceId = config.workspaces[0]?.id || null;
    }

    // Ensure workspace folder structure exists for all workspaces.
    // Failures here are non-fatal — the workspace will be re-created on next access.
    for (const workspace of config.workspaces) {
      if (!isValidWorkspace(workspace.rootPath)) {
        try {
          createWorkspaceAtPath(workspace.rootPath, workspace.name);
        } catch (wsError) {
          debug('[config] Failed to create workspace at', workspace.rootPath, ':', wsError instanceof Error ? wsError.message : wsError);
        }
      }
    }

    return config;
  } catch (error) {
    debug('[config] loadStoredConfig failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

// Legacy credential helpers removed - use connection-aware credential lookup instead:
// - getAnthropicApiKey() → credentialManager.getLlmApiKey(connectionSlug)
// - getClaudeOAuthToken() → credentialManager.getLlmOAuth(connectionSlug)

export function saveConfig(config: StoredConfig): void {
  // A null result from loadStoredConfig() is deliberately ambiguous: it can
  // mean first run, but it can also mean that an existing file was produced by
  // a newer app version or is otherwise invalid. Never let a first-run fallback
  // silently replace such a file. Explicit recovery remains possible through
  // clearAllConfig(), which removes the incompatible file before saving again.
  if (existsSync(CONFIG_FILE)) {
    try {
      StoredConfigSchema.parse(migrateStoredConfig(readJsonFileSync<unknown>(CONFIG_FILE)));
    } catch (error) {
      throw new Error('Refusing to overwrite an existing incompatible stored config', { cause: error });
    }
  }
  ensureConfigDir();

  // Convert paths to portable form (~ prefix) for cross-machine compatibility
  const storageConfig: StoredConfig = {
    ...config,
    schemaVersion: STORED_CONFIG_SCHEMA_VERSION,
    workspaces: config.workspaces.map(ws => ({
      ...ws,
      rootPath: toPortablePath(ws.rootPath),
    })),
  };

  const parsed = StoredConfigSchema.parse(storageConfig);
  atomicWriteFileSync(CONFIG_FILE, `${JSON.stringify(parsed, null, 2)}\n`);
}

function migrateStoredConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isUnknownArray(value)) {
    throw new Error('Stored config root must be an object');
  }
  const config = { ...(value as Record<string, unknown>) };
  const version = config["schemaVersion"];
  if (version !== undefined && version !== STORED_CONFIG_SCHEMA_VERSION) {
    throw new Error(`Unsupported stored config schemaVersion: ${String(version)}`);
  }
  if (!isUnknownArray(config["workspaces"])) throw new Error('Stored config workspaces must be an array');
  config["schemaVersion"] = STORED_CONFIG_SCHEMA_VERSION;
  if (!('activeWorkspaceId' in config)) config["activeWorkspaceId"] = null;
  if (!('activeSessionId' in config)) config["activeSessionId"] = null;
  return config;
}
