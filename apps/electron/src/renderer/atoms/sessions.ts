/**
 * Per-Session State Management with Jotai
 *
 * Uses atomFamily to create isolated atoms per session.
 * Updates to one session don't trigger re-renders in other sessions.
 *
 * This solves the performance issue where streaming in Session A
 * caused re-renders and focus loss in Session B.
 */

import { atom } from 'jotai'
import type { Getter, Setter } from 'jotai/vanilla'
import { atomFamily } from 'jotai-family'
import type { Session, Message } from '../../shared/types'
import { mergeUserInputRequests } from '../lib/user-input-state'
import { getSessionProcessingRevision, markSessionProcessingState } from '../lib/session-processing-state'
import { resolveObjectiveSessionStatus } from '../utils/session-status'

/**
 * Session metadata for list display (lightweight, no messages)
 * Used by SessionList to avoid re-rendering on message changes
 */
export interface SessionMeta {
  id: string
  name?: string
  /** Preview of first user message (for title fallback) */
  preview?: string
  workspaceId: string
  lastMessageAt?: number
  isProcessing?: boolean
  hasPendingUserInput?: boolean
  hasPendingAuth?: boolean
  isFlagged?: boolean
  lastReadMessageId?: string
  workingDirectory?: string
  enabledSourceSlugs?: string[]
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string
  /** ID of the last final (non-intermediate) assistant message - for unread detection */
  lastFinalMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  /** Labels for filtering (additive tags, many-per-session) */
  labels?: string[]
  /** Permission mode ('safe', 'ask', 'allow-all') — used by view expressions */
  permissionMode?: string
  /** Session status for filtering */
  sessionStatus?: string
  /** Host objective truth used to project a coherent terminal UI status. */
  activeObjective?: Session['activeObjective']
  pendingTurnRecovery?: Session['pendingTurnRecovery']
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  /** Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration) */
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  /** Model override for this session */
  model?: string
  /** Whether the model is an explicit user choice rather than Auto. */
  modelRoutePinned?: boolean
  /** LLM connection slug for this session */
  llmConnection?: string
  /** Token usage stats (from JSONL header, available without loading messages) */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    contextTokens: number
  }
  /** When the session was created (ms timestamp) */
  createdAt?: number
  /** Total number of messages in this session */
  messageCount?: number
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** Workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task) */
  parentSessionId?: string
  /** Host-owned autonomous delegation lineage (fallback when direct lineage hydrates late). */
  delegation?: Session['delegation']
  /** Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus */
  kanbanColumn?: string
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes) */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (Conductor-owned children only) */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (Conductor-owned children only) */
  taskNodeId?: string
  /** Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator while children spawn lazily */
  taskNodeCount?: number
  /** Tasks Conductor: a generate-time draft orchestrator, hidden from the board until adopted by createTask. */
  taskDraft?: boolean
  /** Mission v2 internal child identity. */
  missionWorkItemId?: string
  missionRole?: Session['missionRole']
}

/**
 * Find the last final (non-intermediate) assistant or plan message ID
 */
function findLastFinalMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Include plan messages as final responses (they're AI-generated content)
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate && !msg.isStreaming && !msg.isPending) {
      return msg.id
    }
  }
  return undefined
}

/**
 * Extract metadata from a full session object
 */
export function extractSessionMeta(session: Session): SessionMeta {
  const messages = session.messages || []

  // Destructure fields that don't exist on SessionMeta or need overrides
  const {
    messages: _msgs, sessionFolderPath: _sf, supportsBranching: _sb,
    pendingAuthRequestMessage: _pendingAuth, userInputRequests: _userInputRequests,
    workspaceName: _wn, thinkingLevel: _tl, currentStatus: _cs,
    isAsyncOperationOngoing, isRegeneratingTitle,
    messageCount, lastFinalMessageId: sessionLastFinal,
    ...sessionFields
  } = session

  return {
    ...sessionFields,
    // Objective state is the durable execution truth. Do not let a stale
    // lifecycle status render completed work as review-pending, or exhausted
    // work as still in progress.
    sessionStatus: resolveObjectiveSessionStatus(session),
    hasPendingUserInput: session.userInputRequests?.some(request => request.status === 'pending') ?? false,
    hasPendingAuth: !!session.pendingAuthRequestMessage,
    lastFinalMessageId: sessionLastFinal ?? findLastFinalMessageId(messages),
    // Math.max, not ??: streaming appends grow `messages` without touching the
    // session's `messageCount` field, so a defined-but-stale count (stamped at
    // load/creation) must never shadow the live length. Meta-only sessions
    // (empty `messages`) keep the server/header count.
    messageCount: Math.max(messageCount ?? 0, messages.length),
    isAsyncOperationOngoing: isAsyncOperationOngoing ?? isRegeneratingTitle,
    isRegeneratingTitle,
  } as SessionMeta
}

