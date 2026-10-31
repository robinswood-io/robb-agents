/** Existing behavior separated into direct modules by responsibility, preserving the public entry point. */
export { CONFIG_DIR } from "../config/paths.ts";
export { DEFAULT_WORKSPACES_DIR } from "./storage/paths.ts";
export { WORKSPACE_CONFIG_SCHEMA_VERSION, UnsupportedWorkspaceConfigVersionError, getDefaultWorkspacesDir, ensureDefaultWorkspacesDir, getWorkspacePath, getWorkspaceSourcesPath, getWorkspaceSessionsPath, getWorkspaceSkillsPath } from './storage/paths.ts';
export { loadWorkspaceConfig, saveWorkspaceConfig } from './storage/config.ts';
export { loadWorkspace, getWorkspaceSummary, generateSlug, generateUniqueWorkspacePath, createWorkspaceAtPath, deleteWorkspaceFolder, isValidWorkspace, renameWorkspaceFolder, discoverWorkspacesInDefaultLocation } from './storage/directories.ts';
export { getWorkspaceColorTheme, setWorkspaceColorTheme, isLocalMcpEnabled, ensurePluginManifest } from './storage/settings.ts';
