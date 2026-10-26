import { useCallback } from 'react';

import type { Session, SessionStatus } from '../shared/types';

import { sessionMetaMapAtom } from '@/atoms/sessions';

interface useAppSessionActionsInput {
  addSession: (session: Session) => void
  syncSessionOptionsFromSession: (session: Session) => void
  store: import("jotai").Store
  removeSession: (sessionId: string) => void
  updateSessionById: (sessionId: string, updates: Partial<Session> | ((session: Session) => Partial<Session>)) => void
  windowWorkspaceId: string | null
}

export function useAppSessionActions({
  addSession,
  syncSessionOptionsFromSession,
  store,
  removeSession,
  updateSessionById,
  windowWorkspaceId,
}: useAppSessionActionsInput) {
const handleCreateSession = useCallback(async (workspaceId: string, options?: import('../shared/types').CreateSessionOptions): Promise<Session> => {
    const session = await window.electronAPI.createSession(workspaceId, options)
    // Add to per-session atom and metadata map (no sessionsAtom)
    addSession(session)
    syncSessionOptionsFromSession(session)

    return session
  }, [addSession, syncSessionOptionsFromSession])

const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation = false): Promise<boolean> => {
    // Show confirmation dialog before deleting (unless skipped or session is empty)
    if (!skipConfirmation) {
      // Check if session has any messages using session metadata from Jotai store
      // We use store.get() instead of closing over sessions to prevent memory leaks
      // (closures would retain the full sessions array with all messages)
      const metaMap = store.get(sessionMetaMapAtom)
      const meta = metaMap.get(sessionId)
      // Session is empty if it has no lastFinalMessageId (no assistant responses) and no name (set on first user message)
      const isEmpty = !meta || (!meta.lastFinalMessageId && !meta.name)

      if (!isEmpty) {
        const confirmed = await window.electronAPI.showDeleteSessionConfirmation(meta?.name || 'Untitled')
        if (!confirmed) return false
      }
    }

    await window.electronAPI.deleteSession(sessionId)
    // Remove from per-session atom and metadata map (no sessionsAtom)
    removeSession(sessionId)
    return true
  }, [store, removeSession])

const handleAutoDeleteEmptySession = useCallback((sessionId: string) => {
    window.electronAPI.deleteSession(sessionId)
    removeSession(sessionId)
  }, [removeSession])

const handleFlagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: true })
    window.electronAPI.sessionCommand(sessionId, { type: 'flag' })
  }, [updateSessionById])

const handleUnflagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: false })
    window.electronAPI.sessionCommand(sessionId, { type: 'unflag' })
  }, [updateSessionById])

const handleArchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: true, archivedAt: Date.now() })
    window.electronAPI.sessionCommand(sessionId, { type: 'archive' })
  }, [updateSessionById])

const handleUnarchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: false, archivedAt: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'unarchive' })
  }, [updateSessionById])

const handleSetActiveViewingSession = useCallback((sessionId: string) => {
    // Optimistic UI update: clear hasUnread immediately
    updateSessionById(sessionId, { hasUnread: false })
    // Tell main process user is viewing this session
    window.electronAPI.sessionCommand(sessionId, { type: 'setActiveViewing', workspaceId: windowWorkspaceId ?? '' })
  }, [updateSessionById, windowWorkspaceId])

const handleMarkSessionRead = useCallback((sessionId: string) => {
    // Update hasUnread flag (primary source of truth for NEW badge)
    // Also update lastReadMessageId for backwards compatibility
    updateSessionById(sessionId, (s) => {
      const lastFinalId = s.messages.findLast(
        m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
      )?.id
      return {
        hasUnread: false,
        ...(lastFinalId ? { lastReadMessageId: lastFinalId } : {}),
      }
    })
    window.electronAPI.sessionCommand(sessionId, { type: 'markRead' })
  }, [updateSessionById])

const handleMarkSessionUnread = useCallback((sessionId: string) => {
    // Set hasUnread flag (primary source of truth for NEW badge)
    updateSessionById(sessionId, { hasUnread: true, lastReadMessageId: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'markUnread' })
  }, [updateSessionById])

const handleSessionStatusChange = useCallback((sessionId: string, state: SessionStatus) => {
    updateSessionById(sessionId, { sessionStatus: state })
    window.electronAPI.sessionCommand(sessionId, { type: 'setSessionStatus', state })
  }, [updateSessionById])

const handleRenameSession = useCallback((sessionId: string, name: string) => {
    updateSessionById(sessionId, { name })
    window.electronAPI.sessionCommand(sessionId, { type: 'rename', name })
  }, [updateSessionById])
return { handleCreateSession, handleRenameSession, handleFlagSession, handleUnflagSession, handleArchiveSession, handleUnarchiveSession, handleMarkSessionRead, handleMarkSessionUnread, handleSetActiveViewingSession, handleSessionStatusChange, handleDeleteSession, handleAutoDeleteEmptySession }
}
