/**
 * Source Storage
 *
 * CRUD operations for workspace-scoped sources.
 * Sources are stored at {workspaceRootPath}/sources/{sourceSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedSource.workspaceId` is derived via basename().
 */
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { FolderSourceConfig, CreateSourceInput } from "../types.ts";
import { debug } from "../../utils/debug.ts";
import { getWorkspaceSourcesPath } from "../../workspaces/storage.ts";
import { validateIconValue, downloadIcon, isIconUrl } from "../../utils/icon.ts";
import { getSourcePath, saveSourceConfig } from './source-config.ts';
import { saveSourceGuide } from './source-guides.ts';

// ============================================================
// Create/Delete Operations
// ============================================================

/**
 * Generate URL-safe slug from name
 */
export function generateSourceSlug(workspaceRootPath: string, name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  // Ensure slug is not empty
  if (!slug) {
    slug = 'source';
  }

  // Check for existing slugs and append number if needed
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(sourcesDir)) {
    const entries = readdirSync(sourcesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        existingSlugs.add(entry.name);
      }
    }
  }

  if (!existingSlugs.has(slug)) {
    return slug;
  }

  // Find next available number
  let counter = 2;
  while (existingSlugs.has(`${slug}-${counter}`)) {
    counter++;
  }

  return `${slug}-${counter}`;
}

/**
 * Create a new source in a workspace
 */
export async function createSource(
  workspaceRootPath: string,
  input: CreateSourceInput
): Promise<FolderSourceConfig> {
  const slug = generateSourceSlug(workspaceRootPath, input.name);
  const now = Date.now();

  const config: FolderSourceConfig = {
    // ID format: {slug}_{random} for easy identification (e.g., "linear_a1b2c3d4")
    id: `${slug}_${randomUUID().slice(0, 8)}`,
    name: input.name,
    slug,
    enabled: input.enabled ?? true,
    provider: input.provider,
    type: input.type,
    routingSensitivity: input.routingSensitivity,
    createdAt: now,
    updatedAt: now,
  };

  // Add type-specific config
  switch (input.type) {
    case 'mcp':
      if (input.mcp) {
        config.mcp = input.mcp;
      }
      break;
    case 'api':
      if (input.api) {
        config.api = input.api;
      }
      break;
    case 'local':
      if (input.local) {
        config.local = input.local;
      }
      break;
  }

  // Validate and store icon (emoji or URL)
  // URL icons are downloaded on first config change via watcher
  if (input.icon) {
    const validatedIcon = validateIconValue(input.icon, 'Sources');
    if (validatedIcon) {
      config.icon = validatedIcon;
    }
  }

  // Save config first to create the directory
  saveSourceConfig(workspaceRootPath, config);

  // If icon is a URL, download it immediately
  // (watcher will also handle this, but doing it here provides immediate feedback)
  const sourcePath = getSourcePath(workspaceRootPath, slug);
  if (config.icon && isIconUrl(config.icon)) {
    const iconPath = await downloadIcon(sourcePath, config.icon, 'Sources');
    if (iconPath) {
      debug(`[createSource] Icon downloaded for ${slug}: ${iconPath}`);
    }
  } else if (!config.icon) {
    // No icon provided - try to auto-fetch from service URL
    const { deriveServiceUrl, getHighQualityLogoUrl } = await import("../../utils/logo.ts");
    const { downloadIcon } = await import("../../utils/icon.ts");
    const serviceUrl = deriveServiceUrl(input);
    if (serviceUrl) {
      const logoUrl = await getHighQualityLogoUrl(serviceUrl, input.provider);
      if (logoUrl) {
        const iconPath = await downloadIcon(sourcePath, logoUrl, `createSource:${slug}`);
        if (iconPath) {
          // Store the source URL for reference (not the cached path)
          config.icon = logoUrl;
          saveSourceConfig(workspaceRootPath, config);
        }
      }
    }
  }

  // Create guide.md with skeleton template
  // (bundled guides removed - agent should search craft-agents-docs MCP for service-specific guidance)
  const guideContent = `# ${input.name}

## Guidelines

(Add usage guidelines here)

## Context

(Add context about this source)
`;
  saveSourceGuide(workspaceRootPath, slug, { raw: guideContent });

  return config;
}

/**
 * Delete a source from a workspace
 */
export function deleteSource(workspaceRootPath: string, sourceSlug: string): void {
  const dir = getSourcePath(workspaceRootPath, sourceSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

/**
 * Check if a source exists in a workspace
 */
export function sourceExists(workspaceRootPath: string, sourceSlug: string): boolean {
  return existsSync(join(getSourcePath(workspaceRootPath, sourceSlug), 'config.json'));
}
