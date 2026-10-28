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
import type { NavigationState } from "../types";
import { type SettingsSubpage } from "../settings-registry";
import { parseCompoundRoute } from './compound-routes.ts';
import { convertParsedRouteToNavigationState } from './legacy-navigation.ts';
import type { ParsedCompoundRoute } from './route-types.ts';
import { isCompoundRoute } from './route-types.ts';
import { parseRightSidebarParam } from './sidebar-routes.ts';
import { parseRoute } from './view-routes.ts';

// =============================================================================
// NavigationState Parsing (new unified system)
// =============================================================================

/**
 * Parse a route string directly to NavigationState (the unified state)
 *
 * This is the preferred way to parse routes - returns the unified state that
 * determines all 3 panels (sidebar, navigator, main content).
 *
 * Supports:
 * - Compound routes: allSessions, allSessions/session/abc, sources, sources/source/github, settings/shortcuts
 * - Right sidebar param: ?sidebar=files or ?sidebar=history
 *
 * Returns null for action routes (they don't map to a navigation state) and invalid routes.
 */
export function parseRouteToNavigationState(
  route: string,
  sidebarParam?: string
): NavigationState | null {
  // Parse compound routes
  if (isCompoundRoute(route)) {
    const compound = parseCompoundRoute(route)
    if (compound) {
      const state = convertCompoundToNavigationState(compound)
      // Add rightSidebar if param provided
      const rightSidebar = parseRightSidebarParam(sidebarParam)
      if (rightSidebar) {
        return { ...state, rightSidebar }
      }
      return state
    }
  }

  // Parse as route (may be action or view)
  const parsed = parseRoute(route)
  if (!parsed) return null

  // Actions don't map to navigation state
  if (parsed.type === 'action') return null

  // Convert view routes to NavigationState
  const state = convertParsedRouteToNavigationState(parsed)
  if (state) {
    // Add rightSidebar if param provided
    const rightSidebar = parseRightSidebarParam(sidebarParam)
    if (rightSidebar) {
      return { ...state, rightSidebar }
    }
  }
  return state
}

/**
 * Convert a ParsedCompoundRoute to NavigationState
 */
function convertCompoundToNavigationState(compound: ParsedCompoundRoute): NavigationState {
  // Settings
  if (compound.navigator === 'settings') {
    if (!compound.details) {
      return { navigator: 'settings', subpage: null }
    }
    return { navigator: 'settings', subpage: compound.details.type as SettingsSubpage }
  }

  // Sources - include filter if present
  if (compound.navigator === 'sources') {
    if (!compound.details) {
      return {
        navigator: 'sources',
        ...(compound.sourceFilter !== undefined ? { filter: compound.sourceFilter } : {}),
        details: null,
      }
    }
    return {
      navigator: 'sources',
      ...(compound.sourceFilter !== undefined ? { filter: compound.sourceFilter } : {}),
      details: { type: 'source', sourceSlug: compound.details.id },
    }
  }

  // Skills
  if (compound.navigator === 'skills') {
    if (!compound.details) {
      return { navigator: 'skills', details: null }
    }
    return {
      navigator: 'skills',
      details: { type: 'skill', skillSlug: compound.details.id },
    }
  }

  // Automations - include filter if present
  if (compound.navigator === 'automations') {
    if (!compound.details) {
      return {
        navigator: 'automations',
        ...(compound.automationFilter !== undefined ? { filter: compound.automationFilter } : {}),
        details: null,
      }
    }
    return {
      navigator: 'automations',
      ...(compound.automationFilter !== undefined ? { filter: compound.automationFilter } : {}),
      details: { type: 'automation', automationId: compound.details.id },
    }
  }

  // Projects
  if (compound.navigator === 'projects') {
    if (!compound.details) {
      return { navigator: 'projects', details: null }
    }
    return {
      navigator: 'projects',
      details: { type: 'project', projectSlug: compound.details.id },
    }
  }

  // Mission OS / Control Room
  if (compound.navigator === 'missions') {
    if (!compound.details) {
      return { navigator: 'missions', details: null }
    }
    return {
      navigator: 'missions',
      details: { type: 'mission', missionId: compound.details.id },
    }
  }

  // Sessions
  const filter = compound.sessionFilter || { kind: 'allSessions' as const }
  if (compound.details) {
    return {
      navigator: 'sessions',
      filter,
      details: { type: 'session', sessionId: compound.details.id },
    }
  }
  return {
    navigator: 'sessions',
    filter,
    ...(compound.viewMode !== undefined ? { viewMode: compound.viewMode } : {}),
    details: null,
  }
}
