/**
 * Project Storage
 *
 * CRUD operations for workspace-scoped projects.
 * Projects are stored at {workspaceRootPath}/projects/{projectSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedProject.workspaceId` is derived via basename().
 */
import { existsSync, readdirSync } from "fs";
import { basename } from "path";
import type { LoadedProject } from "../types.ts";
import { ensureProjectsDir, getProjectAssetsPath, getProjectPath, getWorkspaceProjectsPath } from './paths.ts';
import { loadProjectConfig } from './project-config.ts';

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single project by slug.
 */
export function loadProject(
  workspaceRootPath: string,
  projectSlug: string,
): LoadedProject | null {
  const config = loadProjectConfig(workspaceRootPath, projectSlug);
  if (!config) return null;

  const folderPath = getProjectPath(workspaceRootPath, projectSlug);
  const assetsPath = getProjectAssetsPath(workspaceRootPath, projectSlug);
  const workspaceId = basename(workspaceRootPath);

  return {
    config,
    folderPath,
    assetsPath,
    workspaceRootPath,
    workspaceId,
  };
}

/**
 * Load a project by id (scans workspace projects for a matching id).
 * Slugs are unique within a workspace, but callers may persist the project id
 * on a session (more stable across renames).
 */
export function loadProjectById(
  workspaceRootPath: string,
  projectId: string,
): LoadedProject | null {
  const projects = loadWorkspaceProjects(workspaceRootPath);
  return projects.find((p) => p.config.id === projectId) ?? null;
}

/**
 * Load all projects for a workspace.
 */
export function loadWorkspaceProjects(workspaceRootPath: string): LoadedProject[] {
  ensureProjectsDir(workspaceRootPath);

  const projects: LoadedProject[] = [];
  const projectsDir = getWorkspaceProjectsPath(workspaceRootPath);

  if (!existsSync(projectsDir)) return projects;

  const entries = readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = loadProject(workspaceRootPath, entry.name);
    if (project) projects.push(project);
  }

  return projects;
}
