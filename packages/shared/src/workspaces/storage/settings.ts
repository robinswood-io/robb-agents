/**
 * Workspace Storage
 *
 * CRUD operations for workspaces.
 * Workspaces can be stored anywhere on disk via rootPath.
 * Default location: ~/.craft-agent/workspaces/
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadWorkspaceConfig, saveWorkspaceConfig } from './config.ts';

// ============================================================
// Workspace Color Theme
// ============================================================

/**
 * Get the color theme setting for a workspace.
 * Returns undefined if workspace uses the app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns Theme ID or undefined (inherit from app default)
 */
export function getWorkspaceColorTheme(rootPath: string): string | undefined {
  const config = loadWorkspaceConfig(rootPath);
  return config?.defaults?.colorTheme;
}

/**
 * Set the color theme for a workspace.
 * Pass undefined to clear and use app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param themeId - Preset theme ID or undefined to inherit
 */
export function setWorkspaceColorTheme(rootPath: string, themeId: string | undefined): void {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return;

  // Validate theme ID if provided (skip for undefined = inherit default)
  // Only allow alphanumeric characters, hyphens, and underscores (max 64 chars)
  if (themeId && themeId !== 'default') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(themeId)) {
      console.warn(`[workspace-storage] Invalid theme ID rejected: ${themeId}`);
      return;
    }
  }

  // Initialize defaults if not present
  if (!config.defaults) {
    config.defaults = {};
  }

  if (themeId) {
    config.defaults.colorTheme = themeId;
  } else {
    delete config.defaults.colorTheme;
  }

  saveWorkspaceConfig(rootPath, config);
}

// ============================================================
// Local MCP Configuration
// ============================================================

/**
 * Check if local (stdio) MCP servers are enabled for a workspace.
 * Resolution order: ENV (CRAFT_LOCAL_MCP_ENABLED) > workspace config > default (true)
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns true if local MCP servers should be enabled
 */
export function isLocalMcpEnabled(rootPath: string): boolean {
  // 1. Environment variable override (highest priority)
  const envValue = process.env["CRAFT_LOCAL_MCP_ENABLED"];
  if (envValue !== undefined) {
    return envValue.toLowerCase() === 'true';
  }

  // 2. Workspace config
  const config = loadWorkspaceConfig(rootPath);
  if (config?.localMcpServers?.enabled !== undefined) {
    return config.localMcpServers.enabled;
  }

  // 3. Default: enabled
  return true;
}

// ============================================================
// Exports
// ============================================================

// ============================================================
// Plugin Manifest (for SDK plugin integration)
// ============================================================

/**
 * Ensure workspace has a .claude-plugin/plugin.json manifest.
 * This allows the workspace to be loaded as an SDK plugin,
 * enabling skills, commands, and agents from the workspace.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param workspaceName - Display name for the workspace (used in plugin name)
 */
export function ensurePluginManifest(rootPath: string, workspaceName: string): void {
  const pluginDir = join(rootPath, '.claude-plugin');
  const manifestPath = join(pluginDir, 'plugin.json');

  if (existsSync(manifestPath)) return;

  // Create .claude-plugin directory
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  // Create minimal plugin manifest
  const manifest = {
    name: `craft-workspace-${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    version: '1.0.0',
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
