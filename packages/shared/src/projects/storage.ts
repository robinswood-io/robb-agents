/** Projects: confined paths, configuration, memory, inventory, lifecycle and assets. */
export { getWorkspaceProjectsPath, getProjectPath, getProjectAssetsPath, MEMORY_FILENAME, getProjectMemoryPath, ensureProjectsDir, ensureProjectAssetsDir } from './storage/paths.ts';
export { loadProjectConfig, saveProjectConfig } from './storage/project-config.ts';
export { loadProjectMemory } from './storage/project-memory.ts';
export { loadProject, loadProjectById, loadWorkspaceProjects } from './storage/inventory.ts';
export { generateProjectSlug, createProject, updateProject, deleteProject, projectExists } from './storage/lifecycle.ts';
export type { UploadProjectAssetInput } from './storage/assets.ts';
export { sanitizeAssetFilename, listProjectAssets, uploadProjectAsset, deleteProjectAsset } from './storage/assets.ts';
