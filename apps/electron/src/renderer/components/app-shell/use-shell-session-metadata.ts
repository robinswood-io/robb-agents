import * as React from "react";

import { useState,useEffect,useCallback,useMemo } from "react";
import { useAtomValue } from "jotai";

import { type FilterMode } from "./view-filters";

import { findPendingRequestForConversation,getUserFacingSessionId,isUserFacingSession } from "@/utils/session-visibility";
import { pendingSessionAuthRequestsAtom } from "@/atoms/session-auth-requests";
import { useSetAtom } from "jotai";
import type { Session,Workspace,PermissionRequest,LoadedSource,LoadedSkill } from "../../../shared/types";
import { sessionMetaMapAtom,type SessionMeta } from "@/atoms/sessions";

import { type SessionStatusId,type SessionStatus } from "@/config/session-status-config";

import { getDescendantIds,flattenLabels,extractLabelId,matchesLabelFilter } from "@craft-agent/shared/labels";
import type { LabelConfig } from "@craft-agent/shared/labels";

import { APP_EVENTS,AGENT_EVENTS } from "../automations/types";

interface useShellSessionMetadataInput {
  pendingPermissions: Map<string, PermissionRequest[]>
  pendingCredentials: Map<string, import("@craft-agent/session-tools-core").CredentialAuthRequest[]>
  session: { selected: string | null; }
  activeWorkspaceId: string | null
  setSkills: React.Dispatch<React.SetStateAction<LoadedSkill[]>>
  activeWorkspace: Workspace | undefined
  workspaces: Workspace[]
  labelConfigs: LabelConfig[]
  effectiveSessionStatuses: SessionStatus[]
  sources: LoadedSource[]
  automations: import("../automations/types").AutomationListItem[]
  sessionFilter: import("@/contexts/NavigationContext").SessionFilter | null
  evaluateViews: (meta: SessionMeta) => import("@craft-agent/shared/views").ViewConfig[]
  listFilter: Map<string, FilterMode>
  labelFilter: Map<string, FilterMode>
  projectFilter: Map<string, FilterMode>
  ensureMessagesLoaded: (sessionId: string) => Promise<Session | null>
}

export function useShellSessionMetadata({
  pendingPermissions,
  pendingCredentials,
  session,
  activeWorkspaceId,
  setSkills,
  activeWorkspace,
  workspaces,
  labelConfigs,
  sources,
  automations,
  sessionFilter,
  evaluateViews,
  listFilter,
  labelFilter,
  projectFilter,
  ensureMessagesLoaded,
}: useShellSessionMetadataInput) {


const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

const pendingSessionAuthRequests = useAtomValue(pendingSessionAuthRequestsAtom)

const setSessionMetaMap = useSetAtom(sessionMetaMapAtom)

const hasPendingPrompt = React.useCallback((sessionId: string) => {
    return !!sessionMetaMap.get(sessionId)?.hasPendingUserInput
      || !!findPendingRequestForConversation(sessionId, pendingPermissions, sessionMetaMap)
      || !!findPendingRequestForConversation(sessionId, pendingCredentials, sessionMetaMap)
      || pendingSessionAuthRequests.some(request => getUserFacingSessionId(request.sessionId, sessionMetaMap) === sessionId)
  }, [pendingPermissions, pendingCredentials, pendingSessionAuthRequests, sessionMetaMap])

const [workspaceUnreadMap, setWorkspaceUnreadMap] = useState<Record<string, boolean>>({})

const activeSessionWorkingDirectory = session.selected
    ? sessionMetaMap.get(session.selected)?.workingDirectory
    : undefined

React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getSkills(activeWorkspaceId, activeSessionWorkingDirectory).then((loaded) => {
      setSkills(loaded || [])
    }).catch((err: unknown) => {
      console.error('[Chat] Failed to load skills:', err)
    })
  }, [activeWorkspaceId, activeSessionWorkingDirectory, setSkills])

const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId

const workspaceSessionFamilyMetas = useMemo(() => {
    const metas = Array.from(sessionMetaMap.values())
    if (!activeWorkspaceId) return metas.filter(s => !s.hidden)
    return metas.filter(s =>
      !s.hidden && (s.workspaceId === activeWorkspaceId || (remoteWorkspaceId && s.workspaceId === remoteWorkspaceId))
    )
  }, [sessionMetaMap, activeWorkspaceId, remoteWorkspaceId])

