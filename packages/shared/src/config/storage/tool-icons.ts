import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { getBundledAssetsDir } from "../../utils/paths.ts";
import { CONFIG_DIR } from "../paths.ts";
// ============================================
// Tool Icons (CLI tool icons for turn card display)
// ============================================
import { copyFileSync } from "fs";

const TOOL_ICONS_DIR_NAME = 'tool-icons';

/**
 * Returns the path to the tool-icons directory: ~/.craft-agent/tool-icons/
 */
export function getToolIconsDir(): string {
  return join(CONFIG_DIR, TOOL_ICONS_DIR_NAME);
}

/**
 * Ensure tool-icons directory exists and has bundled defaults.
 * Resolves bundled path automatically via getBundledAssetsDir('tool-icons').
 * Copies bundled tool-icons.json and icon files on first run.
 * Only copies files that don't already exist (preserves user customizations).
 */
export function ensureToolIcons(): void {
  const toolIconsDir = getToolIconsDir();

  // Create tool-icons directory if it doesn't exist
  if (!existsSync(toolIconsDir)) {
    mkdirSync(toolIconsDir, { recursive: true });
  }

  // Resolve bundled tool-icons directory via shared asset resolver
  const bundledToolIconsDir = getBundledAssetsDir('tool-icons');
  if (!bundledToolIconsDir) {
    return;
  }

  // Copy each bundled file if it doesn't exist in the target dir
  // This includes tool-icons.json and all icon files (png, ico, svg, jpg)
  try {
    const bundledFiles = readdirSync(bundledToolIconsDir);
    for (const file of bundledFiles) {
      const destPath = join(toolIconsDir, file);
      if (!existsSync(destPath)) {
        const srcPath = join(bundledToolIconsDir, file);
        copyFileSync(srcPath, destPath);
      }
    }
  } catch {
    // Ignore errors — tool icons are optional enhancement
  }
}
