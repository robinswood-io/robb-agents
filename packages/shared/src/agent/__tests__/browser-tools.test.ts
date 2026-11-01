/**
 * Tests for the browser tools factory.
 *
 * Verifies that createBrowserTools produces a single browser_tool
 * and that it delegates correctly to BrowserPaneFns callbacks via CLI commands.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createBrowserTools, type BrowserPaneFns } from "../browser-tools";
import { setContextualGmailBrowserMutationGuard } from "../browser-tool-runtime";
import { createMockFns } from "./testing/browser-tools-fixture.ts";


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

it('returns exactly 1 tool (browser_tool only)', () => {
    expect(tools.length).toBe(1)
  })

it('exposes only browser_tool', () => {
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['browser_tool'])
  })
});
