import type { ElectronAPI } from "../../../../shared/types.ts";
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { restoreSessionFileWatch } from '../session-files-watch'

describe('restoreSessionFileWatch', () => {
  const originalWindow = globalThis.window
  const originalConsoleError = console.error

  beforeEach(() => {
    console.error = () => {}
  })

  afterEach(() => {
    console.error = originalConsoleError
    if (originalWindow) {
      globalThis.window = originalWindow
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })

  it('re-establishes the file watch and reloads files', async () => {
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        watchSessionFiles: async (sessionId: string) => {
          calls.push(`watch:${sessionId}`)
        },
      },
    } as typeof window

    await restoreSessionFileWatch('session-1', async () => {
      calls.push('reload')
    })

    expect(calls).toEqual(['watch:session-1', 'reload'])
  })

  it('still reloads files when re-subscribing the watch fails', async () => {
    const calls: string[] = []

    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { electronAPI: ({
        watchSessionFiles: async () => {
          calls.push('watch')
          throw new Error('watch failed')
        },
      } satisfies Partial<ElectronAPI>) } })

    await restoreSessionFileWatch('session-2', async () => {
      calls.push('reload')
    })

    expect(calls).toEqual(['watch', 'reload'])
  })
})
