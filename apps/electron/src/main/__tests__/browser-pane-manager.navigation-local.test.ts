import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createBrowserPaneTestManager, getTestBrowserInstance } from './fixtures/browser-pane-fixture'

describe('BrowserPaneManager', () => {
let manager: ReturnType<typeof createBrowserPaneTestManager>
beforeEach(() => { manager = createBrowserPaneTestManager() })
it('navigate normalizes hostnames to https', async () => {
    manager.createInstance('nav-1')
    await manager.navigate('nav-1', 'example.com')
    const instance = getTestBrowserInstance(manager, 'nav-1')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
  })

it('navigate treats plain text as search query', async () => {
    manager.createInstance('nav-2')
    await manager.navigate('nav-2', 'craft agents browser tools')
    const instance = getTestBrowserInstance(manager, 'nav-2')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=craft%20agents%20browser%20tools'
    )
  })

it('clears navigation timeout timer on success', async () => {
    manager.createInstance('nav-timeout')

    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout')

    try {
      await manager.navigate('nav-timeout', 'https://example.com')
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      clearTimeoutSpy.mockRestore()
    }
  })

it('re-checks the live URL at the local mutation point after a concurrent navigation', async () => {
    manager.createInstance('gmail-local-race')
    await Bun.sleep(0)
    await manager.navigate('gmail-local-race', 'https://cms.example.test/form')
    const instance = getTestBrowserInstance(manager, 'gmail-local-race')
    const originalLoadURL = instance.pageView.webContents.loadURL
    let navigationStarted!: () => void
    let releaseNavigation!: () => void
    const started = new Promise<void>((resolve) => { navigationStarted = resolve })
    const held = new Promise<void>((resolve) => { releaseNavigation = resolve })
    instance.pageView.webContents.loadURL = mock(async (url: string) => {
      navigationStarted()
      await held
      await originalLoadURL(url)
    })
    const policy = {
      reason: 'contextual-gmail-reply' as const,
      blockedHosts: ['mail.google.com'],
      matchSubdomains: true,
    }

    await manager.clickElement('gmail-local-race', '@save', undefined, policy)
    expect(instance.cdp.clickElement).toHaveBeenCalledTimes(1)
    spyOn(instance.cdp, 'clickElement').mockClear()

    const navigation = manager.navigate('gmail-local-race', 'https://mail.google.com/mail/u/0/#inbox')
    await started
    const click = manager.clickElement('gmail-local-race', '@send', undefined, policy)
    let clickError: unknown
    const clickSettled = click.then(
      () => { throw new Error('Expected Gmail click to be blocked') },
      (error) => { clickError = error },
    )
    await Bun.sleep(0)
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
    releaseNavigation()

    await navigation
    await clickSettled
    expect(String(clickError)).toContain('browser mutations on Gmail are disabled')
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
  })

it('keeps a history navigation serialized until its Gmail URL commits before a local mutation', async () => {
    manager.createInstance('gmail-local-history-race')
    await Bun.sleep(0)
    await manager.navigate('gmail-local-history-race', 'https://cms.example.test/form')
    const instance = getTestBrowserInstance(manager, 'gmail-local-history-race')
    const originalLoadURL = instance.pageView.webContents.loadURL
    let historyStarted!: () => void
    let releaseHistory!: () => void
    const started = new Promise<void>((resolve) => { historyStarted = resolve })
    const held = new Promise<void>((resolve) => { releaseHistory = resolve })
    instance.pageView.webContents.canGoBack = mock(() => true)
    instance.pageView.webContents.goBack = mock(() => {
      historyStarted()
      instance.pageView.webContents._emit(
        'did-navigate-in-page',
        'https://mail.google.com/frame-only',
        false,
      )
      void held.then(async () => {
        const gmailUrl = 'https://mail.google.com/mail/u/0/#inbox'
        await originalLoadURL(gmailUrl)
        instance.pageView.webContents._emit('did-navigate', gmailUrl)
      })
    })
    const policy = {
      reason: 'contextual-gmail-reply' as const,
      blockedHosts: ['mail.google.com'],
      matchSubdomains: true,
    }

    const historyNavigation = manager.goBack('gmail-local-history-race')
    await started
    const click = manager.clickElement('gmail-local-history-race', '@send', undefined, policy)
    let clickError: unknown
    const clickSettled = click.then(
      () => { throw new Error('Expected Gmail click after history navigation to be blocked') },
      (error) => { clickError = error },
    )
    await Bun.sleep(0)
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
    releaseHistory()

    await historyNavigation
    await clickSettled
    expect(String(clickError)).toContain('browser mutations on Gmail are disabled')
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
  })

it('ignores a sub-frame in-page event while a guarded click awaits its main-frame Gmail navigation', async () => {
    manager.createInstance('gmail-local-click-navigation-race')
    await Bun.sleep(0)
    await manager.navigate('gmail-local-click-navigation-race', 'https://cms.example.test/form')
    const instance = getTestBrowserInstance(manager, 'gmail-local-click-navigation-race')
    const originalLoadURL = instance.pageView.webContents.loadURL
    let clickStarted!: () => void
    let releaseNavigation!: () => void
    const started = new Promise<void>((resolve) => { clickStarted = resolve })
    const held = new Promise<void>((resolve) => { releaseNavigation = resolve })
    instance.cdp.clickElement = mock(async () => {
      clickStarted()
      instance.pageView.webContents._emit(
        'did-navigate-in-page',
        'https://cms.example.test/embedded-frame',
        false,
      )
      void held.then(async () => {
        const gmailUrl = 'https://mail.google.com/mail/u/0/#inbox'
        await originalLoadURL(gmailUrl)
        instance.pageView.webContents._emit('did-navigate', gmailUrl)
      })
      return {
        ref: '@open-mail',
        box: { x: 0, y: 0, width: 10, height: 10 },
        clickPoint: { x: 5, y: 5 },
      }
    })
    const policy = {
      reason: 'contextual-gmail-reply' as const,
      blockedHosts: ['mail.google.com'],
      matchSubdomains: true,
    }

    const navigationClick = manager.clickElement(
      'gmail-local-click-navigation-race',
      '@open-mail',
      { waitFor: 'navigation' },
      policy,
    )
    await started
    const followupClick = manager.clickElement(
      'gmail-local-click-navigation-race',
      '@send',
      undefined,
      policy,
    )
    let followupError: unknown
    const followupSettled = followupClick.then(
      () => { throw new Error('Expected Gmail follow-up click to be blocked') },
      (error) => { followupError = error },
    )
    await Bun.sleep(0)
    expect(instance.cdp.clickElement).toHaveBeenCalledTimes(1)
    releaseNavigation()

    await navigationClick
    await followupSettled
    expect(String(followupError)).toContain('browser mutations on Gmail are disabled')
    expect(instance.cdp.clickElement).toHaveBeenCalledTimes(1)
  })

it('fails closed at the local mutation point when Electron exposes no parseable live URL', async () => {
    manager.createInstance('gmail-local-unknown-url')
    await Bun.sleep(0)
    const instance = getTestBrowserInstance(manager, 'gmail-local-unknown-url')
    instance.currentUrl = ''
    instance.pageView.webContents.getURL = mock(() => 'not a valid URL')
    const policy = {
      reason: 'contextual-gmail-reply' as const,
      blockedHosts: ['mail.google.com'],
      matchSubdomains: true,
    }

    let clickError: unknown
    await manager.clickElement('gmail-local-unknown-url', '@send', undefined, policy).then(
      () => { throw new Error('Expected a mutation with an unknown live URL to be blocked') },
      (error) => { clickError = error },
    )
    expect(String(clickError)).toContain('browser mutations on Gmail are disabled')
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
  })
})
