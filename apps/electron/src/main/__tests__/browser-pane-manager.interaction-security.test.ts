import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createBrowserPaneTestManager, getTestBrowserInstance } from './fixtures/browser-pane-fixture'

describe('BrowserPaneManager', () => {
let manager: ReturnType<typeof createBrowserPaneTestManager>
beforeEach(() => { manager = createBrowserPaneTestManager() })
describe('failed interaction tracking', () => {
    it('observes navigation that starts before the click promise resolves', async () => {
      manager.createInstance('fast-navigation')
      const instance = getTestBrowserInstance(manager, 'fast-navigation')
      instance.cdp.clickElement = mock(async () => {
        instance.pageView.webContents._emit('did-navigate', 'https://example.com/next')
        return {
          ref: '@e1',
          box: { x: 0, y: 0, width: 10, height: 10 },
          clickPoint: { x: 5, y: 5 },
        }
      })

      await manager.clickElement('fast-navigation', '@e1', {
        waitFor: 'navigation',
        timeoutMs: 100,
      })

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_click',
        ref: '@e1',
        status: 'succeeded',
      })
    })

    it('clickElement records failed lastAction on error', async () => {
      manager.createInstance('fail-click')
      const instance = getTestBrowserInstance(manager, 'fail-click')
      instance.cdp.clickElement = mock(async () => { throw new Error('click failed') })

      await expect(manager.clickElement('fail-click', '@e1')).rejects.toThrow('click failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_click',
        ref: '@e1',
        status: 'failed',
      })
    })

    it('fillElement records failed lastAction on error', async () => {
      manager.createInstance('fail-fill')
      const instance = getTestBrowserInstance(manager, 'fail-fill')
      instance.cdp.fillElement = mock(async () => { throw new Error('fill failed') })

      await expect(manager.fillElement('fail-fill', '@e2', 'hello')).rejects.toThrow('fill failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_fill',
        ref: '@e2',
        status: 'failed',
      })
    })

    it('selectOption records failed lastAction on error', async () => {
      manager.createInstance('fail-select')
      const instance = getTestBrowserInstance(manager, 'fail-select')
      instance.cdp.selectOption = mock(async () => { throw new Error('select failed') })

      await expect(manager.selectOption('fail-select', '@e3', 'opt-1')).rejects.toThrow('select failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_select',
        ref: '@e3',
        status: 'failed',
      })
    })
  })

describe('security challenge detection', () => {
    it('does not treat a sparse normal page as a security challenge or request an AX snapshot', async () => {
      manager.createInstance('sparse-normal')
      const instance = getTestBrowserInstance(manager, 'sparse-normal')
      instance.title = 'Settings'
      instance.currentUrl = 'https://example.com/settings'
      instance.pageView.webContents.executeJavaScript = mock(async () => [])
      let snapshotCalls = 0
      instance.cdp.getAccessibilitySnapshot = mock(async () => {
        snapshotCalls += 1
        return {
          url: instance.currentUrl,
          title: instance.title,
          nodes: [{ ref: '@e1', role: 'button', name: 'Save' }],
        }
      })

      const result = await manager.detectSecurityChallenge('sparse-normal')

      expect(result).toEqual({ detected: false, provider: 'none', signals: [] })
      expect(snapshotCalls).toBe(0)
    })

    it('classifies hCaptcha without relying on sparse-page heuristics', async () => {
      manager.createInstance('hcaptcha-page')
      const instance = getTestBrowserInstance(manager, 'hcaptcha-page')
      instance.title = 'Verify'
      instance.currentUrl = 'https://example.com/login'
      instance.pageView.webContents.executeJavaScript = mock(async () => ['dom:hcaptcha'])

      const result = await manager.detectSecurityChallenge('hcaptcha-page')

      expect(result.detected).toBe(true)
      expect(result.provider).toBe('hcaptcha')
      expect(result.signals).toContain('dom:hcaptcha')
    })

    it('waits until a manual security challenge has cleared', async () => {
      manager.createInstance('challenge-clear')
      const instance = getTestBrowserInstance(manager, 'challenge-clear')
      let detectionCalls = 0
      instance.pageView.webContents.executeJavaScript = mock(async () => {
        detectionCalls += 1
        return detectionCalls === 1 ? ['dom:hcaptcha'] : []
      })

      const result = await manager.waitFor('challenge-clear', {
        kind: 'challenge-clear',
        timeoutMs: 200,
        pollMs: 25,
      })

      expect(result.detail).toBe('security challenge cleared')
      expect(detectionCalls).toBe(2)
    })
  })
})
