/**
 * Per-Session State Management with Jotai
 *
 * Uses atomFamily to create isolated atoms per session.
 * Updates to one session don't trigger re-renders in other sessions.
 *
 * This solves the performance issue where streaming in Session A
 * caused re-renders and focus loss in Session B.
 */
import { atom } from "jotai";
import type { Getter, Setter } from "jotai/vanilla";
import type { Session, Message } from "../../../shared/types";
import { mergeUserInputRequests } from "../../lib/user-input-state";
import { getSessionProcessingRevision, markSessionProcessingState } from "../../lib/session-processing-state";
import { findLastFinalMessageId } from './metadata.ts';
import { loadedSessionsAtom, sessionAtomFamily, sessionLoadingPromises, sessionMetaMapAtom } from './state.ts';

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
