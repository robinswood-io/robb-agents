import { useCallback, useEffect, useRef } from 'react';

import { matchesLabelFilter } from '@craft-agent/shared/labels';

import * as storage from '@/lib/local-storage';
import type { NavigationState, SessionFilter } from '../../shared/types';
import { isSessionsNavigation } from '../../shared/types';
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions';

import { parseSessionIdFromRoute } from '@/atoms/panel-stack';
import { shouldAutoDeleteEmptySession } from './navigation-empty-session-cleanup';
import { isUserFacingSession } from '@/utils/session-visibility';

interface useNavigationSessionSelectionInput {
  panelStack: import("@/atoms/panel-stack").PanelStackEntry[]
  onAutoDeleteEmptySession: ((sessionId: string) => void) | undefined
  store: import("jotai").Store
  getDraft: ((sessionId: string) => string) | undefined
  navigationState: NavigationState
  setSession: (config: { selected: string | null; }) => void
  workspaceId: string | null
  sessionMetas: SessionMeta[]
  remoteWorkspaceId: string | null | undefined
  labelConfigs: import("@craft-agent/shared/labels").LabelConfig[]
}

export function useNavigationSessionSelection({
  panelStack,
  onAutoDeleteEmptySession,
  store,
  getDraft,
  navigationState,
  setSession,
  workspaceId,
  sessionMetas,
  remoteWorkspaceId,
  labelConfigs,
}: useNavigationSessionSelectionInput) {
const prevVisibleSessionIdsRef = useRef<Set<string>>(new Set())

const autoDeleteEligibleSessionIdsRef = useRef<Set<string>>(new Set())

useEffect(() => {
    const currentIds = new Set<string>()
    for (const entry of panelStack) {
      const sessionId = parseSessionIdFromRoute(entry.route)
      if (sessionId) currentIds.add(sessionId)
    }

    // Only check after we've seen at least one set of IDs
    // (skip first render to avoid false positives during initialization)
    if (onAutoDeleteEmptySession && prevVisibleSessionIdsRef.current.size > 0) {
      for (const prevId of prevVisibleSessionIdsRef.current) {
        if (!currentIds.has(prevId)) {
          const meta = store.get(sessionMetaMapAtom).get(prevId)
          const eligible = autoDeleteEligibleSessionIdsRef.current.has(prevId)
          if (shouldAutoDeleteEmptySession(eligible, meta, getDraft?.(prevId))) {
            autoDeleteEligibleSessionIdsRef.current.delete(prevId)
            onAutoDeleteEmptySession(prevId)
          } else if (eligible && meta && (meta.lastFinalMessageId || meta.name || meta.isProcessing)) {
            autoDeleteEligibleSessionIdsRef.current.delete(prevId)
          }
        }
      }
    }

    prevVisibleSessionIdsRef.current = currentIds
  }, [panelStack, onAutoDeleteEmptySession, store, getDraft])

useEffect(() => {
    if (isSessionsNavigation(navigationState) && navigationState.details) {
      setSession({ selected: navigationState.details.sessionId })
      if (workspaceId) {
        // Only persist if the session belongs to this workspace (prevents cross-workspace
        // pollution during workspace switch, when workspaceId changed but navigationState
        // still reflects the old workspace's focused panel)
        const meta = store.get(sessionMetaMapAtom).get(navigationState.details.sessionId)
        if (meta && isUserFacingSession(meta) && meta.workspaceId === workspaceId) {
          storage.set(storage.KEYS.lastSelectedSessionId, navigationState.details.sessionId, workspaceId)
        }
      }
    }
  }, [navigationState, setSession, workspaceId, store])

const filterSessionsByFilter = useCallback(
    (filter: SessionFilter): SessionMeta[] => {
      const visibleSessions = sessionMetas.filter(
        s => isUserFacingSession(s) && (!workspaceId || s.workspaceId === workspaceId
          || (!!remoteWorkspaceId && s.workspaceId === remoteWorkspaceId))
      )

      return visibleSessions.filter((session) => {
        switch (filter.kind) {
          case 'allSessions':
            return session.isArchived !== true
          case 'flagged':
            return session.isFlagged === true && session.isArchived !== true
          case 'archived':
            return session.isArchived === true
          case 'state':
            return session.sessionStatus === filter.stateId && session.isArchived !== true
          case 'label': {
            if (session.isArchived === true) return false
            // Shared predicate — descendant-aware and project-scoped, matching
            // exactly what the session list renders (auto-select must agree).
            return matchesLabelFilter(session, filter, labelConfigs)
          }
          case 'view':
            if (session.isArchived === true) return false
            return true
          default:
            return false
        }
      })
    },
    [sessionMetas, workspaceId, remoteWorkspaceId, labelConfigs]
  )

const getFirstSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      const filtered = filterSessionsByFilter(filter)
      return filtered[0]?.id ?? null
    },
    [filterSessionsByFilter]
  )

const getLastSelectedSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      if (!workspaceId) return null
      const storedId = storage.get<string | null>(
        storage.KEYS.lastSelectedSessionId,
        null,
        workspaceId
      )
      if (!storedId) return null
      const filtered = filterSessionsByFilter(filter)
      return filtered.some(session => session.id === storedId) ? storedId : null
    },
    [workspaceId, filterSessionsByFilter]
  )
return { getLastSelectedSessionId, getFirstSessionId, autoDeleteEligibleSessionIdsRef }
}