const workspaceSessionMetas = useMemo(
    () => workspaceSessionFamilyMetas.filter(isUserFacingSession),
    [workspaceSessionFamilyMetas],
  )

const activeSessionMetas = useMemo(() => {
    return workspaceSessionMetas.filter(s => !s.isArchived)
  }, [workspaceSessionMetas])

const refreshWorkspaceUnreadMap = useCallback(async () => {
    try {
      const summary = await window.electronAPI.getUnreadSummary()
      const next: Record<string, boolean> = {}

      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }

      setWorkspaceUnreadMap(next)
    } catch (error) {
      console.error('[AppShell] Failed to refresh workspace unread indicators:', error)
    }
  }, [workspaces])

useEffect(() => {
    void refreshWorkspaceUnreadMap()
  }, [refreshWorkspaceUnreadMap])

useEffect(() => {
    if (!activeWorkspaceId) return
    const activeHasUnread = activeSessionMetas.some((session) => !!session.hasUnread)
    setWorkspaceUnreadMap((prev) => ({ ...prev, [activeWorkspaceId]: activeHasUnread }))
  }, [activeWorkspaceId, activeSessionMetas])

useEffect(() => {
    const cleanup = window.electronAPI.onUnreadSummaryChanged((summary) => {
      const next: Record<string, boolean> = {}
      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }
      setWorkspaceUnreadMap(next)
    })

    return cleanup
  }, [workspaces])


const flaggedCount = activeSessionMetas.filter(s => s.isFlagged).length

const archivedCount = workspaceSessionMetas.filter(s => s.isArchived).length

const labelCounts = useMemo(() => {
    const allLabels = flattenLabels(labelConfigs)
    const counts: Record<string, number> = {}
    for (const label of allLabels) {
      // Direct count: sessions explicitly tagged with this label (handles valued entries like "priority::3")
      const directCount = activeSessionMetas.filter(
        s => s.labels?.some(l => extractLabelId(l) === label.id)
      ).length
      counts[label.id] = directCount
    }
    // Add descendant counts to parents (cumulative)
    for (const label of allLabels) {
      const descendants = getDescendantIds(labelConfigs, label.id)
      if (descendants.length > 0) {
        const descendantCount = activeSessionMetas.filter(
          s => s.labels?.some(l => descendants.includes(extractLabelId(l)))
        ).length
        counts[label.id] = (counts[label.id] || 0) + descendantCount
      }
    }
    return counts
  }, [activeSessionMetas, labelConfigs])



const sourceTypeCounts = useMemo(() => {
    const counts = { api: 0, mcp: 0, local: 0 }
    for (const source of sources) {
      const t = source.config.type
      if (t === 'api' || t === 'mcp' || t === 'local') {
        counts[t]++
      }
    }
    return counts
  }, [sources])

const automationTypeCounts = useMemo(() => {
    const counts = { scheduled: 0, event: 0, agentic: 0 }
    for (const automation of automations) {
      if (automation.event === 'SchedulerTick') counts.scheduled++
      else if ((APP_EVENTS as string[]).includes(automation.event)) counts.event++
      else if ((AGENT_EVENTS as string[]).includes(automation.event)) counts.agentic++
    }
    return counts
  }, [automations])

