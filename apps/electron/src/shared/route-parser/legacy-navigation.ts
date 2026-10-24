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
import type { NavigationState, SessionFilter } from "../types";
import type { ParsedRoute } from './route-types.ts';

/**
 * Convert a ParsedRoute (view type) to NavigationState
 */
export function convertParsedRouteToNavigationState(parsed: ParsedRoute): NavigationState | null {
  // Only handle view routes (compound routes converted to view type)
  if (parsed.type !== 'view') {
    return null
  }

  switch (parsed.name) {
    case 'settings':
      return { navigator: 'settings', subpage: 'app' }
    case 'workspace':
      return { navigator: 'settings', subpage: 'workspace' }
    case 'permissions':
      return { navigator: 'settings', subpage: 'permissions' }
    case 'labels':
      return { navigator: 'settings', subpage: 'labels' }
    case 'shortcuts':
      return { navigator: 'settings', subpage: 'shortcuts' }
    case 'preferences':
      return { navigator: 'settings', subpage: 'preferences' }
    case 'sources':
      return { navigator: 'sources', details: null }
    case 'source-info':
      if (parsed.id) {
        return {
          navigator: 'sources',
          details: {
            type: 'source',
            sourceSlug: parsed.id,
          },
        }
      }
      return { navigator: 'sources', details: null }
    case 'skills':
      return { navigator: 'skills', details: null }
    case 'skill-info':
      if (parsed.id) {
        return {
          navigator: 'skills',
          details: {
            type: 'skill',
            skillSlug: parsed.id,
          },
        }
      }
      return { navigator: 'skills', details: null }
    case 'automations':
      return { navigator: 'automations', details: null }
    case 'automation-info':
      if (parsed.id) {
        return {
          navigator: 'automations',
          details: {
            type: 'automation',
            automationId: parsed.id,
          },
        }
      }
      return { navigator: 'automations', details: null }
    case 'projects':
      return { navigator: 'projects', details: null }
    case 'project-info':
      if (parsed.id) {
        return {
          navigator: 'projects',
          details: { type: 'project', projectSlug: parsed.id },
        }
      }
      return { navigator: 'projects', details: null }
    case 'missions':
      return { navigator: 'missions', details: null }
    case 'mission-info':
      if (parsed.id) {
        return {
          navigator: 'missions',
          details: { type: 'mission', missionId: parsed.id },
        }
      }
      return { navigator: 'missions', details: null }
    case 'session':
      if (parsed.id) {
        // Reconstruct filter from params
        const filterKind = (parsed.params.filter || 'allSessions') as SessionFilter['kind']
        let filter: SessionFilter
        if (filterKind === 'state' && parsed.params.stateId) {
          filter = { kind: 'state', stateId: parsed.params.stateId }
        } else if (filterKind === 'label' && parsed.params.labelId) {
          filter = { kind: 'label', labelId: parsed.params.labelId }
        } else if (filterKind === 'view' && parsed.params.viewId) {
          filter = { kind: 'view', viewId: parsed.params.viewId }
        } else {
          filter = { kind: filterKind as 'allSessions' | 'flagged' | 'archived' }
        }
        return {
          navigator: 'sessions',
          filter,
          details: { type: 'session', sessionId: parsed.id },
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'allSessions':
      return {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: null,
      }
    case 'flagged':
      return {
        navigator: 'sessions',
        filter: { kind: 'flagged' },
        details: null,
      }
    case 'archived':
      return {
        navigator: 'sessions',
        filter: { kind: 'archived' },
        details: null,
      }
    case 'state':
      if (parsed.id) {
        return {
          navigator: 'sessions',
          filter: { kind: 'state', stateId: parsed.id },
          details: null,
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'label':
      if (parsed.id) {
        return {
          navigator: 'sessions',
          filter: { kind: 'label', labelId: parsed.id },
          details: null,
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'view':
      if (parsed.id) {
        return {
          navigator: 'sessions',
          filter: { kind: 'view', viewId: parsed.id },
          details: null,
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    default:
      return null
  }
}
