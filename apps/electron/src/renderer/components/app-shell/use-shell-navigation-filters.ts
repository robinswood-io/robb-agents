import * as React from "react";

import { useCallback, useMemo } from "react";

import { decodeViewFilters, type FilterMode, type ViewFiltersMap } from "./view-filters";

import type { SourceFilter, AutomationFilter } from "../../../shared/types";

import { type SessionStatusId } from "@/config/session-status-config";

import * as storage from "@/lib/local-storage";

import { navigate, routes } from "@/lib/navigate";
import { isSessionsNavigation, isSourcesNavigation, isAutomationsNavigation, isMissionsNavigation, type NavigationState } from "@/contexts/NavigationContext";

interface useShellNavigationFiltersInput {
  sessionsContext: { filter: import("@/contexts/NavigationContext").SessionFilter; sessionId: string | null; } | null
  navState: NavigationState
}

export function useShellNavigationFilters({
  sessionsContext,
  navState,
}: useShellNavigationFiltersInput) {
const sessionFilter = sessionsContext?.filter ?? null

const isBoardView = isSessionsNavigation(navState) && navState.viewMode === 'board'

const isMissionControlView = isMissionsNavigation(navState)

const isFullWidthView = isBoardView || isMissionControlView

const sourceFilter: SourceFilter | null = isSourcesNavigation(navState) ? navState.filter ?? null : null

const automationFilter: AutomationFilter | null = isAutomationsNavigation(navState) ? navState.filter ?? null : null

const sessionFilterKey = useMemo(() => {
    if (!sessionFilter) return null
    switch (sessionFilter.kind) {
      case 'allSessions': return 'allSessions'
      case 'flagged': return 'flagged'
      case 'archived': return 'archived'
      case 'state': return `state:${sessionFilter.stateId}`
      case 'label': return `label:${sessionFilter.labelId}`
      case 'view': return `view:${sessionFilter.viewId}`
      default: return 'allSessions'
    }
  }, [sessionFilter])

const [viewFiltersMap, setViewFiltersMap] = React.useState<ViewFiltersMap>(() => decodeViewFilters(
    storage.get<unknown>(storage.KEYS.viewFilters, {}),
    storage.get<unknown>(storage.KEYS.listFilter, []),
    storage.get<unknown>(storage.KEYS.labelFilter, []),
  ))

const listFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<SessionStatusId, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.statuses ?? {}
    return new Map<SessionStatusId, FilterMode>(Object.entries(entry) as [SessionStatusId, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

const labelFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<string, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.labels ?? {}
    return new Map<string, FilterMode>(Object.entries(entry) as [string, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

const projectFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<string, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.projects ?? {}
    return new Map<string, FilterMode>(Object.entries(entry) as [string, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

const setListFilter = useCallback((updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<SessionStatusId, FilterMode>(Object.entries(prev[sessionFilterKey]?.statuses ?? {}) as [SessionStatusId, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      const existing = prev[sessionFilterKey]
      return {
        ...prev,
        [sessionFilterKey]: {
          statuses: Object.fromEntries(next),
          labels: existing?.labels ?? {},
          projects: existing?.projects ?? {},
          ...(existing?.groupingMode !== undefined ? { groupingMode: existing?.groupingMode } : {}),
        }
      }
    })
  }, [sessionFilterKey])

const setLabelFilter = useCallback((updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<string, FilterMode>(Object.entries(prev[sessionFilterKey]?.labels ?? {}) as [string, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      const existing = prev[sessionFilterKey]
      return {
        ...prev,
        [sessionFilterKey]: {
          statuses: existing?.statuses ?? {},
          labels: Object.fromEntries(next),
          projects: existing?.projects ?? {},
          ...(existing?.groupingMode !== undefined ? { groupingMode: existing?.groupingMode } : {}),
        }
      }
    })
  }, [sessionFilterKey])

const handleToggleLabelFilter = useCallback((labelId: string) => {
    setLabelFilter(prev => {
      const next = new Map(prev)
      if (next.has(labelId)) {
        next.delete(labelId)
      } else {
        next.set(labelId, 'include')
      }
      return next
    })
  }, [setLabelFilter])

const setProjectFilter = useCallback((updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<string, FilterMode>(Object.entries(prev[sessionFilterKey]?.projects ?? {}) as [string, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      const existing = prev[sessionFilterKey]
      return {
        ...prev,
        [sessionFilterKey]: {
          statuses: existing?.statuses ?? {},
          labels: existing?.labels ?? {},
          projects: Object.fromEntries(next),
          ...(existing?.groupingMode !== undefined ? { groupingMode: existing?.groupingMode } : {}),
        }
      }
    })
  }, [sessionFilterKey])

const handleJumpToProjectSessions = useCallback((projectId: string) => {
    setViewFiltersMap(prev => {
      const existing = prev['allSessions']
      return {
        ...prev,
        allSessions: {
          statuses: existing?.statuses ?? {},
          labels: existing?.labels ?? {},
          projects: { [projectId]: 'include' },
          ...(existing?.groupingMode !== undefined ? { groupingMode: existing?.groupingMode } : {}),
        }
      }
    })
    navigate(routes.view.allSessions())
  }, [])

const handleJumpToTaskSessions = useCallback(
    (sessionId: string, scope: { labelId: string; projectId?: string }) => {
      setViewFiltersMap(prev => {
        const existing = prev['allSessions']
        return {
          ...prev,
          allSessions: {
            statuses: existing?.statuses ?? {},
            labels: { [scope.labelId]: 'include' },
            projects: scope.projectId ? { [scope.projectId]: 'include' } : {},
            ...(existing?.groupingMode !== undefined ? { groupingMode: existing?.groupingMode } : {}),
          }
        }
      })
      navigate(routes.view.allSessions(sessionId))
    },
    []
  )
return { sessionFilter, viewFiltersMap, sessionFilterKey, setViewFiltersMap, listFilter, labelFilter, projectFilter, automationFilter, handleJumpToTaskSessions, sourceFilter, handleJumpToProjectSessions, setListFilter, setLabelFilter, setProjectFilter, handleToggleLabelFilter, isFullWidthView }
}
