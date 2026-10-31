import { requiredTestValue } from '@craft-agent/shared/testing/fixture-values';
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { browserFixture, createBrowserPaneTestManager, createMockWindow, getTestBrowserInstance, mockDialogShowMessageBox, mockIpcMainHandle, mockSessionListeners, mockShellOpenExternal } from './fixtures/browser-pane-fixture'

describe('BrowserPaneManager', () => {
let manager: ReturnType<typeof createBrowserPaneTestManager>
beforeEach(() => { manager = createBrowserPaneTestManager() })
it('creates and lists instances', () => {
    const id = manager.createInstance('test-1')
    const list = manager.listInstances()
    expect(id).toBe('test-1')
    expect(list).toHaveLength(1)
    expect(requiredTestValue(list[0]).id).toBe('test-1')
    expect(requiredTestValue(list[0]).agentControlActive).toBe(false)
  })

it('is idempotent when explicit ID already exists', () => {
    const first = manager.createInstance('same-id')
    const second = manager.createInstance('same-id')
    expect(first).toBe('same-id')
    expect(second).toBe('same-id')
    expect(manager.listInstances()).toHaveLength(1)
  })

it('does not replace an immediate navigation when the empty state load is aborted', async () => {
    browserFixture.emptyStateLoadError = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://example.com/'"), {
      code: 'ERR_ABORTED',
      errno: -3,
    })

    manager.createInstance('empty-state-aborted')
    await Bun.sleep(0)

    const instance = getTestBrowserInstance(manager, 'empty-state-aborted')
    const loadedUrls = instance.pageView.webContents.loadURL.mock.calls.map((call: [string]) => call[0])
    expect(loadedUrls).not.toContain('about:blank')
  })

it('allows http(s) popups with shared browser partition', () => {
    manager.createInstance('popup-allow')
    const instance = getTestBrowserInstance(manager, 'popup-allow')
    const openHandler = requiredTestValue(instance.pageView.webContents.setWindowOpenHandler.mock.calls[0])[0]

    const result = openHandler({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      disposition: 'new-window',
      frameName: 'oauth-popup',
    })

    expect(result.action).toBe('allow')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.partition).toBe('persist:browser-pane')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.nodeIntegration).toBe(false)
    expect(result.overrideBrowserWindowOptions?.webPreferences?.contextIsolation).toBe(true)
  })

it('prompts the user when WebAuthn returns multiple discoverable accounts', async () => {
    manager.createInstance('passkey-select')
    const listener = mockSessionListeners['select-webauthn-account']?.[0]
    let resolveSelection!: (credentialId: string | undefined) => void
    const selection = new Promise<string | undefined>((resolve) => {
      resolveSelection = resolve
    })
    const callback = mock((credentialId?: string) => resolveSelection(credentialId))
    expect(listener).toBeDefined()

    requiredTestValue(listener)({}, {
      relyingPartyId: 'example.com',
      accounts: [
        { credentialId: 'credential-1', name: 'alice@example.com', displayName: 'Alice' },
        { credentialId: 'credential-2', name: 'bob@example.com', displayName: 'Bob' },
      ],
      frame: null,
    }, callback)
    const credentialId = await selection

    expect(credentialId).toBe('credential-1')
  })

it('cancels WebAuthn account selection when the native dialog is dismissed', async () => {
    mockDialogShowMessageBox.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    manager.createInstance('passkey-cancel')
    const listener = mockSessionListeners['select-webauthn-account']?.[0]
    let resolveSelection!: (credentialId: string | undefined) => void
    const selection = new Promise<string | undefined>((resolve) => {
      resolveSelection = resolve
    })
    const callback = mock((credentialId?: string) => resolveSelection(credentialId))

    requiredTestValue(listener)({}, {
      relyingPartyId: 'example.com',
      accounts: [
        { credentialId: 'credential-1', name: 'alice@example.com' },
        { credentialId: 'credential-2', name: 'bob@example.com' },
      ],
      frame: null,
    }, callback)
    const credentialId = await selection

    expect(credentialId).toBeUndefined()
  })

it('denies app deep-link popups and forwards to deep-link handler', async () => {
    manager.createInstance('popup-deeplink')
    const instance = getTestBrowserInstance(manager, 'popup-deeplink')
    const openHandler = requiredTestValue(instance.pageView.webContents.setWindowOpenHandler.mock.calls[0])[0]

    const result = openHandler({
      url: 'craftagents://settings',
      disposition: 'new-window',
      frameName: '',
    })

    expect(result).toEqual({ action: 'deny' })
    await Bun.sleep(0)
    expect(mockShellOpenExternal).toHaveBeenCalledWith('craftagents://settings')
  })

