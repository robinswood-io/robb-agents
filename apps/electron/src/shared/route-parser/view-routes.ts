import { parseCompoundRoute } from './compound-routes.ts';
import type { ParsedCompoundRoute, ParsedRoute } from './route-types.ts';
import { isCompoundRoute } from './route-types.ts';

// =============================================================================
// Route Parsing
// =============================================================================

/**
 * Parse a route string into structured navigation
 *
 * Examples:
 *   'allSessions' -> { type: 'view', name: 'allSessions', params: {} }
 *   'allSessions/session/abc123' -> { type: 'view', name: 'session', id: 'abc123', params: { filter: 'allSessions' } }
 *   'settings/shortcuts' -> { type: 'view', name: 'shortcuts', params: {} }
 *   'action/new-session' -> { type: 'action', name: 'new-session', params: {} }
 */
export function parseRoute(route: string): ParsedRoute | null {
  try {
    // Check if this is a compound route (preferred format)
    if (isCompoundRoute(route)) {
      const compound = parseCompoundRoute(route)
      if (compound) {
        return convertCompoundToViewRoute(compound)
      }
    }

    // Parse action routes: action/{name}[/{id}]
    const [pathPart, queryPart] = route.split('?')
    const segments = pathPart.split('/').filter(Boolean)

    if (segments.length < 2) {
      return null
    }

    const type = segments[0]
    if (type !== 'action') {
      return null
    }

    const name = segments[1]
    const id = segments[2]

    // Parse query params
    const params: Record<string, string> = {}
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart)
      searchParams.forEach((value, key) => {
        params[key] = value
      })
    }

    return { type: 'action', name, id, params }
  } catch {
    return null
  }
}

/**
 * Convert a parsed compound route to ParsedRoute format (type: 'view')
 */
function convertCompoundToViewRoute(compound: ParsedCompoundRoute): ParsedRoute {
  // Settings
  if (compound.navigator === 'settings') {
    const subpage = compound.details?.type || 'app'
    if (subpage === 'app') {
      return { type: 'view', name: 'settings', params: {} }
    }
    return { type: 'view', name: subpage, params: {} }
  }

  // Sources
  if (compound.navigator === 'sources') {
    if (!compound.details) {
      return { type: 'view', name: 'sources', params: {} }
    }
    return { type: 'view', name: 'source-info', id: compound.details.id, params: {} }
  }

  // Skills
  if (compound.navigator === 'skills') {
    if (!compound.details) {
      return { type: 'view', name: 'skills', params: {} }
    }
    return { type: 'view', name: 'skill-info', id: compound.details.id, params: {} }
  }

  // Automations
  if (compound.navigator === 'automations') {
    if (!compound.details) {
      return { type: 'view', name: 'automations', params: {} }
    }
    return { type: 'view', name: 'automation-info', id: compound.details.id, params: {} }
  }

  // Projects
  if (compound.navigator === 'projects') {
    if (!compound.details) {
      return { type: 'view', name: 'projects', params: {} }
    }
    return { type: 'view', name: 'project-info', id: compound.details.id, params: {} }
  }

  // Mission OS / Control Room
  if (compound.navigator === 'missions') {
    if (!compound.details) {
      return { type: 'view', name: 'missions', params: {} }
    }
    return { type: 'view', name: 'mission-info', id: compound.details.id, params: {} }
  }

  // Sessions
  if (compound.sessionFilter) {
    const filter = compound.sessionFilter
    if (compound.details) {
      return {
        type: 'view',
        name: 'session',
        id: compound.details.id,
        params: {
          filter: filter.kind,
          ...(filter.kind === 'state' ? { stateId: filter.stateId } : {}),
          ...(filter.kind === 'label' ? { labelId: filter.labelId } : {}),
          ...(filter.kind === 'view' ? { viewId: filter.viewId } : {}),
        },
      }
    }
    return {
      type: 'view',
      name: filter.kind,
      id: filter.kind === 'state' ? filter.stateId : (filter.kind === 'label' ? filter.labelId : (filter.kind === 'view' ? filter.viewId : undefined)),
      params: {},
    }
  }

  return { type: 'view', name: 'allSessions', params: {} }
}
