import { describe, expect, it } from 'bun:test'
import {
  isSensitiveRendererStorageKey,
  purgeSensitiveWebStorage,
} from './private-storage'

class MemoryStorage implements Storage {
  protected values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('Remote private browser metadata', () => {
  it('recognizes path, session, and workspace navigation keys', () => {
    expect(isSensitiveRendererStorageKey('craft-recent-working-dirs:workspace-1')).toBe(true)
    expect(isSensitiveRendererStorageKey('craft-session-files-expanded:session-1')).toBe(true)
    expect(isSensitiveRendererStorageKey('craft-workspace-url:studio')).toBe(true)
    expect(isSensitiveRendererStorageKey('craft-workspace-avatar-colors')).toBe(true)
    expect(isSensitiveRendererStorageKey('craft-kanban-column-status')).toBe(true)
    expect(isSensitiveRendererStorageKey('craft-theme')).toBe(false)
  })

  it('removes sensitive metadata without clearing harmless appearance preferences', () => {
    const storage = new MemoryStorage()
    storage.setItem('craft-recent-working-dirs:workspace-1', '/private/host/path')
    storage.setItem('craft-last-selected-session-id:workspace-1', 'session-secret')
    storage.setItem('craft-theme', 'dark')

    purgeSensitiveWebStorage(storage)

    expect(storage.getItem('craft-recent-working-dirs:workspace-1')).toBeNull()
    expect(storage.getItem('craft-last-selected-session-id:workspace-1')).toBeNull()
    expect(storage.getItem('craft-theme')).toBe('dark')
  })

  it('reports an erase failure instead of claiming success', () => {
    class BlockedStorage extends MemoryStorage {
      override removeItem() { throw new Error('blocked') }
    }
    const storage = new BlockedStorage()
    storage.setItem('craft-workspace-url:studio', '?session=private')
    expect(() => purgeSensitiveWebStorage(storage)).toThrow('could not be fully erased')
  })
})
