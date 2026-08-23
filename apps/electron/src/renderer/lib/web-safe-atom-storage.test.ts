import { afterEach, describe, expect, it } from 'bun:test'
import { createWebSafeAtomStorage } from './web-safe-atom-storage'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

afterEach(() => {
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
  else delete (globalThis as { document?: Document }).document
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete (globalThis as { window?: Window }).window
})

function setRuntime(runtime: 'web' | 'electron', localStorage: Storage): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { dataset: { robbRuntime: runtime } } },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  })
}

describe('web-safe Jotai storage', () => {
  it('keeps workspace metadata in memory only for Remote Web', () => {
    const persistent = new MemoryStorage()
    setRuntime('web', persistent)
    const storage = createWebSafeAtomStorage<Record<string, string>>()

    storage.setItem('workspace-colors', { privateWorkspace: '#fff' })

    expect(persistent.length).toBe(0)
    expect(storage.getItem('workspace-colors', {})).toEqual({})
  })

  it('preserves desktop persistence', () => {
    const persistent = new MemoryStorage()
    setRuntime('electron', persistent)
    const storage = createWebSafeAtomStorage<Record<string, string>>()

    storage.setItem('workspace-colors', { studio: '#fff' })

    expect(storage.getItem('workspace-colors', {})).toEqual({ studio: '#fff' })
  })
})
