import { omitUndefined } from '@craft-agent/shared/utils/json';
/**
 * Route Parser
 *
 * Parses route strings back into structured navigation objects.
 * Used by both the navigate() function and deep link handler.
 *
 * Supports route formats:
 * - Action: action/{name}[/{id}] - Trigger side effects
 * - Compound: {filter}[/session/{sessionId}] - View routes for full navigation state
 */
import type { RightSidebarPanel } from "../types";

// =============================================================================
// Right Sidebar Param Parsing
// =============================================================================

/**
 * Parse right sidebar param from URL query string
 *
 * Examples:
 *   'history' -> { type: 'history' }
 *   'files' -> { type: 'files' }
 *   'files/src/main.ts' -> { type: 'files', path: 'src/main.ts' }
 *   'none' -> { type: 'none' }
 */
export function parseRightSidebarParam(sidebarStr?: string): RightSidebarPanel | undefined {
  if (!sidebarStr) return undefined

  if (sidebarStr === 'history') {
    return { type: 'history' }
  }
  if (sidebarStr.startsWith('files')) {
    const path = sidebarStr.substring(6) // Remove 'files/' prefix
    return omitUndefined<Extract<RightSidebarPanel, { type: 'files' }>>({ type: 'files', path: path || undefined })
  }
  if (sidebarStr === 'none') {
    return { type: 'none' }
  }

  return undefined
}

/**
 * Build right sidebar param for URL query string
 *
 * Returns undefined for 'none' type (omit from URL to keep URLs clean)
 */
export function buildRightSidebarParam(panel?: RightSidebarPanel): string | undefined {
  if (!panel || panel.type === 'none') return undefined

  switch (panel.type) {
    case 'history':
      return 'history'
    case 'files':
      return panel.path ? `files/${panel.path}` : 'files'
    default:
      return undefined
  }
}