const filteredSessionMetas = useMemo(() => {
    // When in sources mode, return empty (no sessions to show)
    if (!sessionFilter) {
      return []
    }

    let result: SessionMeta[]

    switch (sessionFilter.kind) {
      case 'allSessions':
        // "All Sessions" - shows active (non-archived) sessions
        result = activeSessionMetas
        break
      case 'flagged':
        result = activeSessionMetas.filter(s => s.isFlagged)
        break
      case 'archived':
        // Archived view shows only archived sessions
        result = workspaceSessionMetas.filter(s => s.isArchived)
        break
      case 'state':
        // Filter by specific todo state (excludes archived)
        result = activeSessionMetas.filter(s => (s.sessionStatus || 'todo') === sessionFilter.stateId)
        break
      case 'label': {
        // Shared predicate (handles '__all__', descendant labels, and the optional
        // project scope) — the same implementation the session list filters with,
        // so the two stay aligned by construction.
        result = activeSessionMetas.filter(s => matchesLabelFilter(s, sessionFilter, labelConfigs))
        break
      }
      case 'view': {
        // Filter by view: __all__ shows any session matched by any view,
        // otherwise filter to the specific view (excludes archived)
        result = activeSessionMetas.filter(s => {
          const matched = evaluateViews(s)
          if (sessionFilter.viewId === '__all__') {
            return matched.length > 0
          }
          return matched.some(v => v.id === sessionFilter.viewId)
        })
        break
      }
      default:
        result = activeSessionMetas
    }

    // Apply secondary filters (status + labels, AND-ed together) in ALL views.
    // These layer on top of the primary sessionFilter to allow further narrowing.
    // Each filter supports include/exclude modes:
    //   - Includes: if any exist, only matching items pass
    //   - Excludes: matching items are removed (applied after includes)
    if (listFilter.size > 0) {
      const statusIncludes = new Set<SessionStatusId>()
      const statusExcludes = new Set<SessionStatusId>()
      for (const [id, mode] of listFilter) {
        if (mode === 'include') statusIncludes.add(id)
        else statusExcludes.add(id)
      }
      if (statusIncludes.size > 0) {
        result = result.filter(s => statusIncludes.has((s.sessionStatus || 'todo') as SessionStatusId))
      }
      if (statusExcludes.size > 0) {
        result = result.filter(s => !statusExcludes.has((s.sessionStatus || 'todo') as SessionStatusId))
      }
    }
    // Filter by labels — supports include/exclude with descendant expansion
    if (labelFilter.size > 0) {
      const labelIncludes = new Set<string>()
      const labelExcludes = new Set<string>()
      for (const [id, mode] of labelFilter) {
        // Expand to include descendant label IDs
        const ids = [id, ...getDescendantIds(labelConfigs, id)]
        for (const expandedId of ids) {
          if (mode === 'include') labelIncludes.add(expandedId)
          else labelExcludes.add(expandedId)
        }
      }
      if (labelIncludes.size > 0) {
        result = result.filter(s =>
          s.labels?.some(l => labelIncludes.has(extractLabelId(l)))
        )
      }
      if (labelExcludes.size > 0) {
        result = result.filter(s =>
          !s.labels?.some(l => labelExcludes.has(extractLabelId(l)))
        )
      }
    }
    // Filter by project — supports include/exclude on session.projectId
    if (projectFilter.size > 0) {
      const projectIncludes = new Set<string>()
      const projectExcludes = new Set<string>()
      for (const [id, mode] of projectFilter) {
        if (mode === 'include') projectIncludes.add(id)
        else projectExcludes.add(id)
      }
      if (projectIncludes.size > 0) {
        result = result.filter(s => {
          const pid = (s as { projectId?: string }).projectId
          return pid !== undefined && projectIncludes.has(pid)
        })
      }
      if (projectExcludes.size > 0) {
        result = result.filter(s => {
          const pid = (s as { projectId?: string }).projectId
          return pid === undefined || !projectExcludes.has(pid)
        })
      }
    }

    return result
  }, [workspaceSessionMetas, activeSessionMetas, sessionFilter, listFilter, labelFilter, projectFilter, labelConfigs, evaluateViews])

const pinnedFilters = useMemo(() => {
    if (!sessionFilter) return { pinnedStatusId: null as string | null, pinnedLabelId: null as string | null, pinnedFlagged: false }
    switch (sessionFilter.kind) {
      case 'state':
        return { pinnedStatusId: sessionFilter.stateId, pinnedLabelId: null, pinnedFlagged: false }
      case 'label':
        // Don't pin the __all__ pseudo-label — that just means "any label"
        return { pinnedStatusId: null, pinnedLabelId: sessionFilter.labelId !== '__all__' ? sessionFilter.labelId : null, pinnedFlagged: false }
      case 'flagged':
        return { pinnedStatusId: null, pinnedLabelId: null, pinnedFlagged: true }
      default:
        return { pinnedStatusId: null, pinnedLabelId: null, pinnedFlagged: false }
    }
  }, [sessionFilter])

React.useEffect(() => {
    if (session.selected) {
      ensureMessagesLoaded(session.selected)
    }
  }, [session.selected, ensureMessagesLoaded])
return { sessionMetaMap, labelCounts, activeSessionWorkingDirectory, workspaceUnreadMap, workspaceSessionMetas, setSessionMetaMap, flaggedCount, archivedCount, sourceTypeCounts, automationTypeCounts, pinnedFilters, filteredSessionMetas, workspaceSessionFamilyMetas, hasPendingPrompt }
}
