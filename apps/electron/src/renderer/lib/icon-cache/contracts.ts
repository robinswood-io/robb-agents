
// ============================================================================
// Types
// ============================================================================

export interface SourceConfig {
  slug: string
  name: string
  type: string
  icon?: string  // Emoji or URL (local icon files are auto-discovered separately)
  provider?: string
  mcp?: {
    url?: string
  }
  api?: {
    baseUrl?: string
  }
}

export interface SkillConfig {
  slug: string
  iconPath?: string
  metadata?: { icon?: string }
}

/**
 * Options for the useEntityIcon hook.
 */
export interface UseEntityIconOptions {
  /** Workspace context for IPC calls */
  workspaceId: string
  /** Cache namespace (e.g. 'source', 'skill', 'status', 'label') */
  entityType: string
  /** Unique identifier within the entity type (slug, statusId, etc.) */
  identifier: string
  /**
   * Known relative path to icon file (for entities with pre-resolved paths).
   * e.g. 'skills/my-skill/icon.svg'
   * If provided, only this exact path is attempted (no auto-discovery).
   */
  iconPath?: string
  /**
   * Directory to auto-discover icon files in (relative to workspace).
   * e.g. 'sources/linear' → tries sources/linear/icon.svg, icon.png, etc.
   * Ignored if iconPath is provided.
   */
  iconDir?: string
  /**
   * Icon value from entity config. Can be:
   * - Emoji string (e.g. "🔧") → resolved as emoji
   * - URL (ignored here, assumed already downloaded to local file)
   * - undefined → auto-discover from iconDir
   */
  iconValue?: string
  /**
   * Override the filename used for auto-discovery (default: 'icon').
   * e.g. for statuses, set to the statusId so it discovers '{statusId}.svg'
   * instead of 'icon.svg'.
   */
  iconFileName?: string
}
