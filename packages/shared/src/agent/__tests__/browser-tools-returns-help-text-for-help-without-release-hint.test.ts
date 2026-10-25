/**
 * Tests for the browser tools factory.
 *
 * Verifies that createBrowserTools produces a single browser_tool
 * and that it delegates correctly to BrowserPaneFns callbacks via CLI commands.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createBrowserTools, type BrowserPaneFns } from "../browser-tools";
import { setContextualGmailBrowserMutationGuard } from "../browser-tool-runtime";
import { createMockFns, executeTool } from "./testing/browser-tools-fixture.ts";


describe('createBrowserTools', () => {
let mockFns: BrowserPaneFns

let tools: ReturnType<typeof createBrowserTools>

beforeEach(() => {
    setContextualGmailBrowserMutationGuard('test-session', false)
    mockFns = createMockFns()
    tools = createBrowserTools({
      sessionId: 'test-session',
      getBrowserPaneFns: () => mockFns,
    })
  })

describe('browser_tool', () => {
it('returns help text for --help without release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: '--help' })
      expect(result.content[0].text).toContain('browser_tool command help')
      expect(result.content[0].text).toContain('navigate <url>')
      expect(result.content[0].text).toContain('find <query>')
      expect(result.content[0].text).toContain('click-at <x> <y>')
      expect(result.content[0].text).toContain('type <text>')
      expect(result.content[0].text).toContain('upload <ref> <path> [path2...]')
      expect(result.content[0].text).toContain('set-clipboard <text>')
      expect(result.content[0].text).toContain('get-clipboard')
      expect(result.content[0].text).toContain('paste <text>')
      expect(result.content[0].text).toContain('screenshot [--annotated|-a]')
      expect(result.content[0].text).toContain('focus [windowId]')
      expect(result.content[0].text).toContain('windows')
      expect(result.content[0].text).toContain('resume [timeoutMs]')
      expect(result.content[0].text).toContain('Array mode (JSON array input, no batch splitting/tokenization):')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('routes navigate command and appends release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'navigate example.com' })
      expect(result.content[0].text).toContain('Navigated to')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

it('releases control when navigate lands on a security challenge', async () => {
      let releaseCalls = 0
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['title:just-a-moment'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'navigate example.com' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).toContain('resume 120000')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('routes open command in background by default', async () => {
      let openOptions: { background?: boolean } | undefined
      mockFns.openPanel = async (options) => {
        openOptions = options
        return { instanceId: 'browser-test-1' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open' })
      expect(openOptions).toEqual({ background: true })
      expect(result.content[0].text).toContain('Opened in-app browser window in background')
      expect(result.content[0].text).toContain('browser-test-1')
    })

it('routes open command with --foreground flag and reports settled visibility', async () => {
      let openOptions: { background?: boolean } | undefined
      let listCalls = 0
      mockFns.openPanel = async (options) => {
        openOptions = options
        return { instanceId: 'browser-test-1' }
      }
      mockFns.listWindows = async () => {
        listCalls += 1
        const isVisible = listCalls >= 3
        return [{
          id: 'browser-test-1',
          title: 'Example Domain',
          url: 'https://example.com',
          isVisible,
          ownerType: 'session',
          ownerSessionId: 'test-session',
          boundSessionId: 'test-session',
          agentControlActive: true,
        }]
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open --foreground' })
      expect(openOptions).toEqual({ background: false })
      expect(result.content[0].text).toContain('Opened in-app browser window in foreground')
      expect(result.content[0].text).toContain('Visibility settle: wait-loop')
      expect(result.content[0].text).toContain('Visible: true')
    })

it('uses focus fallback when foreground open visibility does not settle in wait loop', async () => {
      const previousTimeout = process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS
      const previousPoll = process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS
      process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS = '120'
      process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS = '20'

      try {
        let focusCalls = 0
        let listCalls = 0
        mockFns.listWindows = async () => {
          listCalls += 1
          const isVisible = focusCalls > 0
          return [{
            id: 'browser-test-1',
            title: 'Example Domain',
            url: 'https://example.com',
            isVisible,
            ownerType: 'session',
            ownerSessionId: 'test-session',
            boundSessionId: 'test-session',
            agentControlActive: true,
          }]
        }
        mockFns.focusWindow = async (instanceId?: string) => {
          focusCalls += 1
          return {
            instanceId: instanceId ?? 'browser-test-1',
            title: 'Example Domain',
            url: 'https://example.com',
          }
        }

        const result = await executeTool(tools, 'browser_tool', { command: 'open --foreground' })
        expect(listCalls).toBeGreaterThan(2)
        expect(focusCalls).toBe(1)
        expect(result.content[0].text).toContain('Visibility settle: timeout + focus retry')
        expect(result.content[0].text).toContain('Visible: true')
      } finally {
        if (previousTimeout === undefined) delete process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS
        else process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS = previousTimeout

        if (previousPoll === undefined) delete process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS
        else process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS = previousPoll
      }
    })

it('does not use focus fallback for background open', async () => {
      let focusCalls = 0
      mockFns.focusWindow = async (instanceId?: string) => {
        focusCalls += 1
        return {
          instanceId: instanceId ?? 'browser-test-1',
          title: 'Example Domain',
          url: 'https://example.com',
        }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open' })
      expect(focusCalls).toBe(0)
      expect(result.content[0].text).not.toContain('Visibility settle:')
    })

it('routes snapshot command and formats nodes', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      const text = result.content[0].text
      expect(text).toContain('@e1')
      expect(text).toContain('[button]')
      expect(text).toContain('"Click me"')
      expect(text).toContain('(focused)')
    })

it('treats near-zero actionable snapshot as challenge state and attaches screenshot', async () => {
      let releaseCalls = 0
      mockFns.snapshot = async () => ({
        url: 'https://protected.example.com',
        title: 'Protected',
        nodes: [
          { ref: '@e1', role: 'staticText', name: 'Checking your browser before accessing' },
        ],
      })
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['text:checking-browser'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).toContain('Detected only 0 actionable element(s) out of 1 accessibility nodes.')
      expect(result.content[1]!.type).toBe('image')
      expect(result.content[1]!.mimeType).toBe('image/jpeg')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('still reports challenge when screenshot capture fails or is empty', async () => {
      mockFns.snapshot = async () => ({
        url: 'https://protected.example.com',
        title: 'Protected',
        nodes: [],
      })
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['title:just-a-moment'],
      })
      mockFns.screenshot = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })

      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).toContain('Detected only 0 actionable element(s) out of 0 accessibility nodes.')
      expect(result.content.some((item) => item.type === 'image')).toBe(false)
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('routes find command and returns matching refs', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'find click button' })
      const text = result.content[0].text
      expect(text).toContain('Found 1 element(s)')
      expect(text).toContain('@e1')
      expect(text).toContain('[button]')
    })

it('returns helpful message for find command with no matches', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'find this-does-not-exist' })
      expect(result.content[0].text).toContain('No elements found matching')
    })

it('routes click command', async () => {
      let clickedRef = ''
      mockFns.click = async (ref) => { clickedRef = ref }
      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(clickedRef).toBe('@e1')
      expect(result.content[0].text).toContain('Clicked element @e1')
    })

it('blocks opaque mutations only on the session Gmail window when contextual reply guard is active', async () => {
      setContextualGmailBrowserMutationGuard('test-session', true)
      mockFns.resolveCurrentWindow = async () => ({
        instanceId: 'browser-1',
        title: 'Inbox',
        url: 'https://mail.google.com/mail/u/0/#inbox',
      })
      let clicked = false
      mockFns.click = async () => { clicked = true }
      const blocked = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(clicked).toBe(false)
      expect(blocked.isError).toBe(true)
      expect(blocked.content[0].text).toContain('browser mutations on Gmail are disabled')

      mockFns.resolveCurrentWindow = async () => ({
        instanceId: 'browser-1',
        title: 'CMS',
        url: 'https://cms.example.com/form',
      })
      const allowed = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(clicked).toBe(true)
      expect(allowed.isError).not.toBe(true)

      clicked = false
      mockFns.listWindows = async () => ([
        {
          id: 'old-gmail',
          title: 'Inbox',
          url: 'https://mail.google.com/mail/u/0/#inbox',
          isVisible: true,
          ownerType: 'session',
          ownerSessionId: 'test-session',
          boundSessionId: null,
          agentControlActive: false,
        },
        {
          id: 'current-cms',
          title: 'CMS',
          url: 'https://cms.example.com/form',
          isVisible: true,
          ownerType: 'session',
          ownerSessionId: 'test-session',
          boundSessionId: 'test-session',
          agentControlActive: true,
        },
      ])
      mockFns.resolveCurrentWindow = async () => ({
        instanceId: 'current-cms',
        title: 'CMS',
        url: 'https://cms.example.com/form',
      })
      const currentCms = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(clicked).toBe(true)
      expect(currentCms.isError).not.toBe(true)

      clicked = false
      mockFns.listWindows = async () => ([
        {
          id: 'current-gmail',
          title: 'Inbox',
          url: 'https://mail.google.com/mail/u/0/#inbox',
          isVisible: true,
          ownerType: 'session',
          ownerSessionId: 'test-session',
          boundSessionId: 'test-session',
          agentControlActive: true,
        },
        {
          id: 'old-cms',
          title: 'CMS',
          url: 'https://cms.example.com/form',
          isVisible: true,
          ownerType: 'session',
          ownerSessionId: 'test-session',
          boundSessionId: null,
          agentControlActive: false,
        },
      ])
      mockFns.resolveCurrentWindow = async () => ({
        instanceId: 'current-gmail',
        title: 'Inbox',
        url: 'https://mail.google.com/mail/u/0/#inbox',
      })
      const currentGmail = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(clicked).toBe(false)
      expect(currentGmail.isError).toBe(true)
    })

it('allows local window lifecycle commands while the contextual Gmail guard is active', async () => {
      setContextualGmailBrowserMutationGuard('test-session', true)
      mockFns.listWindows = async () => ([{
        id: 'browser-1',
        title: 'Inbox',
        url: 'https://mail.google.com/mail/u/0/#inbox',
        isVisible: true,
        ownerType: 'session',
        ownerSessionId: 'test-session',
        boundSessionId: 'test-session',
        agentControlActive: true,
      }])
      for (const command of ['release', 'close', 'hide', 'open', 'window-resize 1024 768']) {
        const result = await executeTool(tools, 'browser_tool', { command })
        expect({ command, isError: result.isError }).toEqual({ command, isError: undefined })
        expect(result.content[0].text).not.toContain('browser mutations on Gmail are disabled')
      }
    })

it('routes click with wait arguments', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1 network-idle 5000' })
      expect(result.content[0].text).toContain('waitFor=network-idle')
    })

it('detects security challenge after click even when URL does not change', async () => {
      let releaseCalls = 0
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['dom:challenge-form'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('security challenge detected (cloudflare)')
      expect(result.content[0].text).toContain('URL changed: false')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('routes click-at command with coordinates', async () => {
      let clickedX = 0
      let clickedY = 0
      mockFns.clickAt = async (x, y) => { clickedX = x; clickedY = y }
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at 350 200' })
      expect(clickedX).toBe(350)
      expect(clickedY).toBe(200)
      expect(result.content[0].text).toContain('Clicked at coordinates (350, 200)')
    })

it('returns error for click-at with missing coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at 350' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('click-at requires x and y coordinates')
    })

it('returns error for click-at with non-numeric coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at foo bar' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('click-at coordinates must be numbers')
    })

it('routes drag command with coordinates', async () => {
      let draggedCoords = { x1: 0, y1: 0, x2: 0, y2: 0 }
      mockFns.drag = async (x1, y1, x2, y2) => { draggedCoords = { x1, y1, x2, y2 } }
      const result = await executeTool(tools, 'browser_tool', { command: 'drag 100 200 300 400' })
      expect(draggedCoords).toEqual({ x1: 100, y1: 200, x2: 300, y2: 400 })
      expect(result.content[0].text).toContain('Dragged from (100, 200) to (300, 400)')
    })

it('returns error for drag with missing coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'drag 100 200' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('drag requires 4 coordinates')
    })

it('returns error for drag with non-numeric coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'drag foo bar baz qux' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('drag coordinates must be numbers')
    })

it('routes fill command', async () => {
      let filledRef = ''
      let filledValue = ''
      mockFns.fill = async (ref, value) => { filledRef = ref; filledValue = value }
      const result = await executeTool(tools, 'browser_tool', { command: 'fill @e2 hello world' })
      expect(filledRef).toBe('@e2')
      expect(filledValue).toBe('hello world')
      expect(result.content[0].text).toContain('Filled element @e2')
    })

it('supports semicolon command batching', async () => {
      const calls: string[] = []
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }
      mockFns.click = async (ref) => { calls.push(`click:${ref}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 user@example.com; fill @e2 password123; click @e3',
      })

      expect(calls).toEqual([
        'fill:@e1:user@example.com',
        'fill:@e2:password123',
        'click:@e3',
      ])
      expect(result.content[0].text).toContain('Filled element @e1')
      expect(result.content[0].text).toContain('Clicked element @e3')
    })
});
});
