import { describe, expect, test } from 'bun:test'
import {
  isBrowserPanePermissionAllowed,
  isSecureBrowserPermissionOrigin,
  type BrowserPanePermissionContext,
} from '../browser-pane-permissions'

const autonomousContext: BrowserPanePermissionContext = {
  agentControlled: true,
  permissionMode: 'allow-all',
  externalActionPolicy: 'allow-in-execute',
  requestingOrigin: 'https://microsoft-api.arkoselabs.com/',
  topLevelUrl: 'https://signup.microsoft.com/account',
}

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

  test.each([
    'background-fetch',
    'geolocation',
    'media',
    'notifications',
    'persistent-storage',
    'sensors',
    'storage-access',
    'top-level-storage-access',
  ])('allows scoped web capability %s for an autonomous Execute session', (permission) => {
    expect(isBrowserPanePermissionAllowed(permission, autonomousContext)).toBe(true)
  })

  test.each([
    ['Ask mode', { permissionMode: 'ask' }],
    ['Safe mode', { permissionMode: 'safe' }],
    ['confirmation policy', { externalActionPolicy: 'confirm' }],
    ['manual browser', { agentControlled: false }],
    ['insecure requesting origin', { requestingOrigin: 'http://example.com' }],
    ['local requesting origin', { requestingOrigin: 'file:///tmp/page.html' }],
    ['opaque requesting origin', { requestingOrigin: '' }],
    ['insecure top-level page', { topLevelUrl: 'http://example.com' }],
  ])('denies autonomous media permission with %s', (_label, override) => {
    expect(isBrowserPanePermissionAllowed('media', {
      ...autonomousContext,
      ...override,
    })).toBe(false)
  })

  test.each([
    'clipboard-read',
    'display-capture',
    'fileSystem',
    'local-network-access',
    'payment-handler',
    'web-app-installation',
  ])('keeps unrelated high-risk permission %s denied in autonomous Execute', (permission) => {
    expect(isBrowserPanePermissionAllowed(permission, autonomousContext)).toBe(false)
  })
})

describe('secure browser permission origins', () => {
  test('accepts regular and third-party HTTPS origins', () => {
    expect(isSecureBrowserPermissionOrigin('https://example.com/path')).toBe(true)
    expect(isSecureBrowserPermissionOrigin('https://microsoft-api.arkoselabs.com/')).toBe(true)
  })

  test.each([
    '',
    'not a URL',
    'http://example.com',
    'file:///tmp/page.html',
    'data:text/html,hello',
    'https://user:secret@example.com',
  ])('rejects untrusted origin %s', (origin) => {
    expect(isSecureBrowserPermissionOrigin(origin)).toBe(false)
  })
})
