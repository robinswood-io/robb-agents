import { registerConversationHandlers } from "./sessions/conversation";
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { RPC_CHANNELS, type SendMessageOptions } from '@craft-agent/shared/protocol';

import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { perf } from '@craft-agent/shared/utils';
import { THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels';

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { assertRequestWorkspace, assertRequestWorkspaceAccess, pushTyped, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { setTransferableHandler } from './transfer';

interface ClientSessionWatchState {
  watcher: import('fs').FSWatcher
  sessionId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client session file watcher state (supports concurrent windows/clients safely)
const clientSessionWatches = new Map<string, ClientSessionWatchState>()

const SESSION_GET_LOG_ID_LIMIT = 25

function summarizeIds(ids: Iterable<string>, limit = SESSION_GET_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

function sessionWorkspaceDistribution(sessions: Array<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

/** RPC clients can request presentation/options, never mint host provenance. */
export function assertRpcSendMessageOptions(options?: SendMessageOptions): void {
  if (options?.internalOrigin || options?.automaticRecovery) {
    throw new Error('Internal message provenance cannot be supplied through sessions.sendMessage')
  }
}

export function getSearchableSessionIds(
  sessions: Array<{
    id: string
    hidden?: boolean
    parentSessionId?: string
    delegation?: unknown
    taskNodeId?: string
    missionWorkItemId?: string
    missionRole?: string
  }>,
): Set<string> {
  return new Set(
    sessions
      .filter(session => !session.hidden
        && !session.parentSessionId
        && !session.delegation
        && !session.taskNodeId
        && !session.missionWorkItemId
        && session.missionRole !== 'worker'
        && session.missionRole !== 'reviewer')
      .map(session => session.id),
  )
}

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

  state.watcher.close()
  clientSessionWatches.delete(clientId)
}

// Recursive directory scanner for session files
// Filters out internal files (session.jsonl) and hidden files (. prefix)
// Returns only non-empty directories
async function scanSessionDirectory(dirPath: string): Promise<import('@craft-agent/shared/protocol').SessionFile[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: import('@craft-agent/shared/protocol').SessionFile[] = []

  for (const entry of entries) {
    // Skip internal and hidden files
    if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue

    const fullPath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      // Recursively scan subdirectory
      const children = await scanSessionDirectory(fullPath)
      // Only include non-empty directories
      if (children.length > 0) {
        files.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        })
      }
    } else {
      const stats = await stat(fullPath)
      files.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size: stats.size,
      })
    }
  }

  // Sort: directories first, then alphabetically
  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
] as const

