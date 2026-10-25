
// ============================================================================
// Unified Cache
// ============================================================================

/**
 * Single unified cache for all icon types.
 * Key format: `{type}:{workspaceId}:{identifier}`
 * - source:wsId:slug
 * - skill:wsId:slug
 * - status:wsId:relativePath
 */
export const iconCache = new Map<string, string>()

/**
 * Cache for resolved logo URLs (from service URL resolution).
 * Kept separate because it caches URL resolution, not icon data,
 * and uses a different key format: `{serviceUrl}:{provider}`
 */
export const logoUrlCache = new Map<string, string | null>()

// Composers and avatars can request the same image before its icon is cached.
// Share that read instead of consuming another RPC slot for each consumer.
const pendingWorkspaceImages = new Map<string, Promise<string | null>>()

export function readWorkspaceImage(workspaceId: string, relativePath: string): Promise<string | null> {
  const key = `${workspaceId}:${relativePath}`
  const pending = pendingWorkspaceImages.get(key)
  if (pending) return pending

  const request = window.electronAPI.readWorkspaceImage(workspaceId, relativePath)
    .finally(() => { pendingWorkspaceImages.delete(key) })
  pendingWorkspaceImages.set(key, request)
  return request
}

// ============================================================================
// Legacy exports (for backward compatibility during migration)
// These are views into the unified cache, not separate maps.
// ============================================================================

// Proxy objects that redirect to the unified cache with appropriate prefixes
// This allows consumers to continue using the old API while we migrate them

/** @deprecated Use iconCache directly with 'source:' prefix */
export const sourceIconCache = {
  get: (key: string) => iconCache.get(`source:${key}`),
  set: (key: string, value: string) => iconCache.set(`source:${key}`, value),
  has: (key: string) => iconCache.has(`source:${key}`),
  delete: (key: string) => iconCache.delete(`source:${key}`),
  clear: () => {
    // Clear only source entries
    for (const key of iconCache.keys()) {
      if (key.startsWith('source:')) iconCache.delete(key)
    }
  },
}

/** @deprecated Use iconCache directly with 'skill:' prefix */
export const skillIconCache = {
  get: (key: string) => iconCache.get(`skill:${key}`),
  set: (key: string, value: string) => iconCache.set(`skill:${key}`, value),
  has: (key: string) => iconCache.has(`skill:${key}`),
  delete: (key: string) => iconCache.delete(`skill:${key}`),
  clear: () => {
    // Clear only skill entries
    for (const key of iconCache.keys()) {
      if (key.startsWith('skill:')) iconCache.delete(key)
    }
  },
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Clear all icon caches (all entity types)
 */
export function clearIconCaches(): void {
  iconCache.clear()
  logoUrlCache.clear()
  colorableCache.clear()
  rawSvgCache.clear()
}

/**
 * Clear source icon caches only.
 * @deprecated Will be removed once rich-text-input.tsx is migrated to useEntityIcon.
 */
export function clearSourceIconCaches(): void {
  sourceIconCache.clear()
  logoUrlCache.clear()
  // Also clear from colorable/rawSvg caches
  for (const key of colorableCache) {
    if (key.startsWith('source:')) colorableCache.delete(key)
  }
  for (const key of rawSvgCache.keys()) {
    if (key.startsWith('source:')) rawSvgCache.delete(key)
  }
}

/**
 * Clear skill icon caches only.
 * @deprecated Will be removed once rich-text-input.tsx is migrated to useEntityIcon.
 */
export function clearSkillIconCaches(): void {
  skillIconCache.clear()
  for (const key of colorableCache) {
    if (key.startsWith('skill:')) colorableCache.delete(key)
  }
  for (const key of rawSvgCache.keys()) {
    if (key.startsWith('skill:')) rawSvgCache.delete(key)
  }
}

// ============================================================================
// Unified Entity Icon Hook
// ============================================================================

/** Supported icon file extensions for auto-discovery */
export const ICON_FILE_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg']

/**
 * Pre-compiled regex for extracting workspace-relative icon paths from absolute paths.
 * Matches any known entity directory prefix (skills/, sources/, statuses/)
 * followed by the rest of the path.
 */
export const ICON_PATH_PATTERN = /(?:skills|sources|statuses)\/.+$/

// ============================================================================
// useEntityIcon Internal Helpers
// ============================================================================

/**
 * Tracks which cached icons are colorable (use currentColor).
 * Kept as a Set of cache keys for O(1) lookup.
 */
export const colorableCache = new Set<string>()

/**
 * Stores sanitized raw SVG content for colorable icons.
 * Used for inline rendering so CSS color classes can cascade into SVG fills.
 */
export const rawSvgCache = new Map<string, string>()
