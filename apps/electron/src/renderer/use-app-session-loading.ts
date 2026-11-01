import React, { useCallback } from 'react';

import type { Session } from '../shared/types';

import type { SessionOptions } from './hooks/useSessionOptions';
import { defaultSessionOptions } from './hooks/useSessionOptions';

import { navigate, routes } from './lib/navigate';

import { formatSessionLoadFailure, shouldTreatSessionLoadFailureAsTransportFallback } from './lib/session-load';
import { getPermissionModeReconciliationTarget } from './lib/permission-mode-reconciliation';

import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels';

import { refreshSessionsMetadataAtom, sessionAtomFamily, sessionMetaMapAtom, loadedSessionsAtom, type SessionMeta } from '@/atoms/sessions';

import { rendererLog } from '@/lib/logger';

import { type SessionListRefreshOptions, summarizeIds, workspaceDistribution } from "./app-runtime-helpers";

interface useAppSessionLoadingInput {
  setSessionOptions: React.Dispatch<React.SetStateAction<Map<string, SessionOptions>>>
  store: import("jotai").Store
  clearStreamingState: (sessionId: string) => void
  replaceLoadedSession: (session: Session) => void
  reconcilePermissionModeState: (sessionId: string) => Promise<void>
  setSessionLoadError: React.Dispatch<React.SetStateAction<string | null>>
  initializeSessions: (sessions: Session[]) => void
  initialSessionId: string | null
  setSessionsLoaded: React.Dispatch<React.SetStateAction<boolean>>
  windowWorkspaceId: string | null
  windowRemoteWorkspaceId: string | null
}

export function useAppSessionLoading({
  setSessionOptions,
  store,
  clearStreamingState,
  replaceLoadedSession,
  reconcilePermissionModeState,
  setSessionLoadError,
  initializeSessions,
  initialSessionId,
  setSessionsLoaded,
  windowWorkspaceId,
  windowRemoteWorkspaceId,
}: useAppSessionLoadingInput) {
const syncSessionOptionsFromSession = useCallback((session: Session) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(session.id)
      const merged = {
        ...defaultSessionOptions,
        ...current,
        permissionMode: session.permissionMode ?? defaultSessionOptions.permissionMode,
        thinkingLevel: session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      }

      const hasNonDefaultMode = merged.permissionMode !== defaultSessionOptions.permissionMode
      const hasNonDefaultThinking = merged.thinkingLevel !== DEFAULT_THINKING_LEVEL

      if (!hasNonDefaultMode && !hasNonDefaultThinking && merged.permissionModeVersion == null) {
        next.delete(session.id)
      } else {
        next.set(session.id, merged)
      }

      return next
    })
  }, [setSessionOptions])

const refreshSessionFromServer = useCallback(async (sessionId: string): Promise<'refreshed' | 'preserved_stale_messages' | 'failed'> => {
    try {
      const fresh = await window.electronAPI.getSessionMessages(sessionId)
      if (!fresh) return 'failed'

      const prevSession = store.get(sessionAtomFamily(sessionId))
      const preservedStaleMessages = !!prevSession && prevSession.messages.length > 0 && (!fresh.messages || fresh.messages.length === 0)
      const nextSession = preservedStaleMessages
        ? { ...fresh, messages: prevSession.messages }
        : fresh

      clearStreamingState(sessionId)
      replaceLoadedSession(nextSession)
      syncSessionOptionsFromSession(nextSession)
      void reconcilePermissionModeState(sessionId)
      return preservedStaleMessages ? 'preserved_stale_messages' : 'refreshed'
    } catch (err) {
      console.error(`[App] Failed to refresh session ${sessionId}:`, err)
      return 'failed'
    }
  }, [clearStreamingState, replaceLoadedSession, syncSessionOptionsFromSession, reconcilePermissionModeState, store])

