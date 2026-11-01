import { describe, expect, it, mock } from 'bun:test'
import { createMockWebContents, createTestBrowserCDP } from './fixtures/browser-cdp-fixture'

describe('BrowserCDP', () => {
describe('ensureAttached', () => {
    it('attaches debugger on first call', async () => {
      const wc = createMockWebContents()
      const cdp = createTestBrowserCDP(wc)

      // Trigger attach via a CDP command
      await cdp.getAccessibilitySnapshot()

      expect(wc.debugger.attach).toHaveBeenCalledTimes(1)
      expect(wc.debugger.attach).toHaveBeenCalledWith('1.3')
    })

    it('skips attach on subsequent calls', async () => {
      const wc = createMockWebContents()
      const cdp = createTestBrowserCDP(wc)

      await cdp.getAccessibilitySnapshot()
      await cdp.getAccessibilitySnapshot()

      expect(wc.debugger.attach).toHaveBeenCalledTimes(1)
    })

    it('handles already-attached error gracefully', async () => {
      const wc = createMockWebContents()
      wc.debugger.attach = mock(() => { throw new Error('Already attached to this target') })
      const cdp = createTestBrowserCDP(wc)

      // Should not throw
      await cdp.getAccessibilitySnapshot()
      expect(wc.debugger.sendCommand).toHaveBeenCalled()
    })

    it('registers detach listener only once', async () => {
      const wc = createMockWebContents()
      const cdp = createTestBrowserCDP(wc)

      // Trigger ensureAttached multiple times by simulating detach + re-attach
      await cdp.getAccessibilitySnapshot()

      // Simulate detach
      wc._triggerDetach()

      // Re-attach
      await cdp.getAccessibilitySnapshot()

      // The 'on' for 'detach' should only be called once (guard prevents duplicates)
      const detachCalls = wc.debugger.on.mock.calls.filter(
        (call) => call[0] === 'detach'
      )
      expect(detachCalls.length).toBe(1)
    })
  })

describe('detach', () => {
    it('detaches debugger', async () => {
      const wc = createMockWebContents()
      const cdp = createTestBrowserCDP(wc)

      // Attach first
      await cdp.getAccessibilitySnapshot()

      cdp.detach()
      expect(wc.debugger.detach).toHaveBeenCalled()
    })

    it('is safe to call when not attached', () => {
      const wc = createMockWebContents()
      const cdp = createTestBrowserCDP(wc)

      // Should not throw
      expect(() => cdp.detach()).not.toThrow()
    })
  })
})
