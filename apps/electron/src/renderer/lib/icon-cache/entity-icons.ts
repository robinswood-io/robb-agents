import { omitUndefined } from '@craft-agent/shared/utils/json';
/**
 * Unified Icon Cache
 *
 * Single cache for source, skill, and status icons.
 * Used by EntityIcon, SourceAvatar, SkillAvatar, StatusIcon, and RichTextInput.
 *
 * Icons are stored as data URLs for consistent usage across:
 * - React components (img src)
 * - HTML string generation (inline badges)
 *
 * Cache key format uses type prefixes to avoid collisions:
 * - source:{workspaceId}:{slug}
 * - skill:{workspaceId}:{slug}
 * - status:{workspaceId}:{relativePath}
 *
 * Note: Labels do NOT use icons — they are color-only (colored circles).
 *
 * The useEntityIcon() hook is the single entry point for loading any entity's icon.
 * It handles cache lookup, IPC file loading, SVG theming, and emoji detection.
 */
import { useState, useEffect, useMemo } from "react";
import { isEmoji } from "@craft-agent/shared/utils/icon-constants";
import type { ResolvedEntityIcon } from "@craft-agent/shared/icons";
import { ICON_FILE_EXTENSIONS, ICON_PATH_PATTERN, colorableCache, iconCache, logoUrlCache, rawSvgCache, readWorkspaceImage, skillIconCache, sourceIconCache } from './cache.ts';
import type { SkillConfig, SourceConfig, UseEntityIconOptions } from './contracts.ts';
import { loadIconFile, svgToThemedDataUrl } from './svg.ts';

// ============================================================================
// Source Icon Loading
// ============================================================================

// Special prefix for emoji icons in cache - callers check for this to render emoji
export const EMOJI_ICON_PREFIX = 'emoji:'

/**
 * Load a source icon into the cache.
 *
 * Resolution priority (config.icon is the source of truth):
 * 1. Emoji in config.icon → Return emoji marker for caller to render as text
 * 2. Local path in config.icon (./icon.svg) → Load from sources/{slug}/icon.svg
 * 3. URL in config.icon → Return URL directly for browser to load
 * 4. config.icon undefined → Auto-discover sources/{slug}/icon.{svg,png}
 * 5. Fallback → Resolve favicon from service URL
 *
 * Config takes precedence over auto-discovered local files. If config.icon is set
 * (emoji, local path, or URL), auto-discovery is skipped.
 *
 * @returns Promise resolving to icon URL, emoji marker (emoji:{emoji}), or null
 */