/**
 * Atom family for individual session state
 * Each session gets its own atom - updates are isolated
 */
export const sessionAtomFamily = atomFamily(
  (_sessionId: string) => atom<Session | null>(null),
  (a, b) => a === b
)

/**
 * Atom for session metadata map (for list display)
 * Only contains lightweight data needed for SessionList
 */
export const sessionMetaMapAtom = atom<Map<string, SessionMeta>>(new Map())

/**
 * Derived atom: ordered list of session IDs (for list ordering)
 */
export const sessionIdsAtom = atom<string[]>([])

/**
 * Track which sessions have had their messages loaded (for lazy loading)
 * Sessions are loaded with empty messages initially, messages are fetched on-demand
 */
export const loadedSessionsAtom = atom<Set<string>>(new Set<string>())

/**
 * Promise cache for deduplicating concurrent session load requests.
 * Prevents race condition where multiple calls (e.g., from React re-renders)
 * start loading before the first completes and marks the session as loaded.
 * Module-level map since it tracks in-flight promises, not React state.
 */
const sessionLoadingPromises = new Map<string, Promise<Session | null>>()

/**
 * Currently active session ID - the session displayed in the main content area
 * This replaces the tab-based session selection
 */
export const activeSessionIdAtom = atom<string | null>(null)

// NOTE: sessionsAtom REMOVED to fix memory leak
// The sessions array with messages was being retained by Jotai's internal state.
// Instead, we now use:
// - sessionMetaMapAtom for listing (lightweight metadata, no messages)
// - sessionAtomFamily(id) for individual session data
// - initializeSessionsAtom for bulk initialization
// - addSessionAtom, removeSessionAtom for individual operations

/**
 * Action atom: update a single session
 * Only triggers re-render in components subscribed to this specific session
 */
export const updateSessionAtom = atom(
  null,
  (get, set, sessionId: string, updater: (prev: Session | null) => Session | null) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const currentSession = get(sessionAtom)
    const newSession = updater(currentSession)
    set(sessionAtom, newSession)

    // Also update metadata if session exists
    if (newSession) {
      const metaMap = get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, extractSessionMeta(newSession))
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom: update only session metadata (for list display updates)
 * Doesn't affect the full session atom
 */
export const updateSessionMetaAtom = atom(
  null,
  (get, set, sessionId: string, updates: Partial<SessionMeta>) => {
    const metaMap = get(sessionMetaMapAtom)
    const existing = metaMap.get(sessionId)
    if (existing) {
      const newMetaMap = new Map(metaMap)
      const updated = { ...existing, ...updates }
      newMetaMap.set(sessionId, {
        ...updated,
        sessionStatus: resolveObjectiveSessionStatus(updated),
      })
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom: replace a session with an authoritative full session payload.
 *
 * Use this for data returned by getSessionMessages() or createSession(), where
 * the `messages` array is known to represent the loaded transcript. Keeping the
 * full session atom and loadedSessionsAtom in one write prevents the chat panel
 * from hiding real messages behind a stale lazy-loading spinner.
 */
export const replaceLoadedSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    const current = get(sessionAtomFamily(session.id))
    if (current?.userInputRequests?.length) {
      session = { ...session, userInputRequests: mergeUserInputRequests(current.userInputRequests, session.userInputRequests) }
    }
    session = markSessionProcessingState(session)
    set(sessionAtomFamily(session.id), session)

    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.set(session.id, extractSessionMeta(session))
    set(sessionMetaMapAtom, newMetaMap)

    const loadedSessions = get(loadedSessionsAtom)
    if (!loadedSessions.has(session.id)) {
      const newLoadedSessions = new Set(loadedSessions)
      newLoadedSessions.add(session.id)
      set(loadedSessionsAtom, newLoadedSessions)
    }
  }
)

/**
 * Action atom: append message to session (for streaming)
 * Optimized to only update the specific session
 * Note: Does NOT update lastMessageAt - caller must handle timestamp updates
 * to avoid session list jumping on intermediate/tool messages
 */
export const appendMessageAtom = atom(
  null,
  (get, set, sessionId: string, message: Message) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (session) {
      set(sessionAtom, {
        ...session,
        messages: [...session.messages, message],
        // Don't update lastMessageAt here - only user messages and final responses should update it
      })
    }
  }
)

/**
 * Action atom: update streaming content for a session
 * For text_delta events - appends to the last streaming message
 */
export const updateStreamingContentAtom = atom(
  null,
  (get, set, sessionId: string, content: string, turnId?: string) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (!session) return

    const messages = [...session.messages]
    const lastMsg = messages[messages.length - 1]

    // Append to existing streaming message
    if (lastMsg?.role === 'assistant' && lastMsg.isStreaming &&
        (!turnId || lastMsg.turnId === turnId)) {
      messages[messages.length - 1] = {
        ...lastMsg,
        content: lastMsg.content + content,
      }
      set(sessionAtom, { ...session, messages })
    }
  }
)

