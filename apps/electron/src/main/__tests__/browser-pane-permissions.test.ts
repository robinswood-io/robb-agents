import { describe, expect, test } from 'bun:test'
import { isBrowserPanePermissionAllowed } from '../browser-pane-permissions'

describe('browser pane permission policy', () => {
  test('allows only low-risk interaction permissions', () => {
    expect(isBrowserPanePermissionAllowed('fullscreen')).toBe(true)
    expect(isBrowserPanePermissionAllowed('pointerLock')).toBe(true)
  })

  test.each([
    'clipboard-read',
    'clipboard-sanitized-write',
    'display-capture',
    'geolocation',
    'idle-detection',
    'media',
    'notifications',
    'openExternal',
    'storage-access',
    'window-management',
  ])('denies sensitive permission %s by default', (permission) => {
    expect(isBrowserPanePermissionAllowed(permission)).toBe(false)
  })
})
