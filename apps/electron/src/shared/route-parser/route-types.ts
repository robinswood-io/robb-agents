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
import type { SessionFilter, SourceFilter, AutomationFilter } from "../types";

// =============================================================================
// Route Types
// =============================================================================

export type RouteType = 'action' | 'view'

export interface ParsedRoute {
  type: RouteType
  name: string
  id?: string
  params: Record<string, string>
}

// =============================================================================
// Compound Route Types (new format)
// =============================================================================

export type NavigatorType = 'sessions' | 'sources' | 'skills' | 'automations' | 'projects' | 'missions' | 'settings'

export interface ParsedCompoundRoute {
  /** The navigator type */
  navigator: NavigatorType
  /** Session filter (only for sessions navigator) */
  sessionFilter?: SessionFilter
  /** Source filter (only for sources navigator) */
  sourceFilter?: SourceFilter
  /** Automation filter (only for automations navigator) */
  automationFilter?: AutomationFilter
  /** Sessions presentation mode (only for sessions navigator). 'board' = Kanban view. */
  viewMode?: 'list' | 'board'
  /** Details page info (null for empty state) */
  details: {
    type: string
    id: string
  } | null
}

// =============================================================================
// Compound Route Parsing
// =============================================================================

/**
 * Known prefixes that indicate a compound route
 */
const COMPOUND_ROUTE_PREFIXES = [
  'allSessions', 'flagged', 'archived', 'state', 'label', 'view', 'board', 'sources', 'skills', 'automations', 'projects', 'missions', 'settings'
]

/**
 * Check if a route is a compound route (new format)
 */
export function isCompoundRoute(route: string): boolean {
  const firstSegment = route.split('?')[0].split('/')[0]
  return COMPOUND_ROUTE_PREFIXES.includes(firstSegment)
}