/**
 * Action atom: initialize sessions from loaded data
 */
export const initializeSessionsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    // Clean up stale atom family entries from previous workspace.
    // Without this, switching workspaces leaves orphaned atoms in memory
    // and components subscribed to old session IDs see stale/empty data.
    const oldIds = get(sessionIdsAtom)
    const newIdSet = new Set(sessions.map(s => s.id))
    for (const oldId of oldIds) {
      if (!newIdSet.has(oldId)) {
        sessionAtomFamily.remove(oldId)
        backgroundTasksAtomFamily.remove(oldId)
      }
    }
    // Reset loaded sessions tracking — new workspace needs fresh lazy loading
    set(loadedSessionsAtom, new Set<string>())

    // Set individual session atoms
    for (const session of sessions) {
      set(sessionAtomFamily(session.id), markSessionProcessingState(session))
    }

    // Build metadata map
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      metaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, metaMap)

    // Set ordered IDs (sorted by lastMessageAt desc)
    const ids = sessions
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, ids)

    // NOTE: Do NOT mark sessions as loaded here
    // Sessions from getSessions() have empty messages: [] to save memory
    // Messages are lazy-loaded via ensureSessionMessagesLoadedAtom when session is opened
    // This reduces initial memory usage from ~500MB to ~50MB for 300+ sessions
  }
)

/**
 * Action atom: refresh session metadata after a stale reconnect.
 *
 * Unlike initializeSessionsAtom (which resets everything for workspace switches),
 * this preserves messages for already-loaded sessions and only marks overwritten
 * metadata-only sessions as unloaded for lazy re-fetching.
 *
 * All cross-atom mutations happen inside a single write transaction so that
 * React subscribers see one consistent update instead of intermediate states.
 */
