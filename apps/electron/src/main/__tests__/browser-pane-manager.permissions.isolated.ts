import { beforeEach, describe, expect, it } from 'bun:test'
import { browserFixture, createBrowserPaneTestManager, getTestBrowserInstance, mockIpcMainHandle, mockNativeTheme } from './fixtures/browser-pane-fixture'

describe('BrowserPaneManager', () => {
let manager: ReturnType<typeof createBrowserPaneTestManager>
beforeEach(() => { manager = createBrowserPaneTestManager() })
it('composes page, overlay, and toolbar as ordered WebContentsView children', () => {
    manager.createInstance('web-contents-views')
    const instance = getTestBrowserInstance(manager, 'web-contents-views')

    expect(instance.window.contentView.children).toHaveLength(3)
    expect(instance.window.contentView.children[0]).toBe(instance.pageView)
    expect(instance.window.contentView.children[1]).toBe(instance.nativeOverlayView)
    expect(instance.window.contentView.children[2]).toBe(instance.toolbarView)

    instance.window._emit('resize')
    expect(instance.pageView.setBounds).toHaveBeenCalled()
    expect(instance.nativeOverlayView.setBounds).toHaveBeenCalled()
    expect(instance.toolbarView.setBounds).toHaveBeenCalled()
    expect(instance.window.contentView.children[2]).toBe(instance.toolbarView)
  })

it('sets native view transparency in both themes instead of relying on page CSS', () => {
    for (const [dark, pageBackground] of [[false, '#fafafb'], [true, '#2b292e']] as const) {
      mockNativeTheme.shouldUseDarkColors = dark
      const id = manager.createInstance(`native-background-${dark}`)
      const instance = getTestBrowserInstance(manager, id)
      // Electron exposes background color on View, never on WebContents.
      expect(instance.toolbarView.webContents).not.toHaveProperty('setBackgroundColor')
      expect(instance.nativeOverlayView.webContents).not.toHaveProperty('setBackgroundColor')
      expect(instance.pageView.setBackgroundColor).toHaveBeenCalledWith(pageBackground)
      expect(instance.toolbarView.setBackgroundColor).toHaveBeenCalledWith('#00000000')
      expect(instance.nativeOverlayView.setBackgroundColor).toHaveBeenCalledWith('#00000000')
    }
  })

it('keeps the page beneath transparent full-window toolbar and menu overlay views', async () => {
    const id = manager.createInstance('transparent-menu')
    await Promise.resolve()
    const instance = getTestBrowserInstance(manager, id)
    manager.registerToolbarIpc()
    const registration = (
      mockIpcMainHandle.mock.calls as Array<[
        string, (event: unknown, instanceId: string, open: boolean, height?: number) => Promise<void>,
      ]>
    ).find(([channel]) => channel === 'browser-toolbar:menu-geometry')
    if (!registration) throw new Error('Missing menu geometry handler')
    const [, setMenuGeometry] = registration
    await setMenuGeometry({}, id, true, 120)
    expect(instance.toolbarView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 900 })
    expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 48, width: 1200, height: 852 })
    expect(instance.toolbarView.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    expect(instance.nativeOverlayView.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    expect(instance.window.contentView.children).toEqual([instance.pageView, instance.nativeOverlayView, instance.toolbarView])
    await setMenuGeometry({}, id, false)
    expect(instance.toolbarView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 48 })
    expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  })

it('grants scoped browser permissions only with live autonomous session context', async () => {
    const instanceId = manager.createForSession('session-autonomous', { workspaceId: 'workspace-autonomous' })
    const instance = getTestBrowserInstance(manager, instanceId)
    await manager.navigate(instanceId, 'https://signup.microsoft.com/account')
    instance.pageView.webContents._emit('did-navigate', 'https://signup.microsoft.com/account')
    manager.setAgentControl('session-autonomous', {}, { workspaceId: 'workspace-autonomous' })
    manager.setPermissionAutonomyResolver(() => ({
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
    }))

    expect(manager.getPermissionContext(
      manager['instances'].get(instanceId)!.pageView.webContents,
      'https://microsoft-api.arkoselabs.com/',
    )).toEqual({
      agentControlled: true,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      requestingOrigin: 'https://microsoft-api.arkoselabs.com/',
      topLevelUrl: 'https://signup.microsoft.com/account',
    })
    expect(browserFixture.mockPermissionCheckHandler).not.toBeNull()
    expect(browserFixture.mockPermissionCheckHandler!(
      instance.pageView.webContents,
      'sensors',
      'https://microsoft-api.arkoselabs.com/',
      {},
    )).toBe(true)

    let requestDecision: boolean | undefined
    browserFixture.mockPermissionRequestHandler!(
      instance.pageView.webContents,
      'media',
      (allowed: boolean) => { requestDecision = allowed },
      { requestingUrl: 'https://microsoft-api.arkoselabs.com/challenge' },
    )
    expect(requestDecision).toBe(true)
  })

it('keeps browser permissions denied when the live session is not autonomous', async () => {
    const instanceId = manager.createForSession('session-ask', { workspaceId: 'workspace-ask' })
    const instance = getTestBrowserInstance(manager, instanceId)
    await manager.navigate(instanceId, 'https://example.com/')
    instance.pageView.webContents._emit('did-navigate', 'https://example.com/')
    manager.setAgentControl('session-ask', {}, { workspaceId: 'workspace-ask' })
    manager.setPermissionAutonomyResolver(() => ({
      permissionMode: 'ask',
      externalActionPolicy: 'allow-in-execute',
    }))

    expect(browserFixture.mockPermissionCheckHandler!(
      instance.pageView.webContents,
      'geolocation',
      'https://example.com/',
      {},
    )).toBe(false)
  })
})
