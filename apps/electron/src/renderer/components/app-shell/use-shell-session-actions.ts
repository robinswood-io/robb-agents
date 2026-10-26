import * as React from "react";

import { useCallback } from "react";

import { type ViewFiltersMap } from "./view-filters";

import { type SessionStatusId } from "@/config/session-status-config";

import * as storage from "@/lib/local-storage";

import { navigate, routes } from "@/lib/navigate";

import type { SettingsSubpage } from "../../../shared/types";

interface useShellSessionActionsInput {
  session: { selected: string | null; }
  setSession: (config: { selected: string | null; }) => void
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  activeWorkspaceId: string | null
  expandedFolders: Set<string>
  isSidebarVisible: boolean
  isSidebarAndNavigatorHidden: boolean
  setIsSidebarAndNavigatorHidden: React.Dispatch<React.SetStateAction<boolean>>
  handleToggleSidebar: () => void
  viewFiltersMap: ViewFiltersMap
  collapsedItems: Set<string>
  setOptimisticStatusOrder: React.Dispatch<React.SetStateAction<string[] | null>>
  setReleaseNotesContent: React.Dispatch<React.SetStateAction<string>>
  setShowWhatsNew: React.Dispatch<React.SetStateAction<boolean>>
  setHasUnseenReleaseNotes: React.Dispatch<React.SetStateAction<boolean>>
}

export function useShellSessionActions({
  session,
  setSession,
  onDeleteSession,
  activeWorkspaceId,
  expandedFolders,
  isSidebarVisible,
  isSidebarAndNavigatorHidden,
  setIsSidebarAndNavigatorHidden,
  handleToggleSidebar,
  viewFiltersMap,
  collapsedItems,
  setOptimisticStatusOrder,
  setReleaseNotesContent,
  setShowWhatsNew,
  setHasUnseenReleaseNotes,
}: useShellSessionActionsInput) {
const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation?: boolean): Promise<boolean> => {
    // Clear selection first if this is the selected session
    if (session.selected === sessionId) {
      setSession({ selected: null })
    }
    return onDeleteSession(sessionId, skipConfirmation)
  }, [session.selected, setSession, onDeleteSession])

React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.expandedFolders, [...expandedFolders], activeWorkspaceId)
  }, [expandedFolders, activeWorkspaceId])

React.useEffect(() => {
    storage.set(storage.KEYS.sidebarVisible, isSidebarVisible)
  }, [isSidebarVisible])

React.useEffect(() => {
    storage.set(storage.KEYS.focusModeEnabled, isSidebarAndNavigatorHidden)
  }, [isSidebarAndNavigatorHidden])

React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleFocusMode?.(() => {
      setIsSidebarAndNavigatorHidden(v => !v)
    })
    return cleanup
  }, [ setIsSidebarAndNavigatorHidden])

React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleSidebar?.(() => {
      handleToggleSidebar()
    })
    return cleanup
  }, [handleToggleSidebar])

React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.viewFilters, viewFiltersMap, activeWorkspaceId)
  }, [viewFiltersMap, activeWorkspaceId])

React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.collapsedSidebarItems, [...collapsedItems], activeWorkspaceId)
  }, [collapsedItems, activeWorkspaceId])

const handleAllSessionsClick = useCallback(() => {
    navigate(routes.view.allSessions())
  }, [])

const handleFlaggedClick = useCallback(() => {
    navigate(routes.view.flagged())
  }, [])

const handleArchivedClick = useCallback(() => {
    navigate(routes.view.archived())
  }, [])

const handleSessionStatusClick = useCallback((stateId: SessionStatusId) => {
    navigate(routes.view.state(stateId))
  }, [])

const handleLabelClick = useCallback((labelId: string) => {
    navigate(routes.view.label(labelId))
  }, [])

const handleViewClick = useCallback((viewId: string) => {
    navigate(routes.view.view(viewId))
  }, [])

const handleStatusReorder = useCallback((orderedIds: string[]) => {
    if (!activeWorkspaceId) return
    setOptimisticStatusOrder(orderedIds)
    window.electronAPI.reorderStatuses(activeWorkspaceId, orderedIds)
  }, [activeWorkspaceId, setOptimisticStatusOrder])

const handleSourcesClick = useCallback(() => {
    navigate(routes.view.sources())
  }, [])

const handleSourcesApiClick = useCallback(() => {
    navigate(routes.view.sourcesApi())
  }, [])

const handleSourcesMcpClick = useCallback(() => {
    navigate(routes.view.sourcesMcp())
  }, [])

const handleSourcesLocalClick = useCallback(() => {
    navigate(routes.view.sourcesLocal())
  }, [])

const handleSkillsClick = useCallback(() => {
    navigate(routes.view.skills())
  }, [])

const handleAutomationsClick = useCallback(() => {
    navigate(routes.view.automations())
  }, [])

const handleProjectsClick = useCallback(() => {
    navigate(routes.view.projects())
  }, [])

const handleAutomationsScheduledClick = useCallback(() => {
    navigate(routes.view.automationsScheduled())
  }, [])

const handleAutomationsEventClick = useCallback(() => {
    navigate(routes.view.automationsEvent())
  }, [])

const handleAutomationsAgenticClick = useCallback(() => {
    navigate(routes.view.automationsAgentic())
  }, [])

const handleSettingsClick = useCallback((subpage?: SettingsSubpage) => {
    navigate(routes.view.settings(subpage))
  }, [])

const handleWhatsNewClick = useCallback(async () => {
    const content = await window.electronAPI.getReleaseNotes()
    setReleaseNotesContent(content)
    setShowWhatsNew(true)
    setHasUnseenReleaseNotes(false)
    // Update last seen version
    const latestVersion = await window.electronAPI.getLatestReleaseVersion()
    if (latestVersion) {
      storage.set(storage.KEYS.whatsNewLastSeenVersion, latestVersion)
    }
  }, [ setHasUnseenReleaseNotes, setReleaseNotesContent, setShowWhatsNew])
return { handleAllSessionsClick, handleSessionStatusClick, handleFlaggedClick, handleArchivedClick, handleLabelClick, handleSourcesClick, handleSkillsClick, handleProjectsClick, handleAutomationsClick, handleSettingsClick, handleWhatsNewClick, handleViewClick, handleDeleteSession, handleSourcesApiClick, handleSourcesMcpClick, handleSourcesLocalClick, handleAutomationsScheduledClick, handleAutomationsEventClick, handleAutomationsAgenticClick }
}
