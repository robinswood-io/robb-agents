/**
 * Tests for the browser tools factory.
 *
 * Verifies that createBrowserTools produces a single browser_tool
 * and that it delegates correctly to BrowserPaneFns callbacks via CLI commands.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createBrowserTools, type BrowserPaneFns, type BrowserWaitArgs } from "../browser-tools";
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
it('parses quoted wait text values with spaces', async () => {
      let waitArgs: BrowserWaitArgs | undefined
      mockFns.waitFor = async (args) => {
        waitArgs = args
        return { ok: true as const, kind: args.kind, elapsedMs: 42, detail: 'condition met' }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'wait text "hello world" 5000',
      })

      expect(waitArgs).toEqual({ kind: 'text', value: 'hello world', timeoutMs: 5000 })
      expect(result.content[0].text).toContain('Wait succeeded')
    })

it('routes key command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'key Enter' })
      expect(result.content[0].text).toContain('Key sent: Enter')
    })

it('routes downloads command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'downloads list 10' })
      expect(result.content[0].text).toContain('Downloads (')
    })

it('includes savePath in downloads output when available', async () => {
      mockFns.getDownloads = async () => ([
        {
          id: 'dl-42',
          timestamp: Date.now(),
          url: 'https://example.com/file.pdf',
          filename: 'file.pdf',
          state: 'completed',
          bytesReceived: 100,
          totalBytes: 100,
          mimeType: 'application/pdf',
          savePath: '/tmp/downloads/file.pdf',
        },
      ])

      const result = await executeTool(tools, 'browser_tool', { command: 'downloads list 10' })
      expect(result.content[0].text).toContain('-> /tmp/downloads/file.pdf')
    })

it('routes scroll command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'scroll down 800' })
      expect(result.content[0].text).toContain('Scrolled down')
    })

it('routes back command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'back' })
      expect(result.content[0].text).toContain('Navigated back')
    })

it('routes forward command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'forward' })
      expect(result.content[0].text).toContain('Navigated forward')
    })

it('routes evaluate command', async () => {
      mockFns.evaluate = async () => ({ key: 'value' })
      const result = await executeTool(tools, 'browser_tool', { command: 'evaluate 1+1' })
      expect(result.content[0].text).toContain('"key"')
    })

it('preserves quoted evaluate expressions with semicolons', async () => {
      let evaluatedExpression = ''
      mockFns.evaluate = async (expression) => {
        evaluatedExpression = expression
        return 'ok'
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'evaluate "document.title + \';\' + location.href"',
      })

      expect(evaluatedExpression).toBe("document.title + ';' + location.href")
      expect(result.content[0].text).toContain('ok')
    })

it('lists browser windows via windows command without release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'windows' })
      expect(result.content[0].text).toContain('Browser windows (1)')
      expect(result.content[0].text).toContain('browser-1')
      expect(result.content[0].text).toContain('ownerType: session')
      expect(result.content[0].text).toContain('lockState: locked-session(test-session)')
      expect(result.content[0].text).toContain('availableToSession: true')
      expect(result.content[0].text).toContain('agentControlActive: true')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('routes focus command and calls focusWindow', async () => {
      let focusedId: string | undefined
      mockFns.focusWindow = async (instanceId?: string) => {
        focusedId = instanceId
        return { instanceId: instanceId ?? 'browser-1', title: 'Focused Tab', url: 'https://focused.example' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'focus browser-1' })

      expect(focusedId).toBe('browser-1')
      expect(result.content[0].text).toContain('Focused browser window browser-1')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

it('routes release command and calls releaseControl without hint', async () => {
      let requestedId: string | undefined
      mockFns.releaseControl = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'release' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser control released')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('routes close command and calls closeWindow without hint', async () => {
      let requestedId: string | undefined
      mockFns.closeWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'closed' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'close' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser window closed and destroyed')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('routes hide command and calls hideWindow without hint', async () => {
      let requestedId: string | undefined
      mockFns.hideWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'hidden' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'hide' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser window hidden')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

it('routes close command with explicit window id', async () => {
      let requestedId: string | undefined
      mockFns.closeWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'closed' as const, ...(instanceId !== undefined ? { requestedInstanceId: instanceId, resolvedInstanceId: instanceId } : {}), affectedIds: instanceId ? [instanceId] : [] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'close browser-9' })

      expect(requestedId).toBe('browser-9')
      expect(result.content[0].text).toContain('Browser window closed and destroyed')
      expect(result.content[0].text).toContain('requested=browser-9')
    })

it('reports close no-op explicitly', async () => {
      mockFns.closeWindow = async (instanceId?: string) => ({
        action: 'noop' as const,
        ...(instanceId !== undefined ? { requestedInstanceId: instanceId } : {}),
        affectedIds: [],
        reason: 'No close target is currently associated with this session.',
      })

      const result = await executeTool(tools, 'browser_tool', { command: 'close' })

      expect(result.content[0].text).toContain('No browser window was closed')
      expect(result.content[0].text).toContain('No window state changed')
      expect(result.content[0].text).toContain('No close target is currently associated with this session')
    })

it('returns validation feedback for invalid command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'scroll diagonal' })
      expect(result["isError"]).toBe(true)
      expect(result.content[0].text).toContain('scroll requires direction')
    })

it('returns parse error for unclosed quotes', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'fill @e1 "unterminated' })
      expect(result["isError"]).toBe(true)
      expect(result.content[0].text).toContain('Parse error: unclosed quote')
    })

it('returns error for unknown command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'teleport' })
      expect(result["isError"]).toBe(true)
      expect(result.content[0].text).toContain('Unknown browser_tool command')
    })
});
});