export async function loadSourceIcon(
  source: { config: SourceConfig; workspaceId: string },
): Promise<string | null> {
  const { config, workspaceId } = source
  const cacheKey = `${workspaceId}:${config.slug}`

  // Check cache first
  const cached = sourceIconCache.get(cacheKey)
  if (cached) return cached

  const icon = config.icon

  // Priority 1: Emoji icon - return marker for caller to render as text
  if (icon && isEmoji(icon)) {
    const emojiMarker = `${EMOJI_ICON_PREFIX}${icon}`
    sourceIconCache.set(cacheKey, emojiMarker)
    return emojiMarker
  }

  // Priority 2: Explicit local path in config.icon (e.g., "./icon.svg")
  if (icon?.startsWith('./')) {
    const iconFilename = icon.slice(2) // Remove './'
    const relativePath = `sources/${config.slug}/${iconFilename}`
    const loaded = await loadWorkspaceIcon(workspaceId, relativePath)
    if (loaded) {
      sourceIconCache.set(cacheKey, loaded)
      return loaded
    }
  }

  // Priority 3: URL in config.icon - return URL directly
  // Config URL takes precedence over auto-discovered local files
  if (icon && (icon.startsWith('http://') || icon.startsWith('https://'))) {
    sourceIconCache.set(cacheKey, icon)
    return icon
  }

  // Priority 4: Auto-discover local icon files (only when config.icon is undefined)
  // This preserves backward compatibility for sources without explicit config.icon
  if (!icon) {
    const localIconSvg = await loadWorkspaceIcon(workspaceId, `sources/${config.slug}/icon.svg`)
    if (localIconSvg) {
      sourceIconCache.set(cacheKey, localIconSvg)
      return localIconSvg
    }

    const localIconPng = await loadWorkspaceIcon(workspaceId, `sources/${config.slug}/icon.png`)
    if (localIconPng) {
      sourceIconCache.set(cacheKey, localIconPng)
      return localIconPng
    }
  }

  // Priority 5: Resolve favicon from service URL
  const serviceUrl = deriveServiceUrl(config)
  if (!serviceUrl) return null

  // Use slug for favicon resolution - it's more specific than generic provider names
  const provider = config.slug ?? config.provider
  const logoCacheKey = `${serviceUrl}:${provider ?? ''}`

  // Check logo URL cache
  const cachedLogoUrl = logoUrlCache.get(logoCacheKey)
  if (cachedLogoUrl !== undefined) {
    if (cachedLogoUrl) {
      sourceIconCache.set(cacheKey, cachedLogoUrl)
    }
    return cachedLogoUrl
  }

  try {
    const logoUrl = await window.electronAPI.getLogoUrl(serviceUrl, provider)
    logoUrlCache.set(logoCacheKey, logoUrl)
    if (logoUrl) {
      sourceIconCache.set(cacheKey, logoUrl)
    }
    return logoUrl
  } catch (error) {
    console.error(`[IconCache] Failed to resolve logo URL:`, error)
    logoUrlCache.set(logoCacheKey, null)
    return null
  }
}

/**
 * Helper to load a workspace image via IPC.
 * Handles SVG theming and returns data URL or null on failure.
 */
async function loadWorkspaceIcon(workspaceId: string, relativePath: string): Promise<string | null> {
  try {
    const result = await readWorkspaceImage(workspaceId, relativePath)
    // IPC returns null for missing files (silent fallback)
    if (!result) {
      return null
    }
    // For SVG, theme and convert to data URL
    // This injects foreground color since currentColor doesn't work in background-image
    if (relativePath.endsWith('.svg')) {
      return svgToThemedDataUrl(result)
    }
    return result
  } catch {
    // Security errors or I/O failures still throw - handle them gracefully
    return null
  }
}

/**
 * Get a source icon synchronously from cache.
 * Returns null if not cached (use loadSourceIcon to populate).
 */
export function getSourceIconSync(workspaceId: string, slug: string): string | null {
  const cacheKey = `${workspaceId}:${slug}`
  return sourceIconCache.get(cacheKey) ?? null
}

// ============================================================================
// Skill Icon Loading
// ============================================================================

/**
 * Load a skill icon into the cache.
 *
 * Resolution priority (mirrors loadSourceIcon):
 * 1. Emoji in metadata.icon → Return emoji marker
 * 2. URL in metadata.icon → Return URL directly
 * 3. Known iconPath → Load from file
 * 4. Auto-discover skills/{slug}/icon.{svg,png} → Load from file
 *
 * @returns Promise resolving to icon URL, emoji marker, or null
 */
