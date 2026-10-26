import * as React from "react";

import { useCallback, useMemo } from "react";
import { useAtomValue } from "jotai";

import { type ViewFiltersMap } from "./view-filters";

import { useSetAtom } from "jotai";
import type { Workspace, LoadedSource, LoadedSkill, PermissionMode } from "../../../shared/types";
import { sendToWorkspaceAtom } from "@/atoms/sessions";
import { sourcesAtom } from "@/atoms/sources";
import { skillsAtom } from "@/atoms/skills";

import { type SessionStatus, statusConfigsToSessionStatuses } from "@/config/session-status-config";
import { useStatuses } from "@/hooks/useStatuses";
import { useLabels } from "@/hooks/useLabels";
import { useViews } from "@/hooks/useViews";

import { filterSessionStatuses as filterLabelMenuStates } from "@/components/ui/label-menu";
import { createLabelMenuItems, filterItems as filterLabelMenuItems, type LabelMenuItem } from "@/components/ui/label-menu-utils";
import { buildLabelTree, sortLabelsForDisplay } from "@craft-agent/shared/labels";

import * as storage from "@/lib/local-storage";
import { toast } from "sonner";

import { useAutomations } from "@/hooks/useAutomations";
import { useProjects } from "@/hooks/useProjects";

import { clearSourceIconCaches } from "@/lib/icon-cache";

interface useShellResourcesInput {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSelectWorkspace: (id: string, openInNewWindow?: boolean) => void | Promise<void>
  t: import("i18next").TFunction<"translation", undefined>
  setSearchActive: React.Dispatch<React.SetStateAction<boolean>>
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  setFilterDropdownQuery: React.Dispatch<React.SetStateAction<string>>
  setFocusedSidebarItemId: React.Dispatch<React.SetStateAction<string | null>>
  setViewFiltersMap: React.Dispatch<React.SetStateAction<ViewFiltersMap>>
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>
  setCollapsedItems: React.Dispatch<React.SetStateAction<Set<string>>>
  isDark: boolean
  filterDropdownQuery: string
}

export function useShellResources({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  t,
  setSearchActive,
  setSearchQuery,
  setFilterDropdownQuery,
  setFocusedSidebarItemId,
  setViewFiltersMap,
  setExpandedFolders,
  setCollapsedItems,
  isDark,
  filterDropdownQuery,
}: useShellResourcesInput) {
const [sources, setSources] = React.useState<LoadedSource[]>([])

const setSourcesAtom = useSetAtom(sourcesAtom)

React.useEffect(() => {
    setSourcesAtom(sources)
  }, [sources, setSourcesAtom])

const [skills, setSkills] = React.useState<LoadedSkill[]>([])

const setSkillsAtom = useSetAtom(skillsAtom)

React.useEffect(() => {
    setSkillsAtom(skills)
  }, [skills, setSkillsAtom])

const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)

const sendToWorkspaceIds = useAtomValue(sendToWorkspaceAtom)

const setSendToWorkspaceIds = useSetAtom(sendToWorkspaceAtom)

const handleTransferComplete = useCallback((targetWorkspaceId: string, _newSessionIds: string[]) => {
    onSelectWorkspace(targetWorkspaceId)
  }, [onSelectWorkspace])

const {
    automations, automationTestResults,
    automationPendingDelete, pendingDeleteAutomation, setAutomationPendingDelete,
    handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation, handleDeleteAutomation, confirmDeleteAutomation,
    getAutomationHistory, handleReplayAutomation,
  } = useAutomations(activeWorkspaceId)

const { projects } = useProjects(activeWorkspaceId)

const projectMenuOptions = useMemo(
    () => projects.map(p => ({ id: p.config.id, slug: p.config.slug, name: p.config.name, color: p.config.color })),
    [projects],
  )

