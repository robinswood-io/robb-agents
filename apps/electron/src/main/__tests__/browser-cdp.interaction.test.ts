import { describe, expect, it } from 'bun:test'
import { createMockWebContents, createTestBrowserCDP, requireCommandParams } from './fixtures/browser-cdp-fixture'

describe('BrowserCDP', () => {
describe('clickElement', () => {
    it('throws for unknown ref', async () => {
      const wc = createMockWebContents()
      const cdp = createTestBrowserCDP(wc)

      await expect(cdp.clickElement('@e99')).rejects.toThrow('not found')
    })

    it('resolves node and dispatches mouse events', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method, params) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Click' }, backendDOMNodeId: 42 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-42' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      await cdp.getAccessibilitySnapshot() // Populate refMap

      await cdp.clickElement('@e1')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('DOM.getBoxModel')
      expect(sentCommands).toContain('Runtime.callFunctionOn')
      expect(sentCommands).toContain('Input.dispatchMouseEvent')

      const scrollIndex = sentCommands.indexOf('Runtime.callFunctionOn')
      const boxModelIndex = sentCommands.indexOf('DOM.getBoxModel')
      expect(scrollIndex).toBeGreaterThan(-1)
      expect(boxModelIndex).toBeGreaterThan(-1)
      expect(scrollIndex).toBeLessThan(boxModelIndex)
    })

    it('recovers a stale ref from matching accessibility semantics before clicking', async () => {
      let snapshotCalls = 0
      const resolvedBackendNodeIds: number[] = []
      const wc = createMockWebContents(async (method, params) => {
        if (method === 'Accessibility.getFullAXTree') {
          snapshotCalls += 1
          return {
            nodes: [
              {
                role: { value: 'button' },
                name: { value: 'Continue' },
                backendDOMNodeId: snapshotCalls === 1 ? 42 : 84,
              },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          const backendNodeId = Number(params?.backendNodeId)
          resolvedBackendNodeIds.push(backendNodeId)
          if (backendNodeId === 42) throw new Error('No node with given id found')
          return { object: { objectId: 'obj-84' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(
        wc as unknown as ConstructorParameters<typeof BrowserCDP>[0],
      )
      await cdp.getAccessibilitySnapshot()

      const geometry = await cdp.clickElement('@e1')

      expect(snapshotCalls).toBe(2)
      expect(resolvedBackendNodeIds).toEqual([42, 84])
      expect(geometry.ref).toBe('@e2')
    })
  })

describe('typeText', () => {
    it('inserts the full text with one CDP command', async () => {
      const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
      const wc = createMockWebContents(async (method, params) => {
        calls.push({ method, params })
        return method === 'Runtime.evaluate' ? { result: { value: true } } : {}
      })

      const cdp = new BrowserCDP(
        wc as unknown as ConstructorParameters<typeof BrowserCDP>[0],
      )
      await cdp.typeText('a long value')

      expect(calls.filter(call => call.method === 'Input.insertText')).toEqual([
        { method: 'Input.insertText', params: { text: 'a long value' } },
      ])
      expect(calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false)
    })
  })

describe('fillElement', () => {
    it('focuses, clears, and inserts the full value with one CDP command', async () => {
      const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
      const wc = createMockWebContents(async (method, params) => {
        calls.push({ method, params })
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'textbox' }, name: { value: 'Input' }, backendDOMNodeId: 10 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-10' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      await cdp.getAccessibilitySnapshot()

      await cdp.fillElement('@e1', 'ab')

      expect(calls.some(call => call.method === 'DOM.focus')).toBe(true)
      expect(calls.some(call => call.method === 'Runtime.callFunctionOn')).toBe(true)
      expect(calls.filter(call => call.method === 'Input.insertText')).toEqual([
        { method: 'Input.insertText', params: { text: 'ab' } },
      ])
      expect(calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false)
    })
  })

describe('selectOption', () => {
    it('sets value and dispatches events', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'combobox' }, name: { value: 'Country' }, backendDOMNodeId: 20 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-20' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      await cdp.getAccessibilitySnapshot()

      await cdp.selectOption('@e1', 'US')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('Runtime.callFunctionOn')
    })
  })

describe('setFileInputFiles', () => {
    it('uses the referenced file input directly', async () => {
      const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
      const wc = createMockWebContents(async (method, params) => {
        calls.push({ method, params })
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Upload' }, backendDOMNodeId: 42 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-upload' } }
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { objectId: 'obj-file-input' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      await cdp.getAccessibilitySnapshot()

      await cdp.setFileInputFiles('@e1', ['/tmp/upload.txt'])

      expect(calls).toContainEqual({
        method: 'DOM.setFileInputFiles',
        params: { files: ['/tmp/upload.txt'], objectId: 'obj-file-input' },
      })
    })

    it('fails clearly when no file input can be resolved from the reference', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Upload' }, backendDOMNodeId: 42 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-upload' } }
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: null } }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      await cdp.getAccessibilitySnapshot()

      await expect(cdp.setFileInputFiles('@e1', ['/tmp/upload.txt'])).rejects.toThrow(
        'no unambiguous file input was found nearby',
      )
    })
  })

describe('drag', () => {
    it('dispatches pressed -> moved -> released with expected button state', async () => {
      const mouseEvents: Record<string, unknown>[] = []
      const wc = createMockWebContents(async (method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push(requireCommandParams(params))
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      await cdp.drag(10, 20, 110, 20)

      expect(mouseEvents.length).toBeGreaterThan(2)
      expect(mouseEvents[0]).toMatchObject({
        type: 'mousePressed',
        x: 10,
        y: 20,
        button: 'left',
        buttons: 1,
      })

      const movedEvents = mouseEvents.filter((event) => event.type === 'mouseMoved')
      expect(movedEvents.length).toBeGreaterThan(0)
      for (const event of movedEvents) {
        expect(event.buttons).toBe(1)
      }

      const lastEvent = mouseEvents[mouseEvents.length - 1]
      expect(lastEvent).toMatchObject({
        type: 'mouseReleased',
        button: 'left',
        buttons: 0,
      })
    })

    it('attempts release even when a move event fails and rethrows original error', async () => {
      const mouseEvents: Record<string, unknown>[] = []
      let failedOnce = false
      const wc = createMockWebContents(async (method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push(requireCommandParams(params))
          if (params?.type === 'mouseMoved' && !failedOnce) {
            failedOnce = true
            throw new Error('move failed')
          }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      await expect(cdp.drag(0, 0, 100, 0)).rejects.toThrow('move failed')
      expect(mouseEvents.some((event) => event.type === 'mouseReleased')).toBe(true)
    })
  })
})
import { BrowserCDP } from './fixtures/browser-cdp-fixture'
