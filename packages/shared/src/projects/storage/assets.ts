/**
 * Project Storage
 *
 * CRUD operations for workspace-scoped projects.
 * Projects are stored at {workspaceRootPath}/projects/{projectSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedProject.workspaceId` is derived via basename().
 */
import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import { randomUUID } from "crypto";
import { getMimeType } from "../../utils/files.ts";
import { debug } from "../../utils/debug.ts";
import type { ProjectAsset } from "../types.ts";
import { projectExists } from './lifecycle.ts';
import { ensureProjectAssetsDir, getProjectAssetsPath } from './paths.ts';

// ============================================================
// Asset Operations
// ============================================================

/**
 * Sanitize an upload filename so it stays inside the assets directory.
 * Strips path separators and leading dots; falls back to a uuid name if empty.
 */
export function sanitizeAssetFilename(filename: string): string {
  // Strip path separators AND control chars (NUL/newlines/DEL) so a crafted upload name can't
  // escape the assets dir or, once listed, forge new lines in the <project_assets> prompt block.
  const base = basename(filename).replace(/[\\/\x00-\x1f\x7f]+/g, '').replace(/^\.+/, '');
  if (!base) return `asset_${randomUUID().slice(0, 8)}`;
  return base.slice(0, 255);
}

/**
 * List all assets for a project (sorted newest first).
 */
export function listProjectAssets(
  workspaceRootPath: string,
  projectSlug: string,
): ProjectAsset[] {
  ensureProjectAssetsDir(workspaceRootPath, projectSlug);

  const assetsDir = getProjectAssetsPath(workspaceRootPath, projectSlug);
  if (!existsSync(assetsDir)) return [];

  const assets: ProjectAsset[] = [];
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = join(assetsDir, entry.name);
    try {
      const stats = statSync(filePath);
      assets.push({
        filename: entry.name,
        sizeBytes: stats.size,
        mimeType: getMimeType(filePath),
        uploadedAt: stats.mtimeMs,
        absolutePath: filePath,
      });
    } catch (error) {
      debug('[listProjectAssets] Failed to stat asset:', filePath, error);
    }
  }

  assets.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return assets;
}

export interface UploadProjectAssetInput {
  filename: string;
  /** Base64-encoded contents (preferred for cross-process IPC) */
  base64?: string;
  /** Raw text contents (for small text/markdown uploads) */
  text?: string;
  /** Absolute source path on disk; copied into the assets folder */
  sourcePath?: string;
}

/**
 * Upload (write) an asset into the project's assets directory.
 * Accepts base64, text, or a sourcePath to copy from.
 * Resolves filename collisions by appending `-{n}` before the extension.
 */
export function uploadProjectAsset(
  workspaceRootPath: string,
  projectSlug: string,
  input: UploadProjectAssetInput,
): ProjectAsset {
  if (!projectExists(workspaceRootPath, projectSlug)) {
    throw new Error(`Project not found: ${projectSlug}`);
  }

  ensureProjectAssetsDir(workspaceRootPath, projectSlug);

  const safeName = sanitizeAssetFilename(input.filename);
  const assetsDir = getProjectAssetsPath(workspaceRootPath, projectSlug);
  const targetPath = resolveUniqueAssetPath(assetsDir, safeName);

  if (input.base64 !== undefined) {
    writeFileSync(targetPath, Buffer.from(input.base64, 'base64'));
  } else if (input.text !== undefined) {
    writeFileSync(targetPath, input.text, 'utf-8');
  } else if (input.sourcePath) {
    if (!existsSync(input.sourcePath)) {
      throw new Error(`Source file does not exist: ${input.sourcePath}`);
    }
    const data = readFileSync(input.sourcePath);
    writeFileSync(targetPath, data);
  } else {
    throw new Error('uploadProjectAsset requires one of: base64, text, sourcePath');
  }

  const stats = statSync(targetPath);
  return {
    filename: basename(targetPath),
    sizeBytes: stats.size,
    mimeType: getMimeType(targetPath),
    uploadedAt: stats.mtimeMs,
    absolutePath: targetPath,
  };
}

/**
 * Delete a single asset from a project (no-op if missing).
 */
export function deleteProjectAsset(
  workspaceRootPath: string,
  projectSlug: string,
  filename: string,
): void {
  const safe = sanitizeAssetFilename(filename);
  const target = join(getProjectAssetsPath(workspaceRootPath, projectSlug), safe);
  if (!existsSync(target)) return;

  // Refuse to follow path traversal — `safe` should already be the bare filename.
  if (basename(target) !== safe) {
    throw new Error(`Refusing to delete asset outside assets directory: ${filename}`);
  }

  try {
    unlinkSync(target);
  } catch (error) {
    debug('[deleteProjectAsset] Failed to delete asset:', target, error);
    throw error;
  }
}

/**
 * Resolve a target path inside `assetsDir` that does not collide with existing files.
 * Returns the original name if free; otherwise appends `-2`, `-3`, ... before the extension.
 */
function resolveUniqueAssetPath(assetsDir: string, filename: string): string {
  const candidate = join(assetsDir, filename);
  if (!existsSync(candidate)) return candidate;

  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;

  let counter = 2;
  while (existsSync(join(assetsDir, `${stem}-${counter}${ext}`))) counter++;
  return join(assetsDir, `${stem}-${counter}${ext}`);
}
