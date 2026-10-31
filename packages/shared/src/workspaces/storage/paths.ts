/**
 * Workspace Storage
 *
 * CRUD operations for workspaces.
 * Workspaces can be stored anywhere on disk via rootPath.
 * Default location: ~/.craft-agent/workspaces/
 */
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { CONFIG_DIR } from "../../config/paths.ts";

export const DEFAULT_WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');

export const WORKSPACE_CONFIG_SCHEMA_VERSION = 1 as const;

export const LEGACY_NULLABLE_WORKSPACE_DEFAULT_KEYS = [
  'model',
  'defaultLlmConnection',
  'enabledSourceSlugs',
  'permissionMode',
  'externalActionPolicy',
  'cyclablePermissionModes',
  'workingDirectory',
  'thinkingLevel',
  'colorTheme',
] as const;

export const WorkspaceConfigStorageSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_CONFIG_SCHEMA_VERSION),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  defaults: z.object({
    model: z.string().optional(),
    defaultLlmConnection: z.string().optional(),
    enabledSourceSlugs: z.array(z.string()).optional(),
    permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional(),
    externalActionPolicy: z.enum(['confirm', 'allow-in-execute']).optional(),
    cyclablePermissionModes: z.array(z.enum(['safe', 'ask', 'allow-all'])).optional(),
    workingDirectory: z.string().optional(),
    thinkingLevel: z.string().optional(),
    colorTheme: z.string().optional(),
  }).passthrough().optional(),
  localMcpServers: z.object({ enabled: z.boolean() }).strict().optional(),

  automaticToolFallbackEnabled: z.boolean().optional(),
  costControl: z.unknown().optional(),
  governance: z.unknown().optional(),
  remoteSupervision: z.unknown().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).passthrough();

export class UnsupportedWorkspaceConfigVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported workspace config schema version: ${String(version)}`);
    this.name = 'UnsupportedWorkspaceConfigVersionError';
  }
}

// ============================================================
// Path Utilities
// ============================================================

/**
 * Get the default workspaces directory (~/.craft-agent/workspaces/)
 */
export function getDefaultWorkspacesDir(): string {
  return DEFAULT_WORKSPACES_DIR;
}

/**
 * Ensure default workspaces directory exists
 */
export function ensureDefaultWorkspacesDir(): void {
  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    mkdirSync(DEFAULT_WORKSPACES_DIR, { recursive: true });
  }
}

/**
 * Get workspace root path from ID
 * @param workspaceId - Workspace ID
 * @returns Absolute path to workspace root in default location
 */
export function getWorkspacePath(workspaceId: string): string {
  return join(DEFAULT_WORKSPACES_DIR, workspaceId);
}

/**
 * Get path to workspace sources directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSourcesPath(rootPath: string): string {
  return join(rootPath, 'sources');
}

/**
 * Get path to workspace sessions directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSessionsPath(rootPath: string): string {
  return join(rootPath, 'sessions');
}

/**
 * Get path to workspace skills directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSkillsPath(rootPath: string): string {
  return join(rootPath, 'skills');
}
