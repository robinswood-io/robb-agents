/**
 * Source Storage
 *
 * CRUD operations for workspace-scoped sources.
 * Sources are stored at {workspaceRootPath}/sources/{sourceSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedSource.workspaceId` is derived via basename().
 */
import { existsSync, readdirSync } from "fs";
import { basename } from "path";
import type { LoadedSource } from "../types.ts";
import { getBuiltinSources, isBuiltinSource, getDocsSource } from "../builtin-sources.ts";
import { getWorkspaceSourcesPath } from "../../workspaces/storage.ts";
import { findIconFile } from "../../utils/icon.ts";
import { ensureSourcesDir, getSourcePath, loadSourceConfig } from './source-config.ts';
import { loadSourceGuide } from './source-guides.ts';

// ============================================================
// Load Operations
// ============================================================

/**
 * Load complete source with all files
 * @param workspaceRootPath - Absolute path to workspace folder (e.g., ~/.craft-agent/workspaces/xxx)
 * @param sourceSlug - Source folder name
 */
export function loadSource(workspaceRootPath: string, sourceSlug: string): LoadedSource | null {
  const folderPath = getSourcePath(workspaceRootPath, sourceSlug);
  const config = loadSourceConfig(workspaceRootPath, sourceSlug);
  if (!config) return null;

  // Extract workspace folder name for credential lookup
  // Credentials are keyed by folder name (e.g., "046a02d0-..."), not full path
  const workspaceId = basename(workspaceRootPath);

  // Pre-compute icon path for renderer (avoids fs access in browser)
  const iconPath = findIconFile(folderPath);

  return {
    config,
    guide: loadSourceGuide(workspaceRootPath, sourceSlug),
    folderPath,
    workspaceRootPath,
    workspaceId,
    iconPath,
  };
}

/**
 * Load all sources for a workspace
 */
export function loadWorkspaceSources(workspaceRootPath: string): LoadedSource[] {
  ensureSourcesDir(workspaceRootPath);

  const sources: LoadedSource[] = [];
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath);

  if (!existsSync(sourcesDir)) return sources;

  const entries = readdirSync(sourcesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const source = loadSource(workspaceRootPath, entry.name);
      if (source) {
        sources.push(source);
      }
    }
  }

  return sources;
}

/**
 * Get enabled sources for a workspace
 */
export function getEnabledSources(workspaceRootPath: string): LoadedSource[] {
  return loadWorkspaceSources(workspaceRootPath).filter((s) => s.config.enabled);
}

/**
 * Check if a source is ready for use (enabled and authenticated).
 * Sources with authType: 'none' or undefined are considered authenticated.
 *
 * Use this instead of inline `s.config.enabled && s.config.isAuthenticated` checks
 * to ensure consistent handling of no-auth sources.
 */
export function isSourceUsable(source: LoadedSource): boolean {
  if (!source.config.enabled) return false;

  // Get auth type from MCP or API config
  const authType = source.config.mcp?.authType || source.config.api?.authType;

  // Sources with no auth requirement are always usable when enabled
  if (authType === 'none' || authType === undefined) return true;

  // Sources requiring auth must be authenticated
  return source.config.isAuthenticated === true;
}

/**
 * Get sources by slugs for a workspace.
 * Includes both user-configured sources from disk and builtin sources
 * (like craft-agents-docs) that don't have filesystem folders.
 */
export function getSourcesBySlugs(workspaceRootPath: string, slugs: string[]): LoadedSource[] {
  const workspaceId = basename(workspaceRootPath);
  const sources: LoadedSource[] = [];
  for (const slug of slugs) {
    // Check builtin sources first (they don't exist on disk)
    if (isBuiltinSource(slug)) {
      // Currently only craft-agents-docs is a builtin source
      if (slug === 'craft-agents-docs') {
        sources.push(getDocsSource(workspaceId, workspaceRootPath));
      }
      continue;
    }
    // Load user-configured source from disk
    const source = loadSource(workspaceRootPath, slug);
    if (source) {
      sources.push(source);
    }
  }
  return sources;
}

/**
 * Load all sources for a workspace INCLUDING built-in sources.
 * Built-in sources (like craft-agents-docs) are always available and merged
 * with user-configured sources from the workspace.
 *
 * Use this when the agent needs visibility into all available sources,
 * including system-provided ones that don't live on disk.
 */
export function loadAllSources(workspaceRootPath: string): LoadedSource[] {
  const workspaceId = basename(workspaceRootPath);
  const userSources = loadWorkspaceSources(workspaceRootPath);
  const builtinSources = getBuiltinSources(workspaceId, workspaceRootPath);
  return [...userSources, ...builtinSources];
}