export const refreshSessionsMetadataAtom = atom(
  null,
  (
    get,
    set,
    payload: { sessions: Session[]; loadedSessionIds: Set<string>; removeMissing?: boolean }
  ): Map<string, SessionMeta> => {
    const { sessions, loadedSessionIds, removeMissing = true } = payload

    // Remove stale sessions only for authoritative refreshes. Stale reconnect
    // recovery can receive a transient partial list immediately after sleep/wake;
    // treating that as authoritative is what makes the sidebar collapse to the
    // single active session. In non-destructive mode we upsert returned sessions
    // and preserve missing metadata until a confirmed delete/workspace reload.
    const currentIds = get(sessionIdsAtom)
    const latestIds = new Set(sessions.map(s => s.id))
    if (removeMissing) {
      for (const staleId of currentIds) {
        if (!latestIds.has(staleId)) {
          set(removeSessionAtom, staleId)
        }
      }
    }

    // Update each session atom, preserving messages for loaded sessions
    const unloadedIds: string[] = []
    for (const session of sessions) {
      const currentSession = get(sessionAtomFamily(session.id))
      const shouldPreserveMessages = !!currentSession && loadedSessionIds.has(session.id)
      const nextSession = { ...session,
        ...(shouldPreserveMessages && currentSession ? { messages: currentSession.messages } : {}),
        userInputRequests: mergeUserInputRequests(currentSession?.userInputRequests, session.userInputRequests),
      }

      set(sessionAtomFamily(session.id), markSessionProcessingState(nextSession))

      // Track sessions that lost their messages so lazy-loading re-fetches them
      if (!shouldPreserveMessages && loadedSessionIds.has(session.id)) {
        unloadedIds.push(session.id)
      }
    }

    // Remove overwritten sessions from loadedSessionsAtom
    if (unloadedIds.length > 0) {
      const nextLoaded = new Set(get(loadedSessionsAtom))
      for (const id of unloadedIds) nextLoaded.delete(id)
      set(loadedSessionsAtom, nextLoaded)
    }

    // Build and set metadata map. Non-destructive refresh starts from the
    // existing map so sessions omitted by a transient partial response remain
    // visible. Returned sessions are still authoritative for their own fields.
    const nextMetaMap = removeMissing
      ? new Map<string, SessionMeta>()
      : new Map(get(sessionMetaMapAtom))
    for (const session of sessions) {
      nextMetaMap.set(session.id, extractSessionMeta(get(sessionAtomFamily(session.id)) ?? session))
    }
    set(sessionMetaMapAtom, nextMetaMap)

    // Set ordered IDs from the metadata map we actually exposed to the UI.
    const nextIds = Array.from(nextMetaMap.values())
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, nextIds)

    return nextMetaMap
  }
)

/**
 * Action atom: add a new session
 */
export const addSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    session = markSessionProcessingState(session)
    // Set session atom
    set(sessionAtomFamily(session.id), session)

    // Add to metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.set(session.id, extractSessionMeta(session))
    set(sessionMetaMapAtom, newMetaMap)

    // Add to beginning of IDs list
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, [session.id, ...ids])

    // Mark as loaded (new sessions are complete - no lazy loading needed)
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.add(session.id)
    set(loadedSessionsAtom, newLoadedSessions)
  }
)

/**
 * Action atom: remove a session
 */
export const removeSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    // Clear session atom value first
    set(sessionAtomFamily(sessionId), null)
    // Remove atom from family cache to allow GC of the atom and its stored value
    sessionAtomFamily.remove(sessionId)

    // Remove from metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.delete(sessionId)
    set(sessionMetaMapAtom, newMetaMap)

    // Remove from IDs list
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, ids.filter(id => id !== sessionId))

    // Remove from loaded sessions tracking
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, newLoadedSessions)

    // Clean up additional atom families to prevent memory leaks
    // These store per-session UI state that should be garbage collected
    backgroundTasksAtomFamily.remove(sessionId)
  }
)

/**
 * Action atom: sync React state to per-session atoms
 *
 * This is the key to the hybrid approach:
 * - React state (sessions array) remains the source of truth
 * - This atom syncs changes to per-session atoms automatically
 * - Components using useSession(id) get isolated updates
 * - Jotai's referential equality prevents unnecessary re-renders
 *
 * IMPORTANT: During streaming, the atom is the source of truth.
 * Streaming events (text_delta, tool_start, tool_result) update atoms directly
 * and bypass React state for performance. We must NOT overwrite atoms for
 * sessions that are processing, or we lose streaming data (tool calls, text).
 * Once a "handoff" event (complete, error, etc.) occurs, React state catches up
 * and sync works normally again.
 */