it('destroys child popups when parent instance is destroyed', () => {
    manager.createInstance('popup-parent')
    const instance = getTestBrowserInstance(manager, 'popup-parent')

    const popupWindow = createMockWindow({ width: 520, height: 720 })
    instance.pageView.webContents._emit('did-create-window', popupWindow, { url: 'https://accounts.google.com/signin' })

    expect(manager.popupWindowsByParentInstanceId.get('popup-parent')?.size).toBe(1)

    manager.destroyInstance('popup-parent')

    expect(popupWindow.destroy).toHaveBeenCalledTimes(1)
    expect(manager.popupWindowsByParentInstanceId.has('popup-parent')).toBe(false)
  })

it('unregisters a popup after Electron destroys its webContents wrapper', () => {
    manager.createInstance('popup-destroyed-webcontents')
    const instance = getTestBrowserInstance(manager, 'popup-destroyed-webcontents')
    const popupWindow = createMockWindow({ width: 520, height: 720 })

    instance.pageView.webContents._emit('did-create-window', popupWindow, { url: 'https://accounts.google.com/signin' })
    Object.defineProperty(popupWindow.webContents, 'id', {
      configurable: true,
      get: () => { throw new TypeError('Object has been destroyed') },
    })

    expect(() => popupWindow._emit('closed')).not.toThrow()
    expect(manager.popupWindowsByParentInstanceId.has('popup-destroyed-webcontents')).toBe(false)
  })

it('destroys instances', () => {
    manager.createInstance('d1')
    manager.destroyInstance('d1')
    expect(manager.listInstances()).toHaveLength(0)
  })

it('destroys all instances even when Electron has already removed a native webContents wrapper', () => {
    manager.createInstance('native-already-destroyed')
    manager.createInstance('still-alive')
    const instance = getTestBrowserInstance(manager, 'native-already-destroyed')
    const wcId = instance.pageWebContentsId
    Object.defineProperty(instance.pageView, 'webContents', { configurable: true, get: () => undefined })
    expect(() => manager['getInstanceByWebContentsId'](wcId)).not.toThrow()
    expect(() => manager.destroyAll()).not.toThrow()
    expect(manager.listInstances()).toHaveLength(0)
    expect(() => manager.destroyAll()).not.toThrow()
  })

it('destroys instance via toolbar destroy IPC handler', async () => {
    manager.createInstance('d-ipc-destroy')
    manager.registerToolbarIpc()

    const destroyRegistration = (
      mockIpcMainHandle.mock.calls as Array<[
        string,
        (_event: unknown, instanceId: string) => Promise<void>,
      ]>
    ).find(([channel]) => channel === 'browser-toolbar:destroy')

    expect(destroyRegistration).toBeTruthy()
    if (!destroyRegistration) throw new Error('Expected browser-toolbar:destroy IPC registration')

    const [, destroyHandler] = destroyRegistration
    await destroyHandler({}, 'd-ipc-destroy')

    expect(manager.listInstances()).toHaveLength(0)
  })

it('emits removed callback exactly once when destroy triggers closed', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))

    manager.createInstance('d-removed-once')
    manager.destroyInstance('d-removed-once')

    expect(removed).toEqual(['d-removed-once'])
    expect(manager.listInstances()).toHaveLength(0)
  })

it('ignores late state events after instance was removed', () => {
    const states: string[] = []
    manager.onStateChange((info) => states.push(info.id))

    manager.createInstance('d-late-state')
    const instance = getTestBrowserInstance(manager, 'd-late-state')
    states.length = 0

    manager.destroyInstance('d-late-state')
    const countAfterDestroy = states.length

    instance.window._emit('hide')
    instance.window._emit('show')

    expect(states.length).toBe(countAfterDestroy)
  })

it('binds and unbinds sessions', () => {
    manager.createInstance('b1')
    manager.bindSession('b1', 'session-abc')
    expect(requiredTestValue(manager.listInstances()[0]).boundSessionId).toBe('session-abc')
    expect(requiredTestValue(manager.listInstances()[0]).ownerType).toBe('session')

    manager.unbindSession('b1')
    expect(requiredTestValue(manager.listInstances()[0]).boundSessionId).toBeNull()
    expect(requiredTestValue(manager.listInstances()[0]).ownerType).toBe('manual')
  })