export function registerSessionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager, platform } = deps
  const log = platform.logger

  const requireContextWorkspace = (ctx: RequestContext): string => {
    if (!ctx.workspaceId) throw new Error('No workspace context')
    return ctx.workspaceId
  }

  const assertSessionAccess = (ctx: RequestContext, sessionId: string): void => {
    const workspaceId = sessionManager.getSessionWorkspaceId(sessionId)
    if (!workspaceId) throw new Error(`Session not found: ${sessionId}`)
    assertRequestWorkspace(ctx, workspaceId)
  }

  // Get all sessions for the calling window's workspace
  // Waits for initialization to complete so sessions are never returned empty during startup
  server.handle(RPC_CHANNELS.sessions.GET, async (ctx) => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_SESSIONS continuing after initialization failure:', error)
    }
    const end = perf.start('rpc.getSessions')
    const windowWorkspaceId = ctx.webContentsId != null
      ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
      : undefined
    const workspaceId = ctx.workspaceId ?? windowWorkspaceId
    if (!workspaceId) throw new Error('No workspace context')
    assertRequestWorkspace(ctx, workspaceId)
    const sessions = sessionManager.getSessions(workspaceId)
    end()

    log.info('[sessions:get] result', {
      ctxWorkspaceId: ctx.workspaceId,
      webContentsId: ctx.webContentsId,
      windowWorkspaceId,
      resolvedWorkspaceId: workspaceId,
      returnedCount: sessions.length,
      returnedWorkspaceIds: sessionWorkspaceDistribution(sessions),
      returnedIds: summarizeIds(sessions.map(s => s.id)),
    })

    return sessions
  })

  // Get unread summary for the authenticated client's active workspace.
  server.handle(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY, async (ctx) => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_UNREAD_SUMMARY continuing after initialization failure:', error)
    }
    const workspaceId = requireContextWorkspace(ctx)
    const sessions = sessionManager.getSessions(workspaceId)
    const userFacingIds = getSearchableSessionIds(sessions)
    const unread = sessions
      .filter((session) => userFacingIds.has(session.id) && !session.isArchived && session.hasUnread)
      .length
    return {
      totalUnreadSessions: unread,
      byWorkspace: { [workspaceId]: unread },
      hasUnreadByWorkspace: { [workspaceId]: unread > 0 },
    }
  })

  server.handle(RPC_CHANNELS.sessions.MARK_ALL_READ, async (ctx, workspaceId: string) => {
    assertRequestWorkspace(ctx, workspaceId)
    return sessionManager.markAllSessionsRead(workspaceId)
  })

  // Get a single session with messages (for lazy loading)
  server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async (ctx, sessionId: string) => {
    const end = perf.start('rpc.getSessionMessages')
    await assertSessionAccess(ctx, sessionId)
    const session = await sessionManager.getSession(sessionId)
    end()
    return session
  })

  // Create a new session
  server.handle(RPC_CHANNELS.sessions.CREATE, async (ctx, workspaceId: string, options?: import('@craft-agent/shared/protocol').CreateSessionOptions) => {
    assertRequestWorkspaceAccess(ctx, workspaceId)
    const end = perf.start('rpc.createSession', { workspaceId })
    // The renderer adds the session synchronously from this return value (App.tsx handleCreateSession),
    // so suppress the broadcast to avoid a redundant hydrate round-trip.
    const session = await sessionManager.createSession(workspaceId, options, { emitCreatedEvent: false })
    end()
    return session
  })

  // Delete a session
  server.handle(RPC_CHANNELS.sessions.DELETE, async (ctx, sessionId: string) => {
    await assertSessionAccess(ctx, sessionId)
    return sessionManager.deleteSession(sessionId)
  })
  registerConversationHandlers(server, deps, sessionManager, log, assertSessionAccess, assertRpcSendMessageOptions, VALID_THINKING_LEVELS_LIST)

  // ============================================================
  // Session Content Search
  // ============================================================

  // Search session content using ripgrep
  server.handle(RPC_CHANNELS.sessions.SEARCH_CONTENT, async (ctx, workspaceId: string, query: string, searchId?: string) => {
    assertRequestWorkspaceAccess(ctx, workspaceId)
    const id = searchId || Date.now().toString(36)
    log.info('[search]','ipc:request', { searchId: id, query })

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.warn('SEARCH_SESSIONS: Workspace not found:', workspaceId)
      return []
    }

    const { searchSessions } = await import('@craft-agent/server-core/services')
    const { getWorkspaceSessionsPath } = await import('@craft-agent/shared/workspaces')

    const sessionsDir = getWorkspaceSessionsPath(workspace.rootPath)
    log.debug(`SEARCH_SESSIONS: Searching "${query}" in ${sessionsDir}`)

    // Apply sidebar visibility inside the search stream, before delegated work
    // can consume the result/snippet budget reserved for root conversations.
    const searchableSessionIds = getSearchableSessionIds(sessionManager.getSessions(workspace.id))
    const results = await searchSessions(query, sessionsDir, {
      timeout: 5000,
      maxMatchesPerSession: 3,
      maxSessions: 50,
      searchId: id,
      allowedSessionIds: searchableSessionIds,
    })

    // Defensive post-filter in case an alternate search provider ignores the allowlist.
    const filteredResults = results.filter(result => searchableSessionIds.has(result.sessionId))

    log.info('[search]','ipc:response', { searchId: id, resultCount: filteredResults.length, totalFound: results.length })
    return filteredResults
  })

  // ============================================================
  // Session Info Panel (files, notes, file watching)
  // ============================================================

  // Get files in session directory (recursive tree structure)
  server.handle(RPC_CHANNELS.sessions.GET_FILES, async (ctx, sessionId: string) => {
    await assertSessionAccess(ctx, sessionId)
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return []

    try {
      return await scanSessionDirectory(sessionPath)
    } catch (error) {
      log.error('Failed to get session files:', error)
      return []
    }
  })

  // Start watching a session directory for file changes (per client)
  server.handle(RPC_CHANNELS.sessions.WATCH_FILES, async (ctx, sessionId: string) => {
    await assertSessionAccess(ctx, sessionId)
    const clientId = ctx.clientId
    cleanupSessionFileWatchForClient(clientId)

    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return

    try {
      const { watch } = await import('fs')

      const state: ClientSessionWatchState = {
        watcher: null as unknown as import('fs').FSWatcher,
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
      log.error('Failed to start session file watcher:', error)
    }
  })

  // Stop watching session files for the calling client
  server.handle(RPC_CHANNELS.sessions.UNWATCH_FILES, async (ctx) => {
    cleanupSessionFileWatchForClient(ctx.clientId)
  })

  // Get session notes (reads notes.md from session directory)
  server.handle(RPC_CHANNELS.sessions.GET_NOTES, async (ctx, sessionId: string) => {
    await assertSessionAccess(ctx, sessionId)
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return ''

    try {
      const notesPath = join(sessionPath, 'notes.md')
      const content = await readFile(notesPath, 'utf-8')
      return content
    } catch {
      // File doesn't exist yet - return empty string
      return ''
    }
  })

  // Set session notes (writes to notes.md in session directory)
  server.handle(RPC_CHANNELS.sessions.SET_NOTES, async (ctx, sessionId: string, content: string) => {
    await assertSessionAccess(ctx, sessionId)
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    try {
      const notesPath = join(sessionPath, 'notes.md')
      await writeFile(notesPath, content, 'utf-8')
    } catch (error) {
      log.error('Failed to save session notes:', error)
      throw error
    }
  })

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  // Export a session as a portable bundle
  server.handle(RPC_CHANNELS.sessions.EXPORT, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    await assertSessionAccess(ctx, sessionId)
    const workspaceId = requireContextWorkspace(ctx)

    const bundle = await sessionManager.exportSession(sessionId, workspaceId)
    if (!bundle) throw new Error(`Failed to export session ${sessionId}`)
    return bundle
  })

  // Import a session bundle into a target workspace
  // Explicit targets remain bound to the authenticated principal's workspace
  // scope; the renderer cannot expand its own authorization.
  const importHandler = async (ctx: RequestContext, targetWorkspaceId: string, bundle: unknown, mode: string) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    assertRequestWorkspaceAccess(ctx, targetWorkspaceId)
    if (mode !== 'move' && mode !== 'fork') throw new Error(`Invalid dispatch mode: ${mode}`)

    return sessionManager.importSession(targetWorkspaceId, bundle as import('@craft-agent/shared/sessions').SessionBundle, mode)
  }
  server.handle(RPC_CHANNELS.sessions.IMPORT, importHandler)
  // Also register as transferable so chunked transfer can invoke it on commit
  setTransferableHandler(RPC_CHANNELS.sessions.IMPORT, importHandler)

  // Export a session as a summarized remote-transfer payload.
  server.handle(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    await assertSessionAccess(ctx, sessionId)
    const workspaceId = requireContextWorkspace(ctx)

    const payload = await sessionManager.exportRemoteSessionTransfer(sessionId, workspaceId)
    if (!payload) throw new Error(`Failed to export remote transfer for session ${sessionId}`)
    return payload
  })

  // Import a summarized remote-transfer payload into a target workspace.
  server.handle(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, async (ctx, targetWorkspaceId: string, payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    assertRequestWorkspaceAccess(ctx, targetWorkspaceId)
    return sessionManager.importRemoteSessionTransfer(targetWorkspaceId, payload)
  })
}
