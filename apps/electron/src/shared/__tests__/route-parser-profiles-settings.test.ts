import { describe, expect, it } from 'bun:test'

import { buildRouteFromNavigationState, parseCompoundRoute, parseRouteToNavigationState } from '../route-parser'
import { routes } from '../routes'
import { isSettingsNavigation } from '../types'

describe('route-parser: specialized profiles settings route', () => {
  it('round-trips the profiles settings page', () => {
    const route = routes.view.settings('profiles')
    expect(route).toBe('settings/profiles')
    expect(parseCompoundRoute(route)).toEqual({
      navigator: 'settings',
      details: { type: 'profiles', id: 'profiles' },
    })

    const state = parseRouteToNavigationState(route)
    if (!state || !isSettingsNavigation(state)) throw new Error('expected settings navigation')
    expect(state.subpage).toBe('profiles')
    expect(buildRouteFromNavigationState(state)).toBe(route)
  })
})