export const syncSessionsToAtomsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    const loadedSessions = get(loadedSessionsAtom)

    // Update each session atom
    for (const session of sessions) {
      const sessionAtom = sessionAtomFamily(session.id)
      const atomSession = get(sessionAtom)

      // CRITICAL: If the atom's session is processing, it has streaming updates
      // that React state doesn't know about yet. Don't overwrite - atom is
      // source of truth during streaming. The handoff event will reconcile.
      if (atomSession?.isProcessing) {
        continue
      }

      // CRITICAL: If session messages were lazy-loaded, atom has full messages
      // but React state may have empty array. Only skip if React would lose messages.
      // Allow sync when React has MORE messages (e.g., user just sent a message).
      if (loadedSessions.has(session.id) && atomSession) {
        const atomMessageCount = atomSession.messages?.length ?? 0
        const reactMessageCount = session.messages?.length ?? 0
        // Skip sync only if React has fewer messages (would lose data)
        if (reactMessageCount < atomMessageCount) {
          continue
        }
      }

      // Only update if the session object is different (referential check)
      // This prevents unnecessary re-renders when the session hasn't changed
      if (atomSession !== session) {
        set(sessionAtom, { ...session, userInputRequests: mergeUserInputRequests(atomSession?.userInputRequests, session.userInputRequests) })
      }
    }

    // Update metadata map for list display
    // Note: We still update metadata from React state, which is fine because
    // metadata doesn't include messages - the streaming content we're protecting
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      const meta = extractSessionMeta(session)
      // Preserve isProcessing from atom if atom is processing
      // React state may have stale isProcessing: false during streaming
      const atomSession = get(sessionAtomFamily(session.id))
      meta.hasPendingUserInput = atomSession?.userInputRequests?.some(request => request.status === 'pending') ?? meta.hasPendingUserInput
      if (atomSession?.isProcessing) {
        meta.isProcessing = true
      }
      metaMap.set(session.id, meta)
    }
    set(sessionMetaMapAtom, metaMap)

    // Update ordered IDs (preserve order from React state)
    set(sessionIdsAtom, sessions.map(s => s.id))
  }
)

// loadedSessionsAtom moved up before sessionsAtom (needed for self-syncing)

/** Merge a fetched history with events delivered while it was loading. */
function mergeHydratedMessages(history: Message[], current: Message[], beforeFetch: Message[], keepLiveTail: boolean): Message[] {
  const initialReferences = new Set(beforeFetch)
  const initiallyCompletedAssistantIds = new Set(beforeFetch.filter(message => message.role === 'assistant' && !message.isStreaming && !message.isPending).map(message => message.id))
  const currentIds = new Set(current.map(message => message.id))
  const removedQueuedIds = new Set(beforeFetch.filter(message => message.role === 'user' && message.isQueued && !currentIds.has(message.id)).map(message => message.id))
  const merged = history.filter(message => !removedQueuedIds.has(message.id))
  const temporary = (message: Message) => message.role === 'assistant' && !!(message.isStreaming || message.isPending)

  for (const live of current) {
    let index = merged.findIndex(message => message.id === live.id)
    if (index < 0 && live.role === 'tool' && live.toolUseId) {
      index = merged.findIndex(message => message.role === 'tool' && message.toolUseId === live.toolUseId)
    }
    if (index < 0 && live.role === 'auth-request' && live.authRequestId) {
      index = merged.findIndex(message => message.role === 'auth-request' && message.authRequestId === live.authRequestId)
    }
    if (index < 0 && live.role === 'assistant' && live.turnId) {
      // text_complete can finalize a stream as commentary too. A shared turn
      // alone is insufficient: another stream can start after an earlier comment.
      for (let i = merged.length - 1; i >= 0; i--) {
        const candidate = merged[i]!
        if (candidate.role === 'assistant' && candidate.turnId === live.turnId
          && candidate.parentToolUseId === live.parentToolUseId && (temporary(candidate) || temporary(live))
          && !(temporary(live) && initiallyCompletedAssistantIds.has(candidate.id))
          && candidate.content && live.content
          && (candidate.content.startsWith(live.content) || live.content.startsWith(candidate.content))) {
          index = i
          break
        }
      }
    }

    const changedDuringFetch = !initialReferences.has(live)
    if (index < 0) {
      if (changedDuringFetch || keepLiveTail) merged.push(live)
      continue
    }
    const fetched = merged[index]!
    // A complete response outranks a partial stream whichever arrives first.
    const useLive = temporary(fetched) && !temporary(live)
      || (changedDuringFetch && !(temporary(live) && !temporary(fetched)))
    if (useLive) {
      merged[index] = { ...fetched, ...live, id: temporary(fetched) && !temporary(live) ? live.id : fetched.id }
    }
  }
  return merged.sort((left, right) => left.timestamp - right.timestamp)
}

