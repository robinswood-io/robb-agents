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
import { join } from "path";
import { atomicWriteFileSync, readJsonFileSync } from "../../utils/files.ts";
import { debug } from "../../utils/debug.ts";
import { expandPath, toPortablePath } from "../../utils/paths.ts";
import type { ProjectConfig } from "../types.ts";
import { getProjectPath } from './paths.ts';

// ============================================================
// Config Operations
// ============================================================

/**
 * Load project config.json.
 * Returns null if the config does not exist or fails to parse.
 */
export function loadProjectConfig(
  workspaceRootPath: string,
  projectSlug: string,
): ProjectConfig | null {
  const configPath = join(getProjectPath(workspaceRootPath, projectSlug), 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const config = readJsonFileSync<ProjectConfig>(configPath);

    // Expand portable paths on read so consumers always see absolute paths.
    if (config.workingDirectory) {
      config.workingDirectory = expandPath(config.workingDirectory);
    }

    return config;
  } catch (error) {
    debug('[loadProjectConfig] Failed to read project config:', projectSlug, error);
    return null;
  }
}

/**
 * Save project config.json (atomic write, bumps updatedAt).
 */
export function saveProjectConfig(workspaceRootPath: string, config: ProjectConfig): void {
  const dir = getProjectPath(workspaceRootPath, config.slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const storageConfig: ProjectConfig = {
    ...config,
    updatedAt: Date.now(),
  };

  if (storageConfig.workingDirectory) {
    storageConfig.workingDirectory = toPortablePath(storageConfig.workingDirectory);
  }

  atomicWriteFileSync(join(dir, 'config.json'), JSON.stringify(storageConfig, null, 2));
}