export async function loadSkillIcon(
  skill: SkillConfig,
  workspaceId: string,
): Promise<string | null> {
  const cacheKey = `${workspaceId}:${skill.slug}`

  // Check cache first
  const cached = skillIconCache.get(cacheKey)
  if (cached) return cached

  const iconValue = skill.metadata?.icon

  // Priority 1: Emoji icon - return marker for caller to render as text
  if (iconValue && isEmoji(iconValue)) {
    const emojiMarker = `${EMOJI_ICON_PREFIX}${iconValue}`
    skillIconCache.set(cacheKey, emojiMarker)
    return emojiMarker
  }

  // Priority 2: URL in metadata - return URL directly
  if (iconValue && (iconValue.startsWith('http://') || iconValue.startsWith('https://'))) {
    skillIconCache.set(cacheKey, iconValue)
    return iconValue
  }

  // Priority 3: Known icon path - load file
  if (skill.iconPath) {
    const skillsMatch = skill.iconPath.match(/skills\/([^/]+)\/(.+)$/)
    if (skillsMatch) {
      const relativePath = `skills/${skillsMatch[1]}/${skillsMatch[2]}`
      const loaded = await loadWorkspaceIcon(workspaceId, relativePath)
      if (loaded) {
        skillIconCache.set(cacheKey, loaded)
        return loaded
      }
    }
  }

  // Priority 4: Auto-discover icon files (when no explicit icon configured)
  if (!iconValue) {
    const svgIcon = await loadWorkspaceIcon(workspaceId, `skills/${skill.slug}/icon.svg`)
    if (svgIcon) {
      skillIconCache.set(cacheKey, svgIcon)
      return svgIcon
    }

    const pngIcon = await loadWorkspaceIcon(workspaceId, `skills/${skill.slug}/icon.png`)
    if (pngIcon) {
      skillIconCache.set(cacheKey, pngIcon)
      return pngIcon
    }
  }

  return null
}

/**
 * Get a skill icon synchronously from cache.
 * Returns null if not cached (use loadSkillIcon to populate).
 */
