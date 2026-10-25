/**
 * Project Storage
 *
 * CRUD operations for workspace-scoped projects.
 * Projects are stored at {workspaceRootPath}/projects/{projectSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedProject.workspaceId` is derived via basename().
 */
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { ProjectConfig, CreateProjectInput } from "../types.ts";
import { ensureProjectAssetsDir, getProjectPath, getWorkspaceProjectsPath } from './paths.ts';
import { loadProjectConfig, saveProjectConfig } from './project-config.ts';

// ============================================================
// Create / Update / Delete
// ============================================================

/**
 * Generate a URL-safe, workspace-unique project slug.
 */
export function generateProjectSlug(workspaceRootPath: string, name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  if (!slug) slug = 'project';

  const projectsDir = getWorkspaceProjectsPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingSlugs.add(entry.name);
    }
  }

  if (!existingSlugs.has(slug)) return slug;

  let counter = 2;
  while (existingSlugs.has(`${slug}-${counter}`)) counter++;
  return `${slug}-${counter}`;
}

/**
 * Create a new project in a workspace.
 */
export function createProject(
  workspaceRootPath: string,
  input: CreateProjectInput,
): ProjectConfig {
  const slug = generateProjectSlug(workspaceRootPath, input.name);
  const now = Date.now();

  const config: ProjectConfig = {
    id: `proj_${randomUUID().slice(0, 8)}`,
    slug,
    name: input.name,
    description: input.description,
    workingDirectory: input.workingDirectory,
    details: input.details,
    colorTheme: input.colorTheme,
    createdAt: now,
    updatedAt: now,
  };

  saveProjectConfig(workspaceRootPath, config);
  ensureProjectAssetsDir(workspaceRootPath, slug);

  return config;
}

/**
 * Update a project's config with a partial patch.
 * `id` and `slug` cannot be changed.
 */
export function updateProject(
  workspaceRootPath: string,
  projectSlug: string,
  patch: Partial<Omit<ProjectConfig, 'id' | 'slug' | 'createdAt'>>,
): ProjectConfig {
  const existing = loadProjectConfig(workspaceRootPath, projectSlug);
  if (!existing) {
    throw new Error(`Project not found: ${projectSlug}`);
  }

  const updated: ProjectConfig = {
    ...existing,
    ...patch,
    id: existing.id,
    slug: existing.slug,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  saveProjectConfig(workspaceRootPath, updated);
  return updated;
}

/**
 * Delete a project (removes folder and all assets).
 * Caller is responsible for unsetting `projectId` on sessions that referenced it.
 */
export function deleteProject(workspaceRootPath: string, projectSlug: string): void {
  const dir = getProjectPath(workspaceRootPath, projectSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

/**
 * Check if a project exists in a workspace.
 */
export function projectExists(workspaceRootPath: string, projectSlug: string): boolean {
  return existsSync(join(getProjectPath(workspaceRootPath, projectSlug), 'config.json'));
}
