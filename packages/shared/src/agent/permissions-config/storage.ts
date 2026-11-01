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
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { debug } from "../../utils/debug.ts";
import { safeJsonParse } from "../../utils/files.ts";
import { getSourcePath } from "../../sources/storage.ts";
import { PermissionsConfigSchema, type PermissionsConfigFile } from "../mode-types.ts";
import type { PermissionsCustomConfig } from './contracts.ts';
import { parsePermissionsJson } from './validation.ts';

// ============================================================
// Storage Functions
// ============================================================

/**
 * Get path to workspace permissions.json
 */
export function getWorkspacePermissionsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'permissions.json');
}

/**
 * Get path to source permissions.json
 */
export function getSourcePermissionsPath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), 'permissions.json');
}

/**
 * Load workspace-level permissions config
 */
export function loadWorkspacePermissionsConfig(workspaceRootPath: string): PermissionsCustomConfig | null {
  const path = getWorkspacePermissionsPath(workspaceRootPath);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    const config = parsePermissionsJson(content);
    debug(`[Permissions] Loaded workspace config from ${path}:`, config);
    return config;
  } catch (error) {
    debug(`[Permissions] Error loading workspace config:`, error);
    return null;
  }
}

/**
 * Load source-level permissions config
 */
export function loadSourcePermissionsConfig(
  workspaceRootPath: string,
  sourceSlug: string
): PermissionsCustomConfig | null {
  const path = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    const config = parsePermissionsJson(content);
    debug(`[Permissions] Loaded source config from ${path}:`, config);
    return config;
  } catch (error) {
    debug(`[Permissions] Error loading source config:`, error);
    return null;
  }
}

// ============================================================
// Raw Load / Save (for CLI CRUD — preserves schema-level structure)
// ============================================================

/**
 * Load raw PermissionsConfigFile from a workspace permissions.json.
 * Returns the Zod-parsed schema object (not the normalized runtime config).
 * Returns null if the file doesn't exist.
 */
export function loadRawWorkspacePermissions(workspaceRootPath: string): PermissionsConfigFile | null {
  const filePath = getWorkspacePermissionsPath(workspaceRootPath);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const json = safeJsonParse(content);
  const result = PermissionsConfigSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Load raw PermissionsConfigFile from a source permissions.json.
 * Returns null if the file doesn't exist.
 */
export function loadRawSourcePermissions(workspaceRootPath: string, sourceSlug: string): PermissionsConfigFile | null {
  const filePath = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const json = safeJsonParse(content);
  const result = PermissionsConfigSchema.safeParse(json);
  return result.success ? result.data : null;
}
