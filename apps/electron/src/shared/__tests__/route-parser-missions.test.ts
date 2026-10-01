import { describe, expect, it } from 'bun:test'
import {
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { routes } from '../routes'
import { getNavigationStateKey, isMissionsNavigation, parseNavigationStateKey } from '../types'

describe('route-parser: Mission OS routes', () => {
  it('parses the workspace portfolio route', () => {
    expect(parseCompoundRoute(routes.view.missions())).toEqual({
      navigator: 'missions',
      details: null,
    })
    const state = parseRouteToNavigationState('missions')
    expect(state && isMissionsNavigation(state)).toBe(true)
  })

  it('round-trips a selected mission deep link', () => {
    const route = routes.view.missions('mission-42')
    expect(route).toBe('missions/mission/mission-42')
    const state = parseRouteToNavigationState(route)
    if (!state || !isMissionsNavigation(state)) throw new Error('expected missions navigation')
    expect(state.details).toEqual({ type: 'mission', missionId: 'mission-42' })
    expect(buildRouteFromNavigationState(state)).toBe(route)
    expect(getNavigationStateKey(state)).toBe(route)
    expect(parseNavigationStateKey(route)).toEqual(state)
  })

  it('converts the compound route for the generic navigate dispatcher', () => {
    expect(parseRoute('missions')).toEqual({ type: 'view', name: 'missions', params: {} })
    expect(parseRoute('missions/mission/mission-42')).toEqual({
      type: 'view',
      name: 'mission-info',
      id: 'mission-42',
      params: {},
    })
  })

  it('rejects malformed mission detail routes', () => {
    expect(parseCompoundRoute('missions/mission')).toBeNull()
    expect(parseCompoundRoute('missions/unknown/mission-42')).toBeNull()
  })
})
