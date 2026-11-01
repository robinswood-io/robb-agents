import type { TextContent, ImageContent } from "@modelcontextprotocol/sdk/types.js";

import { createBrowserTools, type BrowserPaneFns } from "../../browser-tools";



export type NativeBrowserTool = ReturnType<typeof createBrowserTools>[number]

export type NativeBrowserToolHandler = NativeBrowserTool['handler']

// The SDK's extra parameter is unknown, so a test may omit this unused value.
export type BrowserToolForTest = Omit<NativeBrowserTool, 'handler'> & {
  handler: (input: Parameters<NativeBrowserToolHandler>[0], extra?: unknown) => ReturnType<NativeBrowserToolHandler>
}

// browser_tool starts with explanatory text and may attach image blocks.
export type BrowserToolResultForTest = Omit<Awaited<ReturnType<NativeBrowserToolHandler>>, 'content'> & {
  content: [TextContent, ...ImageContent[]]
}

// ============================================================================
// Mock BrowserPaneFns
// ============================================================================

export function createMockFns(): BrowserPaneFns {
  return {
    openPanel: async () => ({ instanceId: 'browser-test-1' }),
    resolveCurrentWindow: async () => ({
      instanceId: 'browser-1',
      title: 'Example Domain',
      url: 'https://example.com',
    }),
    navigate: async (url: string) => ({ url: `https://${url}`, title: 'Test Page' }),
    snapshot: async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [
        { ref: '@e1', role: 'button', name: 'Click me' },
        { ref: '@e2', role: 'textbox', name: 'Search', value: '', focused: true },
      ],
    }),
    click: async (_ref: string) => {},
    clickAt: async (_x: number, _y: number) => {},
    drag: async (_x1: number, _y1: number, _x2: number, _y2: number) => {},
    fill: async (_ref: string, _value: string) => {},
    type: async (_text: string) => {},
    select: async (_ref: string, _value: string) => {},
    setClipboard: async (_text: string) => {},
    getClipboard: async () => 'clipboard content',
    screenshot: async () => ({ imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }),
    screenshotRegion: async () => ({ imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }),
    getConsoleLogs: async () => ([
      { timestamp: Date.now(), level: 'warn', message: 'Test warning' },
    ]),
    windowResize: async (args) => ({ width: args.width, height: args.height }),
    getNetworkLogs: async () => ([
      { timestamp: Date.now(), method: 'GET', url: 'https://example.com/api', status: 500, resourceType: 'xhr', ok: false },
    ]),
    waitFor: async (args) => ({ ok: true as const, kind: args.kind, elapsedMs: 123, detail: 'condition met' }),
    sendKey: async (_args) => {},
    getDownloads: async () => ([
      { id: 'dl-1', timestamp: Date.now(), url: 'https://example.com/file.pdf', filename: 'file.pdf', state: 'completed', bytesReceived: 100, totalBytes: 100, mimeType: 'application/pdf' },
    ]),
    upload: async (_ref: string, _filePaths: string[]) => {},
    scroll: async (_dir: 'up' | 'down' | 'left' | 'right', _amount?: number) => {},
    goBack: async () => {},
    goForward: async () => {},
    evaluate: async (expr: string): Promise<unknown> => eval(expr),
    focusWindow: async (instanceId?: string) => ({ instanceId: instanceId ?? 'browser-1', title: 'Example Domain', url: 'https://example.com' }),
    releaseControl: async (_instanceId?: string) => ({ action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    closeWindow: async (_instanceId?: string) => ({ action: 'closed' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    hideWindow: async (_instanceId?: string) => ({ action: 'hidden' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    listWindows: async () => ([
      {
        id: 'browser-1',
        title: 'Example Domain',
        url: 'https://example.com',
        isVisible: true,
        ownerType: 'session',
        ownerSessionId: 'test-session',
        boundSessionId: 'test-session',
        agentControlActive: true,
      },
    ]),
    detectChallenge: async () => ({ detected: false, provider: 'none', signals: [] }),
  }
}

// ============================================================================
// Helper: execute a tool by name
// ============================================================================

export function findTool(tools: ReturnType<typeof createBrowserTools>, name: string) {
  // SDK tool objects have a .name property
  return tools.find((t) => t.name === name)
}

export async function executeTool(tools: ReturnType<typeof createBrowserTools>, name: string, args: Record<string, unknown> = {}) {
  const t: BrowserToolForTest | undefined = findTool(tools, name)
  if (!t) throw new Error(`Tool "${name}" not found`)
  // SDK tools have an execute/handler function — use the handler directly
  return t.handler(args as Parameters<NativeBrowserToolHandler>[0]) as Promise<BrowserToolResultForTest>
}
