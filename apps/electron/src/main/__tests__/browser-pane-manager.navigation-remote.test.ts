import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createBrowserPaneTestManager, getTestBrowserInstance, invalidCapabilityRequest } from './fixtures/browser-pane-fixture'

describe('BrowserPaneManager', () => {
let manager: ReturnType<typeof createBrowserPaneTestManager>
beforeEach(() => { manager = createBrowserPaneTestManager() })
it('re-applies a remote mutation URL policy after a concurrent capability navigation', async () => {
    const createRequest = {
      v: 1 as const,
      workspaceId: 'ws-gmail-race',
      sessionId: 'session-gmail-race',
      method: 'createForSession' as const,
      args: ['session-gmail-race', { show: false }],
    }
    const instanceId = await manager['dispatchCapability'](createRequest) as string
    await Bun.sleep(0)
    await manager['dispatchCapability']({
      ...createRequest,
      method: 'navigate',
      args: [instanceId, 'https://cms.example.test/form'],
    })
    const instance = getTestBrowserInstance(manager, instanceId)
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

    const navigation = manager['dispatchCapability']({
      ...createRequest,
      method: 'navigate',
      args: [instanceId, 'https://mail.google.com/mail/u/0/#inbox'],
    })
    await started
    const click = manager['dispatchCapability']({
      ...createRequest,
      v: 2,
      method: 'clickElement',
      args: [instanceId, '@send', undefined],
      mutationUrlPolicy: policy,
    })
    let clickError: unknown
    const clickSettled = click.then(
      () => { throw new Error('Expected remote Gmail click to be blocked') },
      (error: unknown) => { clickError = error },
    )
    await Bun.sleep(0)
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
    releaseNavigation()

    await navigation
    await clickSettled
    expect(String(clickError)).toContain('browser mutations on Gmail are disabled')
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
  })

it('keeps a remote history capability serialized until Gmail commits before its mutation', async () => {
    const createRequest = {
      v: 1 as const,
      workspaceId: 'ws-gmail-history-race',
      sessionId: 'session-gmail-history-race',
      method: 'createForSession' as const,
      args: ['session-gmail-history-race', { show: false }],
    }
    const instanceId = await manager['dispatchCapability'](createRequest) as string
    await Bun.sleep(0)
    await manager['dispatchCapability']({
      ...createRequest,
      method: 'navigate',
      args: [instanceId, 'https://cms.example.test/form'],
    })
    const instance = getTestBrowserInstance(manager, instanceId)
    const originalLoadURL = instance.pageView.webContents.loadURL
    let historyStarted!: () => void
    let releaseHistory!: () => void
    const started = new Promise<void>((resolve) => { historyStarted = resolve })
    const held = new Promise<void>((resolve) => { releaseHistory = resolve })
    instance.pageView.webContents.canGoBack = mock(() => true)
    instance.pageView.webContents.goBack = mock(() => {
      historyStarted()
      instance.pageView.webContents._emit(
        'did-fail-load',
        -3,
        'ERR_ABORTED',
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

    const historyNavigation = manager['dispatchCapability']({
      ...createRequest,
      method: 'goBack',
      args: [instanceId],
    })
    await started
    const click = manager['dispatchCapability']({
      ...createRequest,
      v: 2,
      method: 'clickElement',
      args: [instanceId, '@send', undefined],
      mutationUrlPolicy: policy,
    })
    let clickError: unknown
    const clickSettled = click.then(
      () => { throw new Error('Expected remote Gmail click after history navigation to be blocked') },
      (error: unknown) => { clickError = error },
    )
    await Bun.sleep(0)
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
    releaseHistory()

    await historyNavigation
    await clickSettled
    expect(String(clickError)).toContain('browser mutations on Gmail are disabled')
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
  })

it('keeps a remote guarded click queued through sub-frame events until main-frame Gmail commits', async () => {
    const createRequest = {
      v: 1 as const,
      workspaceId: 'ws-gmail-click-navigation-race',
      sessionId: 'session-gmail-click-navigation-race',
      method: 'createForSession' as const,
      args: ['session-gmail-click-navigation-race', { show: false }],
    }
    const instanceId = await manager['dispatchCapability'](createRequest) as string
    await Bun.sleep(0)
    await manager['dispatchCapability']({
      ...createRequest,
      method: 'navigate',
      args: [instanceId, 'https://cms.example.test/form'],
    })
    const instance = getTestBrowserInstance(manager, instanceId)
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
    const mutationUrlPolicy = {
      reason: 'contextual-gmail-reply' as const,
      blockedHosts: ['mail.google.com'],
      matchSubdomains: true,
    }

    const navigationClick = manager['dispatchCapability']({
      ...createRequest,
      v: 2,
      method: 'clickElement',
      args: [instanceId, '@open-mail', { waitFor: 'navigation' }],
      mutationUrlPolicy,
    })
    await started
    const followupClick = manager['dispatchCapability']({
      ...createRequest,
      v: 2,
      method: 'clickElement',
      args: [instanceId, '@send', undefined],
      mutationUrlPolicy,
    })
    let followupError: unknown
    const followupSettled = followupClick.then(
      () => { throw new Error('Expected remote Gmail follow-up click to be blocked') },
      (error: unknown) => { followupError = error },
    )
    await Bun.sleep(0)
    expect(instance.cdp.clickElement).toHaveBeenCalledTimes(1)
    releaseNavigation()

    await navigationClick
    await followupSettled
    expect(String(followupError)).toContain('browser mutations on Gmail are disabled')
    expect(instance.cdp.clickElement).toHaveBeenCalledTimes(1)
  })

it('fails closed for a remote mutation policy when the desktop live URL is malformed', async () => {
    const createRequest = {
      v: 1 as const,
      workspaceId: 'ws-gmail-unknown-url',
      sessionId: 'session-gmail-unknown-url',
      method: 'createForSession' as const,
      args: ['session-gmail-unknown-url', { show: false }],
    }
    const instanceId = await manager['dispatchCapability'](createRequest) as string
    await Bun.sleep(0)
    const instance = getTestBrowserInstance(manager, instanceId)
    instance.currentUrl = ''
    instance.pageView.webContents.getURL = mock(() => 'https://[invalid')
    const policy = {
      reason: 'contextual-gmail-reply' as const,
      blockedHosts: ['mail.google.com'],
      matchSubdomains: true,
    }

    let clickError: unknown
    await manager['dispatchCapability']({
      ...createRequest,
      v: 2,
      method: 'clickElement',
      args: [instanceId, '@send', undefined],
      mutationUrlPolicy: policy,
    }).then(
      () => { throw new Error('Expected remote mutation with malformed URL to be blocked') },
      (error: unknown) => { clickError = error },
    )
    expect(String(clickError)).toContain('browser mutations on Gmail are disabled')
    expect(instance.cdp.clickElement).not.toHaveBeenCalled()
  })

it('rejects malformed or observational v2 capability requests before dispatch', async () => {
    const base = {
      workspaceId: 'ws-policy-contract',
      sessionId: 'session-policy-contract',
      args: ['missing-instance', '@send', undefined],
    }
    await expect(manager['dispatchCapability'](invalidCapabilityRequest({
      ...base,
      v: 2,
      method: 'clickElement',
    }))).rejects.toThrow('v2 is reserved for a policy-bearing page mutation')
    await expect(manager['dispatchCapability'](invalidCapabilityRequest({
      ...base,
      v: 2,
      method: 'navigate',
      mutationUrlPolicy: {
        reason: 'contextual-gmail-reply',
        blockedHosts: ['mail.google.com'],
      },
    }))).rejects.toThrow('v2 is reserved for a policy-bearing page mutation')
  })
})