const handleSessionProjectChange = useCallback(async (sessionId: string, projectId: string | null) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setProjectId', projectId })
    } catch (err) {
      console.error('[AppShell] Failed to update session project:', err)
      toast.error(t('toast.failedToUpdateProject'))
    }
  }, [t])

const [localMcpEnabled, setLocalMcpEnabled] = React.useState(true)

const [enabledModes, setEnabledModes] = React.useState<PermissionMode[]>(['safe', 'ask', 'allow-all'])

React.useEffect(() => {
    let cancelled = false
    if (!activeWorkspaceId) return () => { cancelled = true }
    window.electronAPI.getWorkspaceSettings(activeWorkspaceId).then((settings) => {
      if (!cancelled && settings) {
        setLocalMcpEnabled(settings.localMcpEnabled ?? true)
        // Load cyclablePermissionModes from workspace settings
        if (settings.cyclablePermissionModes && settings.cyclablePermissionModes.length >= 2) {
          setEnabledModes(settings.cyclablePermissionModes)
        }
      }
    }).catch((err) => {
      if (!cancelled) console.error('[Chat] Failed to load workspace settings:', err)
    })
    return () => { cancelled = true }
  }, [activeWorkspaceId])

const previousWorkspaceRef = React.useRef<string | null>(null)

React.useEffect(() => {
    if (!activeWorkspaceId) return

    const previousWorkspaceId = previousWorkspaceRef.current

    // Clear transient UI state only on workspace SWITCH (not initial mount)
    if (previousWorkspaceId !== null && previousWorkspaceId !== activeWorkspaceId) {
      // Clear search state
      setSearchActive(false)
      setSearchQuery('')

      // Clear filter dropdown state
      setFilterDropdownQuery('')
      setFilterDropdownSelectedIdx(0)

      // Clear focused sidebar item
      setFocusedSidebarItemId(null)
    }

    // Load workspace-scoped state on BOTH initial mount AND workspace switch
    // This fixes CMD+R losing filters - previously only ran on workspace switch
    if (previousWorkspaceId !== activeWorkspaceId) {
      const newViewFilters = storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {}, activeWorkspaceId)
      setViewFiltersMap(newViewFilters)

      const newExpandedFolders = storage.get<string[]>(storage.KEYS.expandedFolders, [], activeWorkspaceId)
      setExpandedFolders(new Set(newExpandedFolders))

      const newCollapsedItems = storage.get<string[] | null>(storage.KEYS.collapsedSidebarItems, null, activeWorkspaceId)
      setCollapsedItems(newCollapsedItems !== null ? new Set(newCollapsedItems) : new Set(['nav:labels']))
    }

    previousWorkspaceRef.current = activeWorkspaceId
  }, [activeWorkspaceId, setCollapsedItems, setExpandedFolders, setFilterDropdownQuery, setFocusedSidebarItemId, setSearchActive, setSearchQuery, setViewFiltersMap])

React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getSources(activeWorkspaceId).then((loaded) => {
      setSources(loaded || [])
    }).catch(err => {
      console.error('[Chat] Failed to load sources:', err)
    })
  }, [activeWorkspaceId])

React.useEffect(() => {
    const cleanup = window.electronAPI.onSourcesChanged((workspaceId, updatedSources) => {
      if (workspaceId !== activeWorkspaceId) return
      // Clear icon cache so updated source icons are re-fetched on render
      clearSourceIconCaches()
      setSources(updatedSources || [])
    })
    return cleanup
  }, [activeWorkspaceId])

React.useEffect(() => {
    const cleanup = window.electronAPI.onSkillsChanged((workspaceId, updatedSkills) => {
      if (workspaceId !== activeWorkspaceId) return
      setSkills(updatedSkills || [])
    })
    return cleanup
  }, [activeWorkspaceId])

const handleSessionLabelsChange = React.useCallback(async (sessionId: string, labels: string[]) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setLabels', labels })
      // Session will emit a 'labels_changed' event that updates the session state
    } catch (err) {
      console.error('[Chat] Failed to set session labels:', err)
    }
  }, [])

