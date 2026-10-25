/**
 * Project Storage
 *
 * CRUD operations for workspace-scoped projects.
 * Projects are stored at {workspaceRootPath}/projects/{projectSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedProject.workspaceId` is derived via basename().
 */
import { existsSync, mkdirSync } from "fs";
import { join, resolve, sep } from "path";

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Get path to workspace projects directory.
 */
export function getWorkspaceProjectsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'projects');
}

/**
 * Get path to a project folder within a workspace.
 */
export function getProjectPath(workspaceRootPath: string, projectSlug: string): string {
  const projectsDir = getWorkspaceProjectsPath(workspaceRootPath);
  if (
    typeof projectSlug !== 'string'
    || projectSlug.length === 0
    || projectSlug === '.'
    || projectSlug === '..'
    || projectSlug.includes('/')
    || projectSlug.includes('\\')
    || projectSlug.includes('\0')
  ) {
    throw new Error(`Invalid project slug: ${projectSlug}`);
  }
  const baseDir = resolve(projectsDir);
  const candidate = resolve(baseDir, projectSlug);
  const prefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`Invalid project slug: ${projectSlug}`);
  }
  return join(projectsDir, projectSlug);
}

/**
 * Get path to a project's assets directory.
 */
export function getProjectAssetsPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), 'assets');
}

/** Filename of a project's agent-maintained "lessons learned" doc. */
export const MEMORY_FILENAME = 'MEMORY.md';

/**
 * Get path to a project's MEMORY.md. Deliberately a sibling of config.json
 * (outside assets/) so it never shows up in the asset manifest.
 */
export function getProjectMemoryPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), MEMORY_FILENAME);
}

/**
 * Ensure projects directory exists for a workspace.
 */
export function ensureProjectsDir(workspaceRootPath: string): void {
  const dir = getWorkspaceProjectsPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure a project's assets directory exists.
 */
export function ensureProjectAssetsDir(workspaceRootPath: string, projectSlug: string): void {
  const dir = getProjectAssetsPath(workspaceRootPath, projectSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