const loadSessionsFromServer = useCallback(async () => {
    setSessionLoadError(null)

    try {
      const loadedSessions = await window.electronAPI.getSessions()

      // Initialize per-session atoms and metadata map
      // NOTE: No sessionsAtom used - sessions are only in per-session atoms
      initializeSessions(loadedSessions)

      // Initialize unified sessionOptions from session data
      const optionsMap = new Map<string, SessionOptions>()
      for (const s of loadedSessions) {
        const hasNonDefaultMode = s.permissionMode && s.permissionMode !== 'ask'
        const hasNonDefaultThinking = s.thinkingLevel && s.thinkingLevel !== DEFAULT_THINKING_LEVEL
        if (hasNonDefaultMode || hasNonDefaultThinking) {
          optionsMap.set(s.id, {
            permissionMode: s.permissionMode ?? 'ask',
            thinkingLevel: s.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
          })
        }
      }
      setSessionOptions(optionsMap)

      // The catalogue already contains persisted permission modes. Reconcile
      // only the focused session instead of hydrating every cold transcript.
      const permissionModeTarget = getPermissionModeReconciliationTarget(loadedSessions, initialSessionId)
      if (permissionModeTarget) await reconcilePermissionModeState(permissionModeTarget)

      setSessionsLoaded(true)

      if (initialSessionId && windowWorkspaceId) {
        const session = loadedSessions.find(s => s.id === initialSessionId)
        if (session) {
          navigate(routes.view.allSessions(session.id))
        }
      }
    } catch (err) {
      console.error('[App] Failed to load sessions:', err)
      const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

      if (shouldTreatSessionLoadFailureAsTransportFallback(transportState)) {
        console.error('[App] Treating session load failure as transport fallback:', transportState)
        setSessionsLoaded(true)
        setSessionLoadError(null)
        return
      }

      setSessionLoadError(formatSessionLoadFailure(err))
      setSessionsLoaded(true)
    }
  }, [initializeSessions, initialSessionId, reconcilePermissionModeState, windowWorkspaceId, setSessionLoadError, setSessionOptions, setSessionsLoaded])

const refreshSessionListMetadataFromServer = useCallback(async (options: SessionListRefreshOptions = {}): Promise<Map<string, SessionMeta> | null> => {
    const {
      removeMissing = true,
      reason = 'manual-or-authoritative',
      selectedSessionId = null,
    } = options
    const beforeMetaMap = store.get(sessionMetaMapAtom)
    const beforeIds = new Set(beforeMetaMap.keys())
    const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

    try {
      const sessions = await window.electronAPI.getSessions()
      const returnedIds = new Set(sessions.map(s => s.id))
      const missingIds = Array.from(beforeIds).filter(id => !returnedIds.has(id))
      const addedIds = sessions.map(s => s.id).filter(id => !beforeIds.has(id))
      const logPayload = {
        reason,
        removeMissing,
        windowWorkspaceId,
        windowRemoteWorkspaceId,
        selectedSessionId,
        beforeCount: beforeIds.size,
        returnedCount: sessions.length,
        beforeIds: summarizeIds(beforeIds),
        returnedIds: summarizeIds(returnedIds),
        missingIds: summarizeIds(missingIds),
        addedIds: summarizeIds(addedIds),
        beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
        returnedWorkspaceIds: workspaceDistribution(sessions),
        transportState,
      }

      rendererLog.info('[App] Session list metadata refresh result', logPayload)
      if (!removeMissing && missingIds.length > 0) {
        rendererLog.warn('[App] Non-destructive refresh preserved sessions omitted by getSessions(); this indicates a partial backend response or workspace-context mismatch', logPayload)
      }

      const loadedSessionIds = store.get(loadedSessionsAtom)

      // Single transactional atom write — all cross-atom mutations happen
      // inside one Jotai write function so React subscribers see one
      // consistent update instead of intermediate states.
      const nextMetaMap = store.set(refreshSessionsMetadataAtom, { sessions, loadedSessionIds, removeMissing })

      // Sync app-level state (React hooks / non-atom concerns) after the atom transaction
      for (const session of sessions) {
        syncSessionOptionsFromSession(session)
      }
      const permissionModeTarget = getPermissionModeReconciliationTarget(sessions, selectedSessionId)
      if (permissionModeTarget) await reconcilePermissionModeState(permissionModeTarget)

      return nextMetaMap
    } catch (err) {
      rendererLog.error('[App] Failed to refresh session list metadata after reconnect:', {
        reason,
        removeMissing,
        windowWorkspaceId,
        windowRemoteWorkspaceId,
        selectedSessionId,
        beforeCount: beforeIds.size,
        beforeIds: summarizeIds(beforeIds),
        beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
        transportState,
        error: err,
      })
      return null
    }
  }, [store, syncSessionOptionsFromSession, reconcilePermissionModeState, windowWorkspaceId, windowRemoteWorkspaceId])
return { refreshSessionFromServer, loadSessionsFromServer, syncSessionOptionsFromSession, refreshSessionListMetadataFromServer }
}
