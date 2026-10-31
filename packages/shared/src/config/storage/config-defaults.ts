import { isUnknownArray } from '../../utils/json.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getBundledAssetsDir } from "../../utils/paths.ts";
import { debug } from "../../utils/debug.ts";
import { readJsonFileSync } from "../../utils/files.ts";
import { CONFIG_DIR } from "../paths.ts";
import type { PermissionMode } from "../../agent/mode-manager.ts";
import { parsePermissionMode, PERMISSION_MODE_ORDER } from "../../agent/mode-types.ts";
import { type ConfigDefaults } from "../config-defaults-schema.ts";
import { CONFIG_DEFAULTS_FILE, FALLBACK_CONFIG_DEFAULTS } from './config-types.ts';

// Track if config-defaults have been synced this session (prevents re-sync on hot reload)
let configDefaultsSynced = false;

function syncConfigDefaults(): void {
  if (configDefaultsSynced) return;
  configDefaultsSynced = true;

  // Get bundled config-defaults.json from resources folder
  const bundledDir = getBundledAssetsDir('.');
  if (!bundledDir) {
    debug('[config] No bundled assets dir found - using fallback config-defaults');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  const bundledFile = join(bundledDir, 'config-defaults.json');
  if (!existsSync(bundledFile)) {
    debug('[config] Bundled config-defaults.json not found at: ' + bundledFile + ' - using fallback');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  // Sync from bundled file (same pattern as docs)
  const content = readFileSync(bundledFile, 'utf-8');
  writeFileSync(CONFIG_DEFAULTS_FILE, content, 'utf-8');
  debug('[config] Synced config-defaults.json from bundled assets');
}

/**
 * Load config defaults from CONFIG_DIR/config-defaults.json.
 * This file is synced from bundled assets on launch; if a test or early runtime
 * path reads it before ensureConfigDir(), create the Robb fallback defaults so
 * fresh ~/.robb-agents directories do not fail first-use reads.
 */
export function loadConfigDefaults(): ConfigDefaults {
  if (!existsSync(CONFIG_DEFAULTS_FILE)) {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
  }

  const defaults = readJsonFileSync<ConfigDefaults>(CONFIG_DEFAULTS_FILE);

  const parsedPermissionMode =
    typeof defaults.workspaceDefaults?.permissionMode === 'string'
      ? parsePermissionMode(defaults.workspaceDefaults.permissionMode)
      : null;
  defaults.workspaceDefaults.permissionMode = parsedPermissionMode ?? 'ask';
  defaults.workspaceDefaults.externalActionPolicy =
    defaults.workspaceDefaults.externalActionPolicy === 'allow-in-execute'
      ? 'allow-in-execute'
      : 'confirm';

  const rawCyclable = isUnknownArray(defaults.workspaceDefaults?.cyclablePermissionModes)
    ? defaults.workspaceDefaults.cyclablePermissionModes
    : [];

  const normalizedCyclable: PermissionMode[] = [];
  for (const mode of rawCyclable) {
    if (typeof mode !== 'string') continue;
    const parsed = parsePermissionMode(mode);
    if (!parsed) continue;
    if (!normalizedCyclable.includes(parsed)) {
      normalizedCyclable.push(parsed);
    }
  }

  defaults.workspaceDefaults.cyclablePermissionModes =
    normalizedCyclable.length >= 2 ? normalizedCyclable : [...PERMISSION_MODE_ORDER];

  return defaults;
}

/**
 * Ensure config-defaults.json exists and is up-to-date.
 * Syncs from bundled assets on every launch (like docs, themes, permissions).
 */
export function ensureConfigDefaults(): void {
  syncConfigDefaults();
}

export const MAX_CONFIG_BACKUPS = 3;

export const CONFIG_BACKUP_DATE_RE = /^config\.json\.bak-\d{4}-\d{2}-\d{2}$/;
