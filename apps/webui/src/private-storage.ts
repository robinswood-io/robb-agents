/**
 * Renderer keys which can contain host paths, session identifiers, workspace
 * navigation state, labels, or other private metadata. Remote keeps these
 * ephemeral; only the explicitly enabled encrypted vault may retain private
 * offline content.
 */
export const SENSITIVE_RENDERER_STORAGE_PREFIXES = [
  'craft-recent-working-dirs',
  'craft-session-files-expanded',
  'craft-tabs',
  'craft-workspace-url',
  'craft-last-selected-session-id',
  'craft-turncard-expansion',
  'craft-expanded-folders',
  'craft-collapsed-sidebar-items',
  'craft-collapsed-session-groups',
  'craft-view-filters',
  'craft-label-filter',
  'craft-list-filter',
  'craft-workspace-avatar-colors',
  'craft-kanban-column-status',
] as const

const WEB_SESSION_INVALIDATION_KEY = 'robb-agents.remote.web-session-epoch.v1'
const WEB_SESSION_CHANNEL = 'robb-agents-remote-web-session-v1'
let webSessionChannel: BroadcastChannel | null | undefined

function getWebSessionChannel(): BroadcastChannel | null {
  if (webSessionChannel !== undefined) return webSessionChannel
  try {
    webSessionChannel = typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel(WEB_SESSION_CHANNEL)
  } catch {
    webSessionChannel = null
  }
  return webSessionChannel
}

/** Notify every same-origin tab that its authenticated Web session must close. */
export function broadcastWebSessionInvalidation(): void {
  const epoch = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random()}`
  try { window.localStorage.setItem(WEB_SESSION_INVALIDATION_KEY, epoch) } catch { /* BroadcastChannel may still work */ }
  try { getWebSessionChannel()?.postMessage({ type: 'invalidate', epoch }) } catch { /* current tab still signs out */ }
}

export function subscribeWebSessionInvalidation(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === WEB_SESSION_INVALIDATION_KEY && event.newValue) callback()
  }
  const channel = getWebSessionChannel()
  const onMessage = (event: MessageEvent) => {
    if (event.data && typeof event.data === 'object' && event.data.type === 'invalidate') callback()
  }
  window.addEventListener('storage', onStorage)
  channel?.addEventListener('message', onMessage)
  return () => {
    window.removeEventListener('storage', onStorage)
    channel?.removeEventListener('message', onMessage)
  }
}

export function isSensitiveRendererStorageKey(key: string): boolean {
  return SENSITIVE_RENDERER_STORAGE_PREFIXES.some((prefix) => (
    key === prefix || key.startsWith(`${prefix}:`) || key.startsWith(`${prefix}-`)
  ))
}

export function purgeSensitiveWebStorage(storage: Storage = window.localStorage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key !== null)
    .filter(isSensitiveRendererStorageKey)
  const failures: string[] = []
  for (const key of keys) {
    try {
      storage.removeItem(key)
    } catch {
      failures.push(key)
    }
  }
  if (failures.length > 0) {
    throw new Error('Private browser metadata could not be fully erased')
  }
}
