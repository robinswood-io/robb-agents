import { describe, expect, it } from 'bun:test'
import { createMockWebContents, createTestBrowserCDP } from './fixtures/browser-cdp-fixture'

describe('BrowserCDP', () => {
describe('getAccessibilitySnapshot', () => {
    it('parses AX tree nodes and assigns refs', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 100 },
              { role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'test@example.com' }, backendDOMNodeId: 101, properties: [
                { name: 'focused', value: { value: true } },
              ]},
              { role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 102 },
            ],
          }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.url).toBe('https://example.com')
      expect(snapshot.title).toBe('Example Page')
      expect(snapshot.nodes).toHaveLength(3)

      expect(snapshot.nodes[0].ref).toBe('@e1')
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[0].name).toBe('Submit')

      expect(snapshot.nodes[1].ref).toBe('@e2')
      expect(snapshot.nodes[1].value).toBe('test@example.com')
      expect(snapshot.nodes[1].focused).toBe(true)

      expect(snapshot.nodes[2].ref).toBe('@e3')
      expect(snapshot.nodes[2].role).toBe('link')
    })

    it('keeps refs stable for same backend nodes across reordered snapshots', async () => {
      let snapshotCallCount = 0
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          snapshotCallCount += 1

          if (snapshotCallCount === 1) {
            return {
              nodes: [
                { role: { value: 'combobox' }, name: { value: 'Sort' }, value: { value: 'created-oldest' }, backendDOMNodeId: 200 },
                { role: { value: 'button' }, name: { value: 'Apply' }, backendDOMNodeId: 201 },
              ],
            }
          }

          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Apply' }, backendDOMNodeId: 201 },
              { role: { value: 'combobox' }, name: { value: 'Sort' }, value: { value: 'updated-newest' }, backendDOMNodeId: 200 },
            ],
          }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      const first = await cdp.getAccessibilitySnapshot()
      const second = await cdp.getAccessibilitySnapshot()

      const firstSortRef = first.nodes.find((n) => n.name === 'Sort')?.ref
      const secondSortRef = second.nodes.find((n) => n.name === 'Sort')?.ref

      expect(firstSortRef).toBeDefined()
      expect(secondSortRef).toBeDefined()
      expect(firstSortRef).toBe(secondSortRef)
    })

    it('skips non-interactive, non-content nodes', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'generic' }, name: { value: '' } },       // Filtered: generic + no name
              { role: { value: 'none' }, name: { value: '' } },          // Filtered: none + no name
              { role: { value: 'button' }, name: { value: 'OK' } },      // Kept: interactive
              { role: { value: 'heading' }, name: { value: 'Title' } },  // Kept: content + name
              { role: { value: 'heading' }, name: { value: '' } },       // Filtered: content without name
            ],
          }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(2)
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[1].role).toBe('heading')
    })

    it('caps at 500 nodes', async () => {
      const manyNodes = Array.from({ length: 600 }, (_, i) => ({
        role: { value: 'button' },
        name: { value: `Button ${i}` },
        backendDOMNodeId: i,
      }))

      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: manyNodes }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(500)
      expect(snapshot.nodes[499].ref).toBe('@e500')
    })

    it('normalizes role casing for primary filtering', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'Button' }, name: { value: 'Submit' }, backendDOMNodeId: 1 },
            ],
          }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(1)
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[0].name).toBe('Submit')
    })

    it('uses fallback selection when primary filtering keeps zero nodes', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'grouping' }, name: { value: 'Recents List' }, backendDOMNodeId: 21 },
              { role: { value: 'pane' }, name: { value: 'Shared Files' }, backendDOMNodeId: 22 },
            ],
          }
        }
        return {}
      })

      const cdp = createTestBrowserCDP(wc)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(2)
      expect(snapshot.nodes[0].name).toBe('Recents List')
      expect(snapshot.nodes[1].name).toBe('Shared Files')
    })

    it('keeps fallback nodes clickable through ref mapping', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'pane' }, name: { value: 'Canvas Action' }, backendDOMNodeId: 42 },
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
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(1)
      await cdp.clickElement('@e1')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('Input.dispatchMouseEvent')
    })
  })
})
