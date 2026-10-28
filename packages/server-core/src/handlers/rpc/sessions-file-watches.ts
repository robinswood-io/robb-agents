import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { pushTyped, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport';

interface ClientSessionWatchState {
  watcher: import('fs').FSWatcher | null
  sessionId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client session file watcher state (supports concurrent windows/clients safely)
const clientSessionWatches = new Map<string, ClientSessionWatchState>()

/**
 * Clean up session file watcher for a client.
 * Called from main process disconnect hooks to prevent watcher leaks.
 */
export function cleanupSessionFileWatchForClient(clientId: string): void {
  const state = clientSessionWatches.get(clientId)
  if (!state) return

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }

  state.watcher?.close()
  clientSessionWatches.delete(clientId)
}

interface SessionFileWatchDeps {
  assertSessionAccess: (ctx: RequestContext, sessionId: string) => void | Promise<void>;
  getSessionPath: (sessionId: string) => string | null | undefined;
  onError: (error: unknown) => void;
}

/** Native file notifications are shared by Electron and the standalone Node server. */
export function registerSessionFileWatchHandlers(server: RpcServer, deps: SessionFileWatchDeps): void {
  // Start watching a session directory for file changes (per client)
  server.handle(RPC_CHANNELS.sessions.WATCH_FILES, async (ctx, sessionId: string) => {
    await deps.assertSessionAccess(ctx, sessionId)
    const clientId = ctx.clientId
    cleanupSessionFileWatchForClient(clientId)

    const sessionPath = deps.getSessionPath(sessionId)
    if (!sessionPath) return

    try {
      const { watch } = await import('fs')

      const state: ClientSessionWatchState = {
        watcher: null,
        sessionId,
        debounceTimer: null,
      }

      state.watcher = watch(sessionPath, { recursive: true }, (_eventType, filename) => {
        // Ignore internal files and hidden files
        if (filename && (filename.includes('session.jsonl') || filename.startsWith('.'))) {
          return
        }

        // Debounce: wait 100ms before notifying to batch rapid changes
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer)
        }

        state.debounceTimer = setTimeout(() => {
          pushTyped(server, RPC_CHANNELS.sessions.FILES_CHANGED, { to: 'client', clientId }, state.sessionId)
        }, 100)
      })

      clientSessionWatches.set(clientId, state)
    } catch (error) {
      deps.onError(error)
    }
  })

  // Stop watching session files for the calling client
  server.handle(RPC_CHANNELS.sessions.UNWATCH_FILES, async (ctx) => {
    cleanupSessionFileWatchForClient(ctx.clientId)
  })

}
