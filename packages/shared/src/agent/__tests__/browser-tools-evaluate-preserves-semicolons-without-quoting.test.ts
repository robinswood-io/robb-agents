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

describe('array command mode', () => {
it('evaluate preserves semicolons without quoting', async () => {
      let evaluatedExpression = ''
      mockFns.evaluate = async (expression) => {
        evaluatedExpression = expression
        return 'ok'
      }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['evaluate', 'var x = 1; var y = 2; x + y'],
      })
      expect(evaluatedExpression).toBe('var x = 1; var y = 2; x + y')
      expect(result.content[0].text).toContain('ok')
    })

it('paste preserves tabs and newlines', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async () => {}
      const result = await executeTool(tools, 'browser_tool', {
        command: ['paste', 'Name\tAge\nAlice\t30'],
      })
      expect(clipboardText).toBe('Name\tAge\nAlice\t30')
      expect(result.content[0].text).toContain('paste shortcut dispatched')
    })

it('set-clipboard preserves semicolons and special characters', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['set-clipboard', 'function foo() { return 1; }'],
      })
      expect(clipboardText).toBe('function foo() { return 1; }')
      expect(result.content[0].text).toContain('Clipboard set')
    })

it('click works with array input', async () => {
      let clickedRef = ''
      mockFns.click = async (ref) => { clickedRef = ref }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['click', '@e1'],
      })
      expect(clickedRef).toBe('@e1')
      expect(result.content[0].text).toContain('Clicked element @e1')
    })

it('empty array returns error', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: [],
      })
      expect(result["isError"]).toBe(true)
      expect(result.content[0].text).toContain('Missing command')
    })

it('type preserves whitespace characters', async () => {
      let typedText = ''
      mockFns.type = async (text) => { typedText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['type', 'Hello\tWorld'],
      })
      expect(typedText).toBe('Hello\tWorld')
      expect(result.content[0].text).toContain('Requested insertion')
    })

it('--help works in array mode', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: ['--help'],
      })
      expect(result.content[0].text).toContain('browser_tool command help')
    })
});
});