it('createForSession returns canonical bound instance', () => {
    const id1 = manager.createForSession('sess-1')
    const id2 = manager.createForSession('sess-1')
    const info = manager.listInstances()[0]

    expect(id1).toBe(id2)
    expect(requiredTestValue(info).ownerType).toBe('session')
    expect(requiredTestValue(info).ownerSessionId).toBe('sess-1')
    expect(manager.listInstances()).toHaveLength(1)
  })

it('getOrCreateForSession reuses existing instance', () => {
    const id1 = manager.getOrCreateForSession('sess-1')
    const id2 = manager.getOrCreateForSession('sess-1')
    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
  })

it('createForSession reuses an unbound manual window before creating new', () => {
    manager.createInstance('manual-1')

    const id = manager.createForSession('sess-reuse')

    expect(id).toBe('manual-1')
    const info = manager.listInstances()[0]
    expect(requiredTestValue(info).ownerType).toBe('session')
    expect(requiredTestValue(info).ownerSessionId).toBe('sess-reuse')
    expect(requiredTestValue(info).boundSessionId).toBe('sess-reuse')
    expect(manager.listInstances()).toHaveLength(1)
  })

it('focus brings the instance window to front', () => {
    manager.createInstance('f1')
    manager.focus('f1')

    const instance = getTestBrowserInstance(manager, 'f1')
    instance.window._emit('ready-to-show')

    expect(instance.window.show).toHaveBeenCalled()
    expect(instance.window.focus).toHaveBeenCalled()
  })

it('dedupes repeated focus calls before ready-to-show', () => {
    manager.createInstance('f2')

    manager.focus('f2')
    manager.focus('f2')
    manager.focus('f2')

    const instance = getTestBrowserInstance(manager, 'f2')
    instance.window._emit('ready-to-show')

    expect(instance.window.show.mock.calls.length).toBe(1)
    expect(instance.window.focus.mock.calls.length).toBe(1)
  })

it('cancels deferred pre-ready focus when hide happens first', () => {
    manager.createInstance('f-hide-race')

    manager.focus('f-hide-race')
    manager.hide('f-hide-race')

    const instance = getTestBrowserInstance(manager, 'f-hide-race')
    const showCallsBeforeReady = instance.window.show.mock.calls.length
    const focusCallsBeforeReady = instance.window.focus.mock.calls.length

    instance.window._emit('ready-to-show')

    expect(instance.window.show.mock.calls.length).toBe(showCallsBeforeReady)
    expect(instance.window.focus.mock.calls.length).toBe(focusCallsBeforeReady)
  })

it('user close hides window and keeps instance alive', () => {
    manager.createInstance('h1')
    const instance = getTestBrowserInstance(manager, 'h1')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(manager.listInstances()).toHaveLength(1)
    expect(requiredTestValue(manager.listInstances()[0]).isVisible).toBe(false)
  })

it('does not intercept close when destroy is explicit', () => {
    manager.createInstance('h-explicit-destroy')
    const instance = getTestBrowserInstance(manager, 'h-explicit-destroy')

    ;manager['destroyingIds'].add('h-explicit-destroy')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(instance.window.hide).not.toHaveBeenCalled()
  })

it('still destroys instance when cleanup throws', () => {
    manager.createInstance('destroy-cleanup-throw')
    const instance = getTestBrowserInstance(manager, 'destroy-cleanup-throw')

    ;manager['updateNativeOverlayState'] = () => {
      throw new Error('mock overlay cleanup failure')
    }

    expect(() => manager.destroyInstance('destroy-cleanup-throw')).not.toThrow()
    expect(instance.window.destroy).toHaveBeenCalledTimes(1)
    expect(manager.listInstances()).toHaveLength(0)
  })

it('emits removed callback when window closes', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('r1')

    const instance = getTestBrowserInstance(manager, 'r1')
    instance.window._emit('closed')

    expect(removed).toEqual(['r1'])
    expect(manager.listInstances()).toHaveLength(0)
  })

it('resizes browser window viewport and returns effective applied size', () => {
    manager.createInstance('resize-1')
    const resized = manager.windowResize('resize-1', 1280, 720)

    const instance = getTestBrowserInstance(manager, 'resize-1')
    expect(instance.window.setContentSize).toHaveBeenCalledWith(1280, 768)
    expect(resized).toEqual({ width: 1280, height: 720 })
  })

it('returns effective viewport size when min window constraints apply', () => {
    manager.createInstance('resize-min')
    const resized = manager.windowResize('resize-min', 200, 200)

    // BrowserWindow minHeight is 500, toolbar is 48, so effective viewport height is 452.
    expect(resized).toEqual({ width: 700, height: 452 })
  })
})
