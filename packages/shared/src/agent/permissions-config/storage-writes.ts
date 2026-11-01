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
import { mkdirSync, writeFileSync } from "fs";
import { getSourcePath } from "../../sources/storage.ts";
import { type PermissionsConfigFile } from "../mode-types.ts";
import { permissionsConfigCache } from './cache.ts';
import { getSourcePermissionsPath, getWorkspacePermissionsPath } from './storage.ts';

/**
 * Save a PermissionsConfigFile to the workspace permissions.json.
 */
export function saveWorkspacePermissions(workspaceRootPath: string, config: PermissionsConfigFile): void {
  const filePath = getWorkspacePermissionsPath(workspaceRootPath);
  mkdirSync(workspaceRootPath, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
}

/**
 * Save a PermissionsConfigFile to a source permissions.json.
 */
export function saveSourcePermissions(workspaceRootPath: string, sourceSlug: string, config: PermissionsConfigFile): void {
  const filePath = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  const sourceDir = getSourcePath(workspaceRootPath, sourceSlug);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  permissionsConfigCache.invalidateSource(workspaceRootPath, sourceSlug);
}