/**
 * Action atom: Load session messages if not already loaded
 * Returns the loaded session or current session if already loaded.
 * Uses promise deduplication to prevent redundant IPC calls from concurrent requests.
 *
 * Runtime processing state is reconciled from the fresh host snapshot unless
 * a newer processing signal arrived while fetching (including a same-value Stop).
 * UI state fields (hasUnread, isFlagged, sessionStatus, etc.) are preserved from
 * the in-memory atom, NOT overwritten with potentially stale disk data.
 * This prevents a race condition where optimistic updates (e.g., clearing the
 * NEW badge on session view) get clobbered by async message loading that reads
 * older state from disk.
 */
async function loadSessionMessages(
  get: Getter,
  set: Setter,
  sessionId: string,
  options?: { force?: boolean },
): Promise<Session | null> {
  const force = options?.force ?? false

  if (force) {
    const nextLoadedSessions = new Set(get(loadedSessionsAtom))
    nextLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, nextLoadedSessions)

    // Clear any stale in-flight request so the caller gets a fresh fetch.
    sessionLoadingPromises.delete(sessionId)
  } else {
    const loadedSessions = get(loadedSessionsAtom)

    // Already loaded, return current session
    if (loadedSessions.has(sessionId)) {
      return get(sessionAtomFamily(sessionId))
    }
  }

  // Check if already loading - return existing promise to deduplicate concurrent calls
  const existingPromise = sessionLoadingPromises.get(sessionId)
  if (existingPromise) {
    return existingPromise
  }

  // Create the loading promise with all the fetch and update logic
  const loadPromise = (async (): Promise<Session | null> => {
    // Event reducers replace changed messages, so these references distinguish
    // old atom data from updates that must win over an in-flight response.
    const sessionBeforeFetch = get(sessionAtomFamily(sessionId))
    const messagesBeforeFetch = sessionBeforeFetch?.messages ?? []
    const processingRevisionBeforeFetch = getSessionProcessingRevision(sessionBeforeFetch)
    // Fetch messages from main process
    const loadedSession = await window.electronAPI.getSessionMessages(sessionId)
    if (!loadedSession) {
      return get(sessionAtomFamily(sessionId))
    }

    // Merge messages and disk-only fields into existing session, preserving in-memory UI state.
    // The renderer's atom is authoritative for UI fields (hasUnread, isFlagged, etc.)
    // because optimistic updates may have changed them since the disk write.
    // tokenUsage and sessionFolderPath are only returned by getSession() (not getSessions()),
    // so they must be explicitly merged here to be available after app restart.
    const existingSession = get(sessionAtomFamily(sessionId))
    const acceptProcessingSnapshot = typeof loadedSession.isProcessing === 'boolean'
      && getSessionProcessingRevision(existingSession) === processingRevisionBeforeFetch
      && existingSession?.isProcessing === sessionBeforeFetch?.isProcessing
    const isProcessing = acceptProcessingSnapshot ? loadedSession.isProcessing : existingSession?.isProcessing
    const preservedStaleMessages = !!existingSession
      && existingSession.messages.length > 0
      && (!loadedSession.messages || loadedSession.messages.length === 0)

    let mergedSession = existingSession
      ? {
          ...existingSession,
          isProcessing: isProcessing ?? existingSession.isProcessing,
          // Even one live tool event can precede the history response on cold
          // start. Merge it with history instead of declaring that fragment loaded.
          messages: preservedStaleMessages
            ? existingSession.messages
            : mergeHydratedMessages(loadedSession.messages ?? [], existingSession.messages, messagesBeforeFetch, isProcessing ?? existingSession.isProcessing),
          userInputRequests: mergeUserInputRequests(existingSession.userInputRequests, loadedSession.userInputRequests),
          tokenUsage: loadedSession.tokenUsage ?? existingSession.tokenUsage,
          sessionFolderPath: loadedSession.sessionFolderPath ?? existingSession.sessionFolderPath,
        }
      : loadedSession
    // A completed fresh load is itself a processing snapshot. Mark it so an
    // older request still in flight cannot overwrite it, even at the same value.
    if (acceptProcessingSnapshot) mergedSession = markSessionProcessingState(mergedSession)
    set(sessionAtomFamily(sessionId), mergedSession)

    // Reconcile processing and lastFinalMessageId with the same merged state.
    // Don't replace the full meta entry — other fields are maintained through
    // optimistic updates and IPC events, and may be ahead of disk state.
    const lastFinalMessageId = findLastFinalMessageId(mergedSession.messages)
    const metaMap = get(sessionMetaMapAtom)
    const existingMeta = metaMap.get(sessionId)
    if (existingMeta && (existingMeta.isProcessing !== mergedSession.isProcessing
      || (lastFinalMessageId && existingMeta.lastFinalMessageId !== lastFinalMessageId))) {
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, { ...existingMeta, isProcessing: mergedSession.isProcessing,
        ...(lastFinalMessageId ? { lastFinalMessageId } : {}),
      })
      set(sessionMetaMapAtom, newMetaMap)
    }

    // Mark as loaded only when we received a fresh payload.
    // If we had to preserve stale in-memory messages because the backend returned
    // an empty array during lazy-load recovery, keep the session reloadable.
    if (!preservedStaleMessages) {
      const newLoadedSessions = new Set(get(loadedSessionsAtom))
      newLoadedSessions.add(sessionId)
      set(loadedSessionsAtom, newLoadedSessions)
    }

    return mergedSession
  })()

  // Cache the promise before awaiting
  sessionLoadingPromises.set(sessionId, loadPromise)

  try {
    return await loadPromise
  } finally {
    // Always clean up the cache, whether success or failure
    sessionLoadingPromises.delete(sessionId)
  }
}

export const ensureSessionMessagesLoadedAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId)
  }
)

/**
 * Force-refresh session messages even if the session is currently marked as loaded.
 * Used by reconnect recovery when a session atom is stuck in an empty-but-loaded state.
 */
export const forceSessionMessagesReloadAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId, { force: true })
  }
)

/**
 * Background task for ActiveTasksBar display
 */
/**
 * Lifecycle status of a background task chip.
 * - `running`  — backgrounded, no terminal signal yet (chip shows a spinner + live elapsed).
 * - `completed`/`failed`/`stopped` — a real task_completed notification arrived.
 * - `orphaned` — the turn that owned the task ended before it finished, so it was
 *   terminated with that turn's subprocess. Shown distinctly instead of a false
 *   "running". Not produced once WS2 keep-alive is enabled.
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

export interface BackgroundTask {
  /** Task or shell ID */
  id: string
  /** Task type. 'workflow' = a fan-out Workflow launch (many sub-agents). */
  type: 'agent' | 'shell' | 'workflow'
  /** Tool use ID for correlation with messages */
  toolUseId: string
  /** Workflow run id (wf_...) — set for type 'workflow'; correlates agent-completed updates. */
  workflowId?: string
  /** Count of sub-agents that have completed so far (type 'workflow' only). */
  agentsCompleted?: number
  /** When the task started */
  startTime: number
  /** Elapsed seconds (from progress events; the chip also derives it from startTime) */
  elapsedSeconds: number
  /** Task intent/description */
  intent?: string
  /** Lifecycle status; defaults to 'running' when added */
  status: BackgroundTaskStatus
  /** ms timestamp when the task reached a terminal/orphaned status */
  completedAt?: number
  /** Output file for click-through, set when task_completed arrives */
  outputFile?: string
  /** Short summary, set when task_completed arrives */
  summary?: string
}

/**
 * Atom family for tracking active background tasks per session
 * Updated on task_backgrounded, shell_backgrounded, task_progress events
 * Cleared when tasks complete or are killed
 */
export const backgroundTasksAtomFamily = atomFamily(
  (_sessionId: string) => atom<BackgroundTask[]>([]),
  (a, b) => a === b
)

/**
 * Window's current workspace ID — shared between Root (ThemeProvider) and App.
 * Written by App on workspace switch, read by Root to keep the theme in sync.
 */
export const windowWorkspaceIdAtom = atom<string | null>(null)

/**
 * State for "Send to Workspace" dialog.
 * Set session IDs to open; clear to close.
 */
export const sendToWorkspaceAtom = atom<string[]>([])
