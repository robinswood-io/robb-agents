import { createJSONStorage } from 'jotai/utils'
import type {
  SyncStorage,
  SyncStringStorage,
} from 'jotai/vanilla/utils/atomWithStorage'

const volatileStringStorage: SyncStringStorage = {
  getItem: (_key: string) => null,
  setItem: (_key: string, _value: string) => {},
  removeItem: (_key: string) => {},
}

/**
 * Jotai storage for metadata which may identify host workspaces or statuses.
 * The desktop app keeps its existing persistence; Remote keeps it in memory.
 */
export function createWebSafeAtomStorage<Value>(): SyncStorage<Value> {
  return createJSONStorage<Value>(() : SyncStringStorage => {
    const remoteWeb = typeof document !== 'undefined'
      && document.documentElement.dataset.robbRuntime === 'web'
    return remoteWeb ? volatileStringStorage : window.localStorage
  })
}
