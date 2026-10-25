/**
 * Workspace Storage
 *
 * CRUD operations for workspaces.
 * Workspaces can be stored anywhere on disk via rootPath.
 * Default location: ~/.craft-agent/workspaces/
 */
import { existsSync, copyFileSync, constants, mkdirSync } from "fs";
import { join } from "path";
import { expandPath, toPortablePath } from "../../utils/paths.ts";
import { atomicWriteFileSync, readJsonFileSync } from "../../utils/files.ts";
import { parsePermissionMode, PERMISSION_MODE_ORDER } from "../../agent/mode-types.ts";
import { normalizeThinkingLevel } from "../../agent/thinking-levels.ts";
import type { WorkspaceConfig } from "../types.ts";
import { LEGACY_NULLABLE_WORKSPACE_DEFAULT_KEYS, UnsupportedWorkspaceConfigVersionError, WORKSPACE_CONFIG_SCHEMA_VERSION, WorkspaceConfigStorageSchema } from './paths.ts';

// ============================================================
// Config Operations
// ============================================================

/**
 * Load workspace config.json from a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  const configPath = join(rootPath, 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const raw = readJsonFileSync<unknown>(configPath);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== undefined && record.schemaVersion !== WORKSPACE_CONFIG_SCHEMA_VERSION) {
      throw new UnsupportedWorkspaceConfigVersionError(record.schemaVersion);
    }
    const migrated = record.schemaVersion === undefined;
    let normalizedDefaults: unknown = record.defaults;
    if (record.defaults && typeof record.defaults === 'object' && !Array.isArray(record.defaults)) {
      const defaultsRecord: Record<string, unknown> = {
        ...(record.defaults as Record<string, unknown>),
      };
      // Pre-schema configs used JSON null for optional settings. Preserve the
      // strict v1 write contract while accepting and removing those legacy
      // sentinels during the one-time read migration.
      for (const key of LEGACY_NULLABLE_WORKSPACE_DEFAULT_KEYS) {
        if (defaultsRecord[key] === null) delete defaultsRecord[key];
      }
      normalizedDefaults = defaultsRecord;
    }

    const config = {
      ...record,
      defaults: normalizedDefaults,
      schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
    } as WorkspaceConfig;

    // Expand path variables in defaults for portability
    if (config.defaults?.workingDirectory) {
      config.defaults.workingDirectory = expandPath(config.defaults.workingDirectory);
    }

    // Compatibility: accept canonical or legacy permission mode names on read
    if (config.defaults?.permissionMode && typeof config.defaults.permissionMode === 'string') {
      const parsed = parsePermissionMode(config.defaults.permissionMode);
      config.defaults.permissionMode = parsed ?? undefined;
    }

    if (config.defaults) {
      config.defaults.externalActionPolicy = config.defaults.externalActionPolicy === 'allow-in-execute'
        ? 'allow-in-execute'
        : 'confirm';
    }

    if (Array.isArray(config.defaults?.cyclablePermissionModes)) {
      const normalized = config.defaults.cyclablePermissionModes
        .map(mode => (typeof mode === 'string' ? parsePermissionMode(mode) : null))
        .filter((mode): mode is NonNullable<typeof mode> => !!mode)
        .filter((mode, index, arr) => arr.indexOf(mode) === index);

      config.defaults.cyclablePermissionModes = normalized.length >= 2
        ? normalized
        : [...PERMISSION_MODE_ORDER];
    }

    if (config.defaults && 'thinkingLevel' in config.defaults) {
      // TODO: Remove legacy 'think' normalization after old persisted workspace configs
      // have realistically aged out across upgrades.
      config.defaults.thinkingLevel = normalizeThinkingLevel(config.defaults.thinkingLevel);
    }

    const parsed = WorkspaceConfigStorageSchema.parse(config) as WorkspaceConfig;
    if (migrated) {
      const backupPath = join(rootPath, 'config.pre-schema-v1.json.bak');
      try { copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      const migrationStorage = parsed.defaults?.workingDirectory
        ? {
            ...parsed,
            defaults: {
              ...parsed.defaults,
              workingDirectory: toPortablePath(parsed.defaults.workingDirectory),
            },
          }
        : parsed;
      atomicWriteFileSync(configPath, `${JSON.stringify(migrationStorage, null, 2)}\n`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof UnsupportedWorkspaceConfigVersionError) throw error;
    return null;
  }
}

/**
 * Save workspace config.json to a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function saveWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  const configPath = join(rootPath, 'config.json');
  if (existsSync(configPath)) {
    // A failed load is ambiguous: the file may be malformed or may belong to a
    // newer application version. Never turn an ordinary settings update into
    // destructive recovery. Explicit recovery must move/remove the file first.
    const existing = loadWorkspaceConfig(rootPath);
    if (!existing) {
      throw new Error('Refusing to overwrite an existing incompatible workspace config');
    }
  }

  if (!existsSync(rootPath)) {
    mkdirSync(rootPath, { recursive: true });
  }

  // Convert paths to portable form for cross-machine compatibility
  const storageConfig: WorkspaceConfig = {
    ...config,
    schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
    updatedAt: Date.now(),
  };

  if (storageConfig.defaults?.workingDirectory) {
    storageConfig.defaults = {
      ...storageConfig.defaults,
      workingDirectory: toPortablePath(storageConfig.defaults.workingDirectory),
    };
  }

  // Use atomic write to prevent corruption on crash/interrupt
  const parsed = WorkspaceConfigStorageSchema.parse(storageConfig);
  atomicWriteFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}
