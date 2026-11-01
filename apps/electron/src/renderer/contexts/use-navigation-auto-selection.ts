import { useCallback, useRef } from 'react';

import type { NavigationState, SessionFilter, SourceFilter } from '../../shared/types';
import { isSessionsNavigation, isSourcesNavigation, isSkillsNavigation } from '../../shared/types';
import { sessionMetaMapAtom } from '@/atoms/sessions';

interface useNavigationAutoSelectionInput {
  sources: import("@craft-agent/shared/sources").LoadedSource[]
  skills: import("@craft-agent/shared/skills").LoadedSkill[]
  store: import("jotai").Store
  workspaceId: string | null
  remoteWorkspaceId: string | null | undefined
  getLastSelectedSessionId: (filter: SessionFilter) => string | null
  getFirstSessionId: (filter: SessionFilter) => string | null
}

export function useNavigationAutoSelection({
  sources,
  skills,
  store,
  workspaceId,
  remoteWorkspaceId,
  getLastSelectedSessionId,
  getFirstSessionId,
}: useNavigationAutoSelectionInput) {
const getFirstSourceSlug = useCallback(
    (filter?: SourceFilter | null): string | null => {
      if (!filter) {
        return sources[0]?.config.slug ?? null
      }
      const filtered = sources.filter(s => s.config.type === filter.sourceType)
      return filtered[0]?.config.slug ?? null
    },
    [sources]
  )

const getFirstSkillSlug = useCallback(
    (): string | null => {
      return skills[0]?.slug ?? null
    },
    [skills]
  )

const resolveAutoSelection = useCallback(
    (newState: NavigationState, options?: { skipAutoSelect?: boolean }): NavigationState => {
      let nextState = newState

      // Validate session exists in current workspace (local or remote ID)
      if (isSessionsNavigation(nextState) && nextState.details) {
        const freshMetaMap = store.get(sessionMetaMapAtom)
        const meta = freshMetaMap.get(nextState.details.sessionId)
        const matchesWorkspace = !workspaceId
          || meta?.workspaceId === workspaceId
          || (remoteWorkspaceId && meta?.workspaceId === remoteWorkspaceId)
        if (!meta || !matchesWorkspace) {
          nextState = { ...nextState, details: null }
        }
      }

      // Sessions: auto-select last/first session.
      // Board view has no per-session detail, so skip auto-selection — otherwise
      // navigating to the board would immediately resolve into a chat route.
      if (
        isSessionsNavigation(nextState) &&
        nextState.viewMode !== 'board' &&
        !nextState.details &&
        !options?.skipAutoSelect
      ) {
        const lastSelectedSessionId = getLastSelectedSessionId(nextState.filter)
        const fallbackSessionId = lastSelectedSessionId ?? getFirstSessionId(nextState.filter)
        if (fallbackSessionId) {
          return { ...nextState, details: { type: 'session', sessionId: fallbackSessionId } }
        }
        return nextState
      }

      // Sources: auto-select first source
      if (isSourcesNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const firstSourceSlug = getFirstSourceSlug(nextState.filter)
        if (firstSourceSlug) {
          return { ...nextState, details: { type: 'source', sourceSlug: firstSourceSlug } }
        }
        return nextState
      }

      // Skills: auto-select first skill
      if (isSkillsNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const firstSkillSlug = getFirstSkillSlug()
        if (firstSkillSlug) {
          return { ...nextState, details: { type: 'skill', skillSlug: firstSkillSlug } }
        }
        return nextState
      }

      return nextState
    },
    [store, workspaceId, remoteWorkspaceId, getLastSelectedSessionId, getFirstSessionId, getFirstSourceSlug, getFirstSkillSlug]
  )

const resolveAutoSelectionRef = useRef(resolveAutoSelection)
return { resolveAutoSelectionRef, resolveAutoSelection }
}
