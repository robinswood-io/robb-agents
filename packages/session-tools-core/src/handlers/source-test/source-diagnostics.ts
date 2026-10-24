/**
 * Source Test Handler
 *
 * Validates and tests a source configuration comprehensively.
 * Performs schema validation, completeness checks, icon handling,
 * connection tests, and auth verification.
 */
import { join } from "node:path";
import type { SessionToolContext } from "../../context.ts";
import type { SourceConfig } from "../../types.ts";
import { getSourceGuidePath } from "../../source-helpers.ts";

// ============================================================
// Icon Handling
// ============================================================

export async function handleIconCheck(
  ctx: SessionToolContext,
  sourcePath: string,
  sourceSlug: string,
  source: SourceConfig
): Promise<{ lines: string[]; hasWarning: boolean }> {
  const lines: string[] = [];
  let hasWarning = false;

  // Check for local icon files
  const iconPngPath = join(sourcePath, 'icon.png');
  const iconSvgPath = join(sourcePath, 'icon.svg');
  const iconJpgPath = join(sourcePath, 'icon.jpg');

  const hasLocalIcon =
    ctx.fs.exists(iconPngPath) ||
    ctx.fs.exists(iconSvgPath) ||
    ctx.fs.exists(iconJpgPath);

  if (hasLocalIcon) {
    const format = ctx.fs.exists(iconPngPath) ? 'PNG' : ctx.fs.exists(iconSvgPath) ? 'SVG' : 'JPG';
    lines.push(`✓ Icon file exists (${format})`);
    return { lines, hasWarning };
  }

  // Check if icon is a URL that can be downloaded
  if (source.icon && ctx.isIconUrl && ctx.isIconUrl(source.icon)) {
    if (ctx.downloadSourceIcon) {
      lines.push(`ℹ Icon URL detected: ${source.icon}`);
      try {
        const cachedPath = await ctx.downloadSourceIcon(sourceSlug, source.icon);
        if (cachedPath) {
          lines.push(`✓ Icon downloaded and cached`);
          return { lines, hasWarning };
        }
      } catch (e) {
        lines.push(`⚠ Failed to download icon: ${e instanceof Error ? e.message : 'Unknown error'}`);
        hasWarning = true;
      }
    } else {
      lines.push(`ℹ Icon URL configured but download not available: ${source.icon}`);
    }
  }

  // Check if icon is an emoji
  if (source.icon && isEmoji(source.icon)) {
    lines.push(`✓ Emoji icon configured: ${source.icon}`);
    return { lines, hasWarning };
  }

  // Try to auto-fetch icon from service
  if (!source.icon && ctx.deriveServiceUrl && ctx.getHighQualityLogoUrl && ctx.downloadIcon) {
    const serviceUrl = ctx.deriveServiceUrl(source);
    if (serviceUrl) {
      lines.push(`ℹ Attempting to auto-fetch icon from service URL...`);
      try {
        const logoUrl = await ctx.getHighQualityLogoUrl(serviceUrl, sourceSlug);
        if (logoUrl) {
          const destPath = join(sourcePath, 'icon.png');
          const downloaded = await ctx.downloadIcon(destPath, logoUrl, sourceSlug);
          if (downloaded) {
            lines.push(`✓ Icon auto-fetched and saved`);
            return { lines, hasWarning };
          }
        }
      } catch {
        // Silently continue if auto-fetch fails
      }
    }
  }

  // No icon found
  hasWarning = true;
  lines.push('⚠ No icon configured');
  lines.push('  Options:');
  lines.push('  - Add icon.png or icon.svg to source folder');
  lines.push('  - Set "icon" field to a URL or emoji in config.json');
  if (source.type === 'api' && source.api?.baseUrl) {
    lines.push(`  - Icon may be auto-fetched from ${new URL(source.api.baseUrl).hostname}`);
  }

  return { lines, hasWarning };
}

/**
 * Simple emoji detection
 */
function isEmoji(str: string): boolean {
  // Check if string is a single emoji (basic heuristic)
  const emojiRegex = /^[\p{Emoji}]$/u;
  return emojiRegex.test(str) || (str.length >= 2 && str.length <= 8 && /[\u{1F300}-\u{1FAD6}]/u.test(str));
}

// ============================================================
// Completeness Check
// ============================================================

export function checkCompleteness(
  ctx: SessionToolContext,
  sourcePath: string,
  source: SourceConfig
): { lines: string[]; hasWarning: boolean } {
  const lines: string[] = [];
  let hasWarning = false;

  // Check guide.md
  const guidePath = getSourceGuidePath(ctx.workspacePath, source.slug);
  if (!ctx.fs.exists(guidePath)) {
    hasWarning = true;
    lines.push('⚠ No guide.md file');
    lines.push('  Recommended: Add guide.md with usage instructions for the agent');
  } else {
    try {
      const guideContent = ctx.fs.readFile(guidePath);
      const guideSize = guideContent.length;
      const wordCount = guideContent.split(/\s+/).filter(Boolean).length;
      lines.push(`✓ guide.md exists (${wordCount} words, ${formatBytes(guideSize)})`);

      if (wordCount < 50) {
        lines.push('  ℹ Guide is short - consider adding more context');
      }
    } catch {
      lines.push('✓ guide.md exists');
    }
  }

  // Check tagline field
  if (!source.tagline) {
    // Check if they used 'description' instead (common mistake)
    if ((source as unknown as Record<string, unknown>)['description']) {
      hasWarning = true;
      lines.push('⚠ Found "description" field instead of "tagline"');
      lines.push('  Rename "description" to "tagline" in config.json');
    } else {
      hasWarning = true;
      lines.push('⚠ No tagline configured');
      lines.push('  Add "tagline": "Brief description" to config.json');
    }
  } else {
    lines.push(`✓ Tagline: "${source.tagline}"`);
    if (source.tagline.length > 100) {
      lines.push('  ℹ Tagline is long - consider shortening to < 100 chars');
    }
  }

  // Check name
  if (source.name) {
    lines.push(`✓ Name: "${source.name}"`);
  }

  return { lines, hasWarning };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