export function getSkillIconSync(workspaceId: string, slug: string): string | null {
  const cacheKey = `${workspaceId}:${slug}`
  return skillIconCache.get(cacheKey) ?? null
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Derive service URL from source config (for favicon resolution)
 */
function deriveServiceUrl(config: SourceConfig): string | null {
  // MCP sources - use mcp.url
  if (config.type === 'mcp' && config.mcp?.url) {
    return config.mcp.url
  }

  // API sources - use api.baseUrl
  if (config.type === 'api' && config.api?.baseUrl) {
    return config.api.baseUrl
  }

  return null
}

/**
 * Unified icon loading hook - single entry point for all entity types.
 *
 * Handles cache lookup, IPC file loading, SVG theming, colorability detection,
 * and emoji detection. Returns a ResolvedEntityIcon ready for EntityIcon rendering.
 *
 * Resolution priority (config iconValue is the source of truth):
 * 1. Emoji in iconValue → { kind: 'emoji', value: emoji, colorable: false }
 * 2. URL in iconValue → { kind: 'file', value: url, colorable: false }
 * 3. Local file (iconPath) → { kind: 'file', value: dataUrl, colorable }
 * 4. Auto-discover in iconDir (only when iconValue is undefined) → { kind: 'file', value: dataUrl, colorable }
 * 5. Fallback → { kind: 'fallback', colorable: false }
 *
 * Config takes precedence over auto-discovered local files.
 *
 * Usage:
 *   const icon = useEntityIcon({ workspaceId, entityType: 'skill', identifier: slug, iconPath })
 *   return <EntityIcon icon={icon} fallbackIcon={Zap} />
 */
export function useEntityIcon(opts: UseEntityIconOptions): ResolvedEntityIcon {
  const { workspaceId, entityType, identifier, iconPath, iconDir, iconValue, iconFileName } = opts

  // Stable cache key for this entity's icon
  const cacheKey = `${entityType}:${workspaceId}:${identifier}`

  // Check if iconValue is an emoji or URL (synchronous, no loading needed)
  const immediateValue = useMemo(() => {
    // Guard against non-string values (can happen with malformed config data)
    if (!iconValue || typeof iconValue !== 'string') return null
    if (isEmoji(iconValue)) return { type: 'emoji' as const, value: iconValue }
    if (iconValue.startsWith('http://') || iconValue.startsWith('https://')) {
      return { type: 'url' as const, value: iconValue }
    }
    return null
  }, [iconValue])

  // Initial state: check cache synchronously or return emoji/url/fallback
  const [resolved, setResolved] = useState<ResolvedEntityIcon>(() => {
    if (immediateValue?.type === 'emoji') {
      return { kind: 'emoji', value: immediateValue.value, colorable: false }
    }
    if (immediateValue?.type === 'url') {
      // URLs are returned directly as 'file' kind (works in img src)
      return { kind: 'file', value: immediateValue.value, colorable: false }
    }
    // Check unified cache for a previously loaded file icon
    const cached = iconCache.get(cacheKey)
    if (cached) {
      const colorable = colorableCache.has(cacheKey)
      const rawSvg = colorable ? rawSvgCache.get(cacheKey) : undefined
      return {
        kind: 'file',
        value: cached,
        colorable,
        ...(rawSvg !== undefined ? { rawSvg } : {}),
      }
    }
    return { kind: 'fallback', colorable: false }
  })

  useEffect(() => {
    // If emoji, no file loading needed - just update state
    if (immediateValue?.type === 'emoji') {
      setResolved({ kind: 'emoji', value: immediateValue.value, colorable: false })
      return
    }

    // If URL from config, use it directly (no file loading needed)
    // Config URL takes precedence over auto-discovered local files
    if (immediateValue?.type === 'url') {
      setResolved({ kind: 'file', value: immediateValue.value, colorable: false })
      return
    }

    // Check cache first
    const cached = iconCache.get(cacheKey)
    if (cached) {
      const colorable = colorableCache.has(cacheKey)
      const rawSvg = colorable ? rawSvgCache.get(cacheKey) : undefined
      setResolved(omitUndefined({
        kind: 'file' as const,
        value: cached,
        colorable,
        ...(rawSvg !== undefined ? { rawSvg } : {}),
      }))
      return
    }

    // No cache hit - load from filesystem via IPC
    let cancelled = false

    async function loadIcon() {
      let result: { dataUrl: string; colorable: boolean; rawSvg?: string } | null = null

      if (iconPath) {
        // Known path - extract relative portion and load directly
        // iconPath may be absolute; extract the workspace-relative part
        const relativeMatch = iconPath.match(ICON_PATH_PATTERN)
        const relativePath = relativeMatch ? relativeMatch[0] : iconPath

        result = await loadIconFile(workspaceId, relativePath)
      } else if (iconDir && !iconValue) {
        // Auto-discover icon files in directory
        // Only do auto-discovery when iconValue is undefined (config takes precedence)
        // iconFileName overrides the default 'icon' prefix (e.g. statuses use statusId)
        result = await discoverIconFile(workspaceId, iconDir, iconFileName)
      }

      if (cancelled) return

      if (result) {
        // Cache the loaded icon and its colorability/rawSvg
        iconCache.set(cacheKey, result.dataUrl)
        if (result.colorable) {
          colorableCache.add(cacheKey)
        }
        if (result.rawSvg) {
          rawSvgCache.set(cacheKey, result.rawSvg)
        }
        setResolved(omitUndefined({
          kind: 'file' as const,
          value: result.dataUrl,
          colorable: result.colorable,
          rawSvg: result.rawSvg,
        }))
      } else {
        setResolved({ kind: 'fallback', colorable: false })
      }
    }

    loadIcon()

    return () => { cancelled = true }
  }, [workspaceId, entityType, identifier, iconPath, iconDir, iconFileName, immediateValue, cacheKey, iconValue])

  return resolved
}

/**
 * Auto-discover an icon file in a workspace directory.
 * Tries extensions in priority order and stops at the first existing file.
 * Default fileName is 'icon' (e.g. icon.svg). Override for entities
 * that use identifier-based naming (e.g. statuses use '{statusId}.svg').
 */
async function discoverIconFile(
  workspaceId: string,
  iconDir: string,
  fileName?: string
): Promise<{ dataUrl: string; colorable: boolean; rawSvg?: string } | null> {
  const name = fileName ?? 'icon'

  for (const ext of ICON_FILE_EXTENSIONS) {
    const result = await loadIconFile(workspaceId, `${iconDir}/${name}${ext}`)
    if (result) return result
  }
  return null
}
