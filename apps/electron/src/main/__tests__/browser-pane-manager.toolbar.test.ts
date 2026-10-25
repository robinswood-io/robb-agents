import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { browserFixture, createBrowserPaneTestManager, getTestBrowserInstance } from './fixtures/browser-pane-fixture'

describe('BrowserPaneManager', () => {
let manager: ReturnType<typeof createBrowserPaneTestManager>
beforeEach(() => { manager = createBrowserPaneTestManager() })
it('retries toolbar load and recovers', async () => {
    browserFixture.toolbarLoadFailuresRemaining = 2
    manager.createInstance('retry-toolbar')

    await Bun.sleep(1400)

    const instance = getTestBrowserInstance(manager, 'retry-toolbar')
    if (!instance) throw new Error('retry-toolbar instance was not created')
    const toolbarWebContents = instance.toolbarView.webContents
    const fileAttempts = toolbarWebContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWebContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(3)
    expect(toolbarWebContents.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

it('stops toolbar retries when the instance is destroyed during its initial load', async () => {
    browserFixture.toolbarLoadFailuresRemaining = 20
    manager.createInstance('destroy-during-toolbar-load')
    const instance = getTestBrowserInstance(manager, 'destroy-during-toolbar-load')

    manager.destroyInstance('destroy-during-toolbar-load')
    await Bun.sleep(600)

    const fileAttempts = instance.toolbarView.webContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = instance.toolbarView.webContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length

    expect(fileAttempts + toolbarUrlAttempts).toBe(1)
    expect(instance.toolbarView.webContents.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
    expect(instance.toolbarReady).toBe(false)
  })

it('loads toolbar fallback page after retry exhaustion', async () => {
    browserFixture.toolbarLoadFailuresRemaining = 20
    manager.createInstance('fallback-toolbar')

    await Bun.sleep(3200)

    const instance = getTestBrowserInstance(manager, 'fallback-toolbar')
    if (!instance) throw new Error('fallback-toolbar instance was not created')
    const toolbarWebContents = instance.toolbarView.webContents
    const fileAttempts = toolbarWebContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWebContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(5)
    expect(toolbarWebContents.loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

it('captures and filters console entries', () => {
    manager.createInstance('console-1')
    const instance = getTestBrowserInstance(manager, 'console-1')

    instance.pageView.webContents._emit('console-message', 2, 'warn message')
    instance.pageView.webContents._emit('console-message', 3, 'error message')

    const allEntries = manager.getConsoleLogs('console-1', { level: 'all', limit: 10 })
    expect(allEntries).toHaveLength(2)

    const warnEntries = manager.getConsoleLogs('console-1', { level: 'warn', limit: 10 })
    expect(warnEntries).toHaveLength(1)
    expect(warnEntries[0].message).toBe('warn message')
  })

it('redacts OAuth callback artifacts before retaining browser console entries', () => {
    manager.createInstance('console-oauth')
    const instance = getTestBrowserInstance(manager, 'console-oauth')
    const authorizationCode = 'authorization-code-value'
    const oauthState = 'oauth-state-value'
    const clientInfo = 'client-identity-value'
    const message = `navigation failed: https://login.example.test/callback#code=${authorizationCode}&state=${oauthState}&client_info=${clientInfo}`

    instance.pageView.webContents._emit('console-message', 3, message)

    const [entry] = manager.getConsoleLogs('console-oauth', { level: 'all', limit: 10 })
    expect(entry.message).toContain('code=[REDACTED]')
    expect(entry.message).toContain('state=[REDACTED]')
    expect(entry.message).toContain('client_info=[REDACTED]')
    expect(entry.message).not.toContain(authorizationCode)
    expect(entry.message).not.toContain(oauthState)
    expect(entry.message).not.toContain(clientInfo)
  })

it('applies observer theme signal and skips regular console logging for it', () => {
    manager.createInstance('theme-signal')
    const instance = getTestBrowserInstance(manager, 'theme-signal')
    instance.themeObserverToken = 'tok-1'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-1:#123456')

    expect(manager.listInstances().find(i => i.id === 'theme-signal')?.themeColor).toBe('#123456')
    expect(manager.getConsoleLogs('theme-signal', { level: 'all', limit: 10 })).toHaveLength(0)
  })

it('dedupes repeated observer theme signals', () => {
    manager.createInstance('theme-dedupe')
    const instance = getTestBrowserInstance(manager, 'theme-dedupe')
    instance.themeObserverToken = 'tok-2'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterFirst = instance.window.webContents.send.mock.calls.length

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterSecond = instance.window.webContents.send.mock.calls.length

    expect(sendCallsAfterSecond).toBe(sendCallsAfterFirst)
  })

it('ignores observer theme signals from stale token', () => {
    manager.createInstance('theme-stale-token')
    const instance = getTestBrowserInstance(manager, 'theme-stale-token')
    instance.themeObserverToken = 'tok-current'
    instance.themeColor = '#aaaaaa'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-old:#bbccdd')

    expect(manager.listInstances().find(i => i.id === 'theme-stale-token')?.themeColor).toBe('#aaaaaa')
  })

it('clears theme on explicit null sentinel signal', () => {
    manager.createInstance('theme-null')
    const instance = getTestBrowserInstance(manager, 'theme-null')
    instance.themeObserverToken = 'tok-null'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:#223344')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBe('#223344')

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:__NULL__')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBeNull()
  })

it('replays toolbar state with theme color when window is shown', () => {
    manager.createInstance('theme-show-replay')
    const instance = getTestBrowserInstance(manager, 'theme-show-replay')

    instance.currentUrl = 'https://example.com'
    instance.title = 'Example'
    instance.canGoBack = true
    instance.canGoForward = false
    instance.themeColor = '#123456'

    const sendsBeforeShow = instance.toolbarView.webContents.send.mock.calls.length
    instance.window._emit('show')

    const sendCallsAfterShow = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeShow)
    expect(sendCallsAfterShow).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://example.com',
        title: 'Example',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        themeColor: '#123456',
      },
    ])
  })

it('replays full toolbar state when toolbar renderer finishes loading', () => {
    browserFixture.toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-finish-load-replay')
    const instance = getTestBrowserInstance(manager, 'toolbar-finish-load-replay')

    instance.currentUrl = 'https://craft.do'
    instance.title = 'Craft'
    instance.isLoading = true
    instance.canGoBack = true
    instance.canGoForward = true
    instance.themeColor = '#654321'

    instance.toolbarView.webContents.getURL = mock(() => 'http://localhost:5173/browser-toolbar.html?instanceId=toolbar-finish-load-replay')

    const sendsBeforeFinishLoad = instance.toolbarView.webContents.send.mock.calls.length
    instance.toolbarView.webContents._emit('did-finish-load')

    const sendCallsAfterFinishLoad = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeFinishLoad)
    expect(sendCallsAfterFinishLoad).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://craft.do',
        title: 'Craft',
        isLoading: true,
        canGoBack: true,
        canGoForward: true,
        themeColor: '#654321',
      },
    ])
  })

it('does not mark toolbar ready for about:blank did-finish-load', () => {
    browserFixture.toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-ignore-about-blank')
    const instance = getTestBrowserInstance(manager, 'toolbar-ignore-about-blank')

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(false)
  })

it('marks toolbar ready for fallback data page did-finish-load', () => {
    browserFixture.toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-fallback-ready')
    const instance = getTestBrowserInstance(manager, 'toolbar-fallback-ready')

    instance.toolbarView.webContents.getURL = mock(() => 'data:text/html;charset=UTF-8,%3Chtml%3E%3C%2Fhtml%3E')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
  })

it('keeps focus deferred until a valid toolbar document loads', () => {
    browserFixture.toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-focus-guard')
    const instance = getTestBrowserInstance(manager, 'toolbar-focus-guard')

    manager.focus('toolbar-focus-guard')
    expect(instance.pendingShowOnReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
  })

it('runs early theme extraction shortly after navigation', async () => {
    manager.createInstance('theme-early')
    const instance = getTestBrowserInstance(manager, 'theme-early')
    instance.pageView.webContents.executeJavaScript = mock(async () => '#0f1e2d')

    instance.pageView.webContents._emit('did-navigate', 'https://example.com')

    await Bun.sleep(140)

    expect(manager.listInstances().find(i => i.id === 'theme-early')?.themeColor).toBe('#0f1e2d')
  })

it('clears pending in-page theme timer on full navigation', async () => {
    manager.createInstance('theme-timer-clear')
    const instance = getTestBrowserInstance(manager, 'theme-timer-clear')

    instance.pageView.webContents._emit('did-navigate-in-page', 'https://example.com/route-a')
    await Bun.sleep(0)
    expect(instance.inPageThemeTimer).not.toBeNull()

    instance.pageView.webContents._emit('did-navigate', 'https://example.com/full-nav')
    expect(instance.inPageThemeTimer).toBeNull()
  })
})
