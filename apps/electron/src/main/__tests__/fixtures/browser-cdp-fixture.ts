import { mock } from 'bun:test'
import type { WebContents } from 'electron'
type Listener = (...args: unknown[]) => void

// Mock logger before import
mock.module('../../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

const { BrowserCDP } = await import('../../browser-cdp')

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockWebContents(sendCommandImpl?: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const listeners: Record<string, Listener[]> = {}
  return {
    debugger: {
      attach: mock((_version: string) => {}),
      detach: mock(() => {}),
      sendCommand: mock(sendCommandImpl ?? (async () => ({ nodes: [] }))),
      on: mock((event: string, cb: Listener) => {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
      }),
    },
    getURL: mock(() => 'https://example.com'),
    getTitle: mock(() => 'Example Page'),
    _debuggerListeners: listeners,
    _triggerDetach: () => {
      for (const cb of listeners['detach'] || []) cb()
    },
  }
}

/** The only test interop boundary: this Electron webContents is simulated. */
export function createTestBrowserCDP(contents: ReturnType<typeof createMockWebContents>) {
  return new BrowserCDP(contents as unknown as WebContents)
}

export function requireCommandParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) throw new Error('Expected Chrome debugger command parameters')
  return params
}

export { createMockWebContents, BrowserCDP }
