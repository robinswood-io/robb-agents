import { buildRouteFromNavigationState, parseRouteToNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'
import type { NavigationState } from '../../shared/types'
import { getUserFacingSessionId, isUserFacingSession, type SessionVisibilityInput } from '../utils/session-visibility'

export type AutoSelectionResolver = (state: NavigationState) => NavigationState

/**
 * Keep direct/deep-link navigation on user-facing conversations. Internal
 * descendants resolve to their owning conversation; unresolved lineage loses
 * its detail segment so the hidden child can never become a chat panel.
 * Unknown sessions are preserved until their metadata hydrates.
 */
export function normalizeUserFacingSessionRoute(
  route: ViewRoute,
  sessions: ReadonlyMap<string, SessionVisibilityInput>,
): ViewRoute {
  const state = parseRouteToNavigationState(route)
  if (state?.navigator !== 'sessions' || !state.details) return route

  const requestedId = state.details.sessionId
  const requested = sessions.get(requestedId)
  if (!requested || isUserFacingSession(requested)) return route

  const targetId = getUserFacingSessionId(requestedId, sessions)
  const details = targetId
    ? { type: 'session' as const, sessionId: targetId }
    : null
  return buildRouteFromNavigationState({ ...state, details }) as ViewRoute
}

/** Restore user panels without reopening saved internal agent conversations. */
export function filterUserFacingSessionPanels<T extends { route: ViewRoute }>(
  entries: T[],
  focusedIndex: number,
  sessions: ReadonlyMap<string, SessionVisibilityInput>,
): { entries: T[]; focusedIndex: number } {
  const retained = entries.flatMap((entry, index) => {
    const state = parseRouteToNavigationState(entry.route)
    const session = state?.navigator === 'sessions' && state.details
      ? sessions.get(state.details.sessionId)
      : undefined
    return session && !isUserFacingSession(session) ? [] : [{ entry, index }]
  })
  const focused = retained.findIndex(item => item.index >= focusedIndex)
  return {
    entries: retained.map(item => item.entry),
    focusedIndex: focused >= 0 ? focused : Math.max(0, retained.length - 1),
  }
}

/**
 * Normalize a panel route during URL reconciliation.
 *
 * Ensures filter-only routes (e.g. `allSessions`) can be upgraded to
 * canonical detail routes (e.g. `allSessions/session/{id}`) via the same
 * auto-selection policy used by normal navigation.
 */
export function normalizePanelRouteForReconcile(
  route: ViewRoute,
  resolveAutoSelection: AutoSelectionResolver,
): ViewRoute {
  const navState = parseRouteToNavigationState(route)
  if (!navState) return route

  // Preserve explicit detail routes exactly as encoded in URL.
  // Reconciliation should only auto-select for filter/list routes.
  if ('details' in navState && navState.details) {
    return route
  }

  const resolved = resolveAutoSelection(navState)
  return buildRouteFromNavigationState(resolved) as ViewRoute
}