const { statuses: statusConfigs, isLoading: isLoadingStatuses } = useStatuses(activeWorkspace?.id || null)

const [sessionStatuses, setSessionStatuses] = React.useState<SessionStatus[]>([])

React.useEffect(() => {
    if (!activeWorkspace?.id || statusConfigs.length === 0) {
      setSessionStatuses([])
      return
    }

    setSessionStatuses(statusConfigsToSessionStatuses(statusConfigs, activeWorkspace.id, isDark))
  }, [statusConfigs, activeWorkspace?.id, isDark])

const [optimisticStatusOrder, setOptimisticStatusOrder] = React.useState<string[] | null>(null)

React.useEffect(() => {
    setOptimisticStatusOrder(null)
  }, [statusConfigs])

const effectiveSessionStatuses = React.useMemo(() => {
    if (!optimisticStatusOrder) return sessionStatuses
    // Reorder sessionStatuses array to match optimistic order
    const stateMap = new Map(sessionStatuses.map(s => [s.id, s]))
    const reordered: SessionStatus[] = []
    for (const id of optimisticStatusOrder) {
      const state = stateMap.get(id)
      if (state) reordered.push(state)
    }
    // Append any states not in the optimistic order (shouldn't happen, but defensive)
    for (const state of sessionStatuses) {
      if (!optimisticStatusOrder.includes(state.id)) reordered.push(state)
    }
    return reordered
  }, [sessionStatuses, optimisticStatusOrder])

const { labels: labelConfigs } = useLabels(activeWorkspace?.id || null)

const displayLabelConfigs = useMemo(() => sortLabelsForDisplay(labelConfigs), [labelConfigs])

const { evaluateSession: evaluateViews, viewConfigs } = useViews(activeWorkspace?.id || null)

const labelTree = useMemo(() => buildLabelTree(displayLabelConfigs), [displayLabelConfigs])

const flatLabelMenuItems = useMemo(
    (): LabelMenuItem[] => createLabelMenuItems(displayLabelConfigs),
    [displayLabelConfigs],
  )

const [filterDropdownSelectedIdx, setFilterDropdownSelectedIdx] = React.useState(0)

const filterDropdownListRef = React.useRef<HTMLDivElement>(null)

const filterDropdownInputRef = React.useRef<HTMLInputElement>(null)

const filterDropdownResults = useMemo(() => {
    if (!filterDropdownQuery.trim()) return { states: [] as SessionStatus[], labels: [] as LabelMenuItem[] }
    return {
      states: filterLabelMenuStates(effectiveSessionStatuses, filterDropdownQuery),
      labels: filterLabelMenuItems(flatLabelMenuItems, filterDropdownQuery),
    }
  }, [filterDropdownQuery, effectiveSessionStatuses, flatLabelMenuItems])

React.useEffect(() => {
    setFilterDropdownSelectedIdx(0)
  }, [filterDropdownQuery])

React.useEffect(() => {
    if (!filterDropdownListRef.current) return
    const el = filterDropdownListRef.current.querySelector('[data-filter-selected="true"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [filterDropdownSelectedIdx])
return { enabledModes, setSkills, activeWorkspace, labelConfigs, effectiveSessionStatuses, sources, automations, evaluateViews, setOptimisticStatusOrder, viewConfigs, labelTree, skills, displayLabelConfigs, handleSessionLabelsChange, handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation, handleDeleteAutomation, automationTestResults, getAutomationHistory, handleReplayAutomation, projects, filterDropdownInputRef, filterDropdownResults, setFilterDropdownSelectedIdx, filterDropdownSelectedIdx, projectMenuOptions, filterDropdownListRef, localMcpEnabled, handleSessionProjectChange, automationPendingDelete, setAutomationPendingDelete, pendingDeleteAutomation, confirmDeleteAutomation, sendToWorkspaceIds, setSendToWorkspaceIds, handleTransferComplete }
}
