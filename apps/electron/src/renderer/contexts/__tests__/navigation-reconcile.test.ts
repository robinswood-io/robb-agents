import { describe, expect, it } from 'bun:test'
import { filterUserFacingSessionPanels, normalizePanelRouteForReconcile, normalizeUserFacingSessionRoute } from '../navigation-reconcile'
import type { ViewRoute } from '../../../shared/routes'
import type { NavigationState } from '../../../shared/types'

describe('filterUserFacingSessionPanels', () => {
  const entries = [
    { route: 'allSessions/session/child' as ViewRoute, proportion: 0.25 },
    { route: 'allSessions/session/user' as ViewRoute, proportion: 0.25 },
    { route: 'allSessions/session/branch' as ViewRoute, proportion: 0.25 },
    { route: 'settings' as ViewRoute, proportion: 0.25 },
  ]
  const sessions = new Map([
    ['child', { id: 'child', parentSessionId: 'missing-parent' }],
    ['user', { id: 'user' }],
    ['branch', { id: 'branch', branchFromSessionId: 'user', branchFromMessageId: 'message' }],
  ])

  it('restores user branches and other panels while removing delegated conversations', () => {
    const result = filterUserFacingSessionPanels(entries, 2, sessions)
    expect(result.entries).toEqual(entries.slice(1))
    expect(result.entries[result.focusedIndex]?.route).toBe('allSessions/session/branch')
    expect(entries).toHaveLength(4)
    expect(sessions.has('child')).toBe(true)
  })

  it('selects the next user panel when the saved focused panel was internal', () => {
    const result = filterUserFacingSessionPanels(entries, 0, sessions)
    expect(result.focusedIndex).toBe(0)
    expect(result.entries[0]?.route).toBe('allSessions/session/user')
  })

  it('leaves no restored agent panel when all saved conversations are internal', () => {
    expect(filterUserFacingSessionPanels(entries.slice(0, 1), 0, sessions)).toEqual({
      entries: [],
      focusedIndex: 0,
    })
  })

  it('preserves unknown sessions until metadata is available', () => {
    expect(filterUserFacingSessionPanels(entries, 2, new Map()).entries).toEqual(entries)
  })
})

describe('normalizeUserFacingSessionRoute', () => {
  const sessions = new Map([
    ['root', { id: 'root' }],
    ['child', { id: 'child', parentSessionId: 'root' }],
    ['delegation-only', { id: 'delegation-only', delegation: { rootSessionId: 'root' } }],
    ['branch', { id: 'branch', branchFromSessionId: 'root', branchFromMessageId: 'message' }],
    ['orphan', { id: 'orphan', parentSessionId: 'missing' }],
    ['cycle-a', { id: 'cycle-a', parentSessionId: 'cycle-b' }],
    ['cycle-b', { id: 'cycle-b', parentSessionId: 'cycle-a' }],
  ])

  it('keeps roots and manual branches as independent conversations', () => {
    expect(normalizeUserFacingSessionRoute('allSessions/session/root', sessions)).toBe('allSessions/session/root')
    expect(normalizeUserFacingSessionRoute('allSessions/session/branch', sessions)).toBe('allSessions/session/branch')
  })

  it('routes direct and late-hydrated delegated children to their user conversation', () => {
    expect(normalizeUserFacingSessionRoute('flagged/session/child', sessions)).toBe('flagged/session/root')
    expect(normalizeUserFacingSessionRoute('allSessions/session/delegation-only', sessions)).toBe('allSessions/session/root')
  })

  it('removes unresolved internal details without exposing the child', () => {
    expect(normalizeUserFacingSessionRoute('allSessions/session/orphan', sessions)).toBe('allSessions')
    expect(normalizeUserFacingSessionRoute('flagged/session/cycle-a', sessions)).toBe('flagged')
  })

  it('preserves unknown session and non-session routes until metadata is available', () => {
    expect(normalizeUserFacingSessionRoute('allSessions/session/not-hydrated', sessions)).toBe('allSessions/session/not-hydrated')
    expect(normalizeUserFacingSessionRoute('settings', sessions)).toBe('settings')
  })
})

describe('normalizePanelRouteForReconcile', () => {
  it('auto-selects session details for filter-only session routes', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions/session/s1')
  })

  it('keeps explicit session details unchanged', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions/session/s2', resolver)
    expect(normalized).toBe('allSessions/session/s2')
  })

  it('normalizes each session panel route independently', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        const sessionId = state.filter.kind === 'flagged' ? 'flagged-1' : 'all-1'
        return {
          ...state,
          details: { type: 'session', sessionId },
        }
      }
      return state
    }

    const routes = ['allSessions', 'flagged'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/all-1', 'flagged/session/flagged-1'])
  })

  it('keeps route unchanged when resolver leaves state without details', () => {
    const resolver = (state: NavigationState): NavigationState => state

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions')
  })

  it('keeps non-session routes unchanged with session-only resolver', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('settings', resolver)).toBe('settings')
    expect(normalizePanelRouteForReconcile('sources', resolver)).toBe('sources')
  })

  it('keeps explicit detail route even if resolver tries to rewrite it', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if ('details' in state) {
        if (state.navigator === 'sessions') {
          return { ...state, details: { type: 'session', sessionId: 'rewritten' } }
        }
        if (state.navigator === 'sources') {
          return { ...state, details: { type: 'source', sourceSlug: 'rewritten' } }
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('allSessions/session/s2', resolver)).toBe('allSessions/session/s2')
    expect(normalizePanelRouteForReconcile('sources/source/github', resolver)).toBe('sources/source/github')
  })

  it('keeps explicit detail routes distinct across multiple panels', () => {
    const resolver = (_state: NavigationState): NavigationState => {
      return {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: { type: 'session', sessionId: 'same' },
      }
    }

    const routes = ['allSessions/session/left', 'allSessions/session/right'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/left', 'allSessions/session/right'])
  })
})
