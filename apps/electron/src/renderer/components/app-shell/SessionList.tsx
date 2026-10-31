import type { UseSessionSearchOptions } from '../../hooks/useSessionSearch/matching.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSetAtom } from "jotai";
import { startOfDay } from "date-fns";
import "@craft-agent/shared/i18n";
import { useAction } from "@/actions";
import "lucide-react";
import { getSessionStatus } from "@/utils/session";
import "@/lib/local-storage";
import "@/lib/local-storage";
import { flattenLabels } from "@craft-agent/shared/labels";
import * as MultiSelect from "@/hooks/useMultiSelect";
import "@craft-agent/ui";
import "@/components/ui/entity-list-empty";
import "@/components/ui/entity-list";
import "@/components/ui/rename-dialog";
import "./SessionSearchHeader";
import "./SessionItem";
import "@/context/SessionListContext";
import { useSessionSelection, useSessionSelectionStore } from "@/hooks/useSession";
import { useSessionSearch } from "@/hooks/useSessionSearch";
import { useSessionActions } from "@/hooks/useSessionActions";
import { useEntityListInteractions } from "@/hooks/useEntityListInteractions";
import { useFocusZone } from "@/hooks/keyboard";
import { useEscapeInterrupt } from "@/context/EscapeInterruptContext";
import { useNavigation, useNavigationState, isSessionsNavigation } from "@/contexts/NavigationContext";
import { useFocusContext } from "@/context/FocusContext";
import { sendToWorkspaceAtom, type SessionMeta } from "@/atoms/sessions";
import "@/utils/session-list-collapse";
import { summarizeSessionsForSidebar } from "@/utils/session-subagent-summary";

import { buildSessionListRows, type SessionListProps, type SessionListRow } from "./session-list-data";
import { SessionListView, SessionListEmptyContent } from "./session-list-view";
import { useSessionListCollapse } from "./use-session-list-collapse";
export type { SessionListRow, ChatGroupingMode } from "./session-list-data";




















import { type SessionListContextValue } from "@/context/SessionListContext";














// Re-export SessionStatusId for use by parent components
export type { SessionStatusId } from "@/config/session-status-config"

/**
 * SessionList - Scrollable list of session cards with keyboard navigation
 *
 * Keyboard shortcuts:
 * - Arrow Up/Down: Navigate and select sessions (immediate selection)
 * - Arrow Left/Right: Navigate between zones
 * - Enter: Focus chat input
 * - Home/End: Jump to first/last session
 */
export function SessionList({
  items,
  relatedItems,
  onDelete,
  onFlag,
  onUnflag,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onSessionStatusChange,
  onRename,
  onFocusChatInput,
  onOpenInNewWindow,
  sessionOptions,
  searchActive,
  searchQuery = '',
  onSearchChange,
  onSearchClose,
  sessionStatuses = [],
  evaluateViews,
  labels = [],
  onLabelsChange,
  onToggleLabelFilter,
  projects,
  onSetProjectId,
  groupingMode = 'date',
  workspaceId,
  statusFilter,
  labelFilterMap,
  focusedSessionId,
  onNavigateToSession,
  hasPendingPrompt,
  activeChatMatchInfo,
}: SessionListProps) {
  const { t, i18n } = useTranslation()
  const setSendToWorkspace = useSetAtom(sendToWorkspaceAtom)

  // --- Selection (atom-backed, shared with ChatDisplay + BatchActionPanel) ---
  const {
    select: selectSession,
    toggle: toggleSession,
    selectRange,
    isMultiSelectActive,
  } = useSessionSelection()
  const selectionStore = useSessionSelectionStore()

  const { navigate, navigateToSession: navigateToSessionPrimary } = useNavigation()
  const navigateToSession = onNavigateToSession ?? navigateToSessionPrimary
  const navState = useNavigationState()
  const { showEscapeOverlay } = useEscapeInterrupt()

  // Pre-flatten label tree once for efficient ID lookups in each SessionItem
  const flatLabels = useMemo(() => flattenLabels(labels), [labels])
  const {
    topLevelSessions,
    subagentsBySessionId,
  } = useMemo(
    () => summarizeSessionsForSidebar(items, relatedItems ?? items),
    [items, relatedItems],
  )

  // Get current filter from navigation state (for preserving context in tab routes)
  const currentFilter = isSessionsNavigation(navState) ? navState.filter : undefined

  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState("")
  // Track if search input has actual DOM focus (for proper keyboard navigation gating)
  const [isSearchInputFocused, setIsSearchInputFocused] = useState(false)

  // Collapsed group keys (for collapsible group headers) — persisted per workspace/filter/grouping context
  const { setCollapsedGroups, collapsedGroups, toggleGroupCollapse } = useSessionListCollapse({
    workspaceId,
    currentFilter,
    groupingMode,
  })

  // --- Data pipeline (search, filtering, pagination, grouping) ---
  const scrollViewportRef = useRef<HTMLDivElement>(null)

  const {
    isSearchMode,
    highlightQuery,
    isSearchingContent,
    isSearchUnavailable,
    contentSearchResults,
    matchingFilterItems,
    otherResultItems,
    exceededSearchLimit,
    flatItems,
    hasMore,
    collapsedGroupsMeta,
    searchInputRef,
  } = useSessionSearch(omitUndefined<UseSessionSearchOptions>({
    items: topLevelSessions,
    searchActive: searchActive ?? false,
    searchQuery,
    ...(workspaceId !== undefined ? { workspaceId: workspaceId } : {}),
    ...(currentFilter !== undefined ? { currentFilter: currentFilter } : {}),
    ...(evaluateViews !== undefined ? { evaluateViews: evaluateViews } : {}),
    ...(statusFilter !== undefined ? { statusFilter: statusFilter } : {}),
    ...(labelFilterMap !== undefined ? { labelFilterMap: labelFilterMap } : {}),
    labelConfigs: labels,
    collapsedGroups,
    groupingMode,
    scrollViewportRef,
  }))

  const rowData = useMemo(() => {
    return buildSessionListRows({
    isSearchMode,
    matchingFilterItems,
    otherResultItems,
    t,
    flatItems,
    groupingMode,
    collapsedGroupsMeta,
    sessionStatuses,
    projects,
    i18n,
    })
  }, [isSearchMode, matchingFilterItems, otherResultItems, flatItems, groupingMode, sessionStatuses, projects, collapsedGroupsMeta, t, i18n])

  const flatRows = rowData.rows

  const collapseAllGroups = useCallback(() => {
    if (groupingMode === 'status') {
      const allKeys = new Set(topLevelSessions.map(item => `status-${getSessionStatus(item)}`))
      setCollapsedGroups(allKeys)
    } else if (groupingMode === 'unread') {
      const allKeys = new Set(topLevelSessions.map(item => item.hasUnread ? 'unread-yes' : 'unread-no'))
      setCollapsedGroups(allKeys)
    } else if (groupingMode === 'project') {
      const knownProjectIds = new Set((projects ?? []).map(p => p.id))
      const allKeys = new Set(topLevelSessions.map(item => {
        const pid = (item as { projectId?: string }).projectId
        return pid && knownProjectIds.has(pid) ? `project-${pid}` : 'project-__none__'
      }))
      setCollapsedGroups(allKeys)
    } else {
      const allKeys = new Set(topLevelSessions.map(item =>
        startOfDay(new Date(item.lastMessageAt || 0)).toISOString()
      ))
      setCollapsedGroups(allKeys)
    }
  }, [topLevelSessions, groupingMode, projects, setCollapsedGroups])
  const expandAllGroups = useCallback(() => {
    setCollapsedGroups(new Set())
  }, [setCollapsedGroups])

  const rowIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    flatRows.forEach((row, index) => {
      map.set(row.item.id, index)
    })
    return map
  }, [flatRows])

  // --- Action handlers with toast feedback ---
  const {
    handleFlagWithToast,
    handleUnflagWithToast,
    handleArchiveWithToast,
    handleUnarchiveWithToast,
    handleDeleteWithToast,
  } = useSessionActions({ ...(onFlag !== undefined ? { onFlag: onFlag } : {}), ...(onUnflag !== undefined ? { onUnflag: onUnflag } : {}), ...(onArchive !== undefined ? { onArchive: onArchive } : {}), ...(onUnarchive !== undefined ? { onUnarchive: onUnarchive } : {}), onDelete })

  // --- Focus zone ---
  const { focusZone } = useFocusContext()
  const { zoneRef, isFocused, shouldMoveDOMFocus } = useFocusZone({ zoneId: 'navigator' })

  // Keyboard eligibility: zone-focused OR search input focused (for arrow navigation)
  const isKeyboardEligible = isFocused || (searchActive && isSearchInputFocused)

  // --- Interactions (keyboard navigation + selection via shared atom) ---
  const interactions = useEntityListInteractions<SessionListRow>({
    items: flatRows,
    getId: (row) => row.item.id,
    keyboard: {
      onNavigate: useCallback((row: SessionListRow) => {
        navigateToSession(row.item.id)
      }, [navigateToSession]),
      onActivate: useCallback((row: SessionListRow) => {
        // Only navigate when not in multi-select (matches original behavior)
        if (!MultiSelect.isMultiSelectActive(selectionStore.state)) {
          navigateToSession(row.item.id)
        }
        onFocusChatInput?.(row.item.id)
      }, [selectionStore.state, navigateToSession, onFocusChatInput]),
      ...(isKeyboardEligible !== undefined ? { enabled: isKeyboardEligible } : {}),
      virtualFocus: searchActive ?? false,
    },
    multiSelect: true,
    selectionStore,
    ...(focusedSessionId !== undefined ? { selectedIdOverride: focusedSessionId } : {}),
  })

  // Sync activeIndex when selection changes externally (e.g. from ChatDisplay)
  useEffect(() => {
    const newIndex = flatRows.findIndex(row => row.item.id === selectionStore.state.selected)
    if (newIndex >= 0 && newIndex !== interactions.keyboard.activeIndex) {
      interactions.keyboard.setActiveIndex(newIndex)
    }
  }, [selectionStore.state.selected, flatRows, interactions.keyboard])

  // Focus active item when zone gains keyboard focus
  useEffect(() => {
    if (shouldMoveDOMFocus && flatRows.length > 0 && !(searchActive ?? false)) {
      interactions.keyboard.focusActiveItem()
    }
  }, [shouldMoveDOMFocus, flatRows.length, searchActive, interactions.keyboard])

  // --- Global keyboard shortcuts ---
  const isFocusWithinZone = () => zoneRef.current?.contains(document.activeElement) ?? false

  useAction('navigator.selectAll', () => {
    interactions.selection.selectAll()
  }, {
    enabled: isFocusWithinZone,
  }, [interactions.selection])

  useAction('navigator.clearSelection', () => {
    const selectedId = selectionStore.state.selected
    interactions.selection.clear()
    if (selectedId) navigateToSession(selectedId)
  }, {
    enabled: () => isMultiSelectActive && !showEscapeOverlay,
  }, [isMultiSelectActive, showEscapeOverlay, interactions.selection, selectionStore.state.selected, navigateToSession])

  // --- Click handlers ---
  const handleSelectSession = useCallback((row: SessionListRow, index: number) => {
    selectSession(row.item.id, index)
    navigateToSession(row.item.id)
  }, [selectSession, navigateToSession])

  const handleSelectSessionById = useCallback((sessionId: string) => {
    const index = rowIndexMap.get(sessionId) ?? -1
    if (index >= 0) {
      selectSession(sessionId, index)
    } else {
      selectSession(sessionId, 0)
    }
    navigateToSession(sessionId)
  }, [rowIndexMap, selectSession, navigateToSession])

  const handleToggleSelect = useCallback((row: SessionListRow, index: number) => {
    focusZone('navigator', { intent: 'click', moveFocus: false })
    toggleSession(row.item.id, index)
  }, [focusZone, toggleSession])

  const handleRangeSelect = useCallback((toIndex: number) => {
    focusZone('navigator', { intent: 'click', moveFocus: false })
    const allIds = flatRows.map(row => row.item.id)
    selectRange(toIndex, allIds)
  }, [focusZone, flatRows, selectRange])

  // Arrow key shortcuts for zone navigation (left → sidebar, right → chat)
  const handleKeyDown = useCallback((e: React.KeyboardEvent, _item: SessionMeta) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusZone('sidebar', { intent: 'keyboard' })
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusZone('chat', { intent: 'keyboard' })
      return
    }
  }, [focusZone])

  // --- Rename dialog ---
  const handleRenameClick = useCallback((sessionId: string, currentName: string) => {
    setRenameSessionId(sessionId)
    setRenameName(currentName)
    requestAnimationFrame(() => {
      setRenameDialogOpen(true)
    })
  }, [])

  const handleRenameSubmit = () => {
    if (renameSessionId && renameName.trim()) {
      onRename(renameSessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
    setRenameSessionId(null)
    setRenameName("")
  }

  // --- Search input key handler ---
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      searchInputRef.current?.blur()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onFocusChatInput?.(selectionStore.state.selected ?? undefined)
      return
    }
    // Forward arrow keys via interactions
    interactions.searchInputProps.onKeyDown(e)
  }, [searchInputRef, onFocusChatInput, interactions.searchInputProps, selectionStore.state.selected])

  // --- Context value (shared across all SessionItems) ---
  const handleFocusZone = useCallback(() => focusZone('navigator', { intent: 'click', moveFocus: false }), [focusZone])
  const handleOpenInNewWindow = useCallback((item: SessionMeta) => onOpenInNewWindow?.(item), [onOpenInNewWindow])
  const resolvedSearchQuery = isSearchMode ? highlightQuery : searchQuery

  const listContext = useMemo((): SessionListContextValue => (omitUndefined<SessionListContextValue>({
    onRenameClick: handleRenameClick,
    onSessionStatusChange,
    onFlag: onFlag ? handleFlagWithToast : undefined,
    onUnflag: onUnflag ? handleUnflagWithToast : undefined,
    onArchive: onArchive ? handleArchiveWithToast : undefined,
    onUnarchive: onUnarchive ? handleUnarchiveWithToast : undefined,
    onMarkUnread,
    onDelete: handleDeleteWithToast,
    ...(onLabelsChange !== undefined ? { onLabelsChange: onLabelsChange } : {}),
    ...(onToggleLabelFilter !== undefined ? { onToggleLabelFilter: onToggleLabelFilter } : {}),
    ...(projects !== undefined ? { projects: projects } : {}),
    ...(onSetProjectId !== undefined ? { onSetProjectId: onSetProjectId } : {}),
    onSelectSessionById: handleSelectSessionById,
    onOpenInNewWindow: handleOpenInNewWindow,
    onSendToWorkspace: (ids: string[]) => setSendToWorkspace(ids),
    onFocusZone: handleFocusZone,
    onKeyDown: handleKeyDown,
    sessionStatuses,
    flatLabels,
    labels,
    ...(resolvedSearchQuery !== undefined ? { searchQuery: resolvedSearchQuery } : {}),
    selectedSessionId: focusedSessionId !== undefined ? focusedSessionId : selectionStore.state.selected,
    isMultiSelectActive,
    ...(sessionOptions !== undefined ? { sessionOptions: sessionOptions } : {}),
    contentSearchResults,
    ...(activeChatMatchInfo !== undefined ? { activeChatMatchInfo: activeChatMatchInfo } : {}),
    ...(hasPendingPrompt !== undefined ? { hasPendingPrompt: hasPendingPrompt } : {}),
  })), [
    handleRenameClick, onSessionStatusChange,
    onFlag, handleFlagWithToast, onUnflag, handleUnflagWithToast,
    onArchive, handleArchiveWithToast, onUnarchive, handleUnarchiveWithToast,
    onMarkUnread, handleDeleteWithToast, onLabelsChange, onToggleLabelFilter,
    projects, onSetProjectId,
    handleSelectSessionById, handleOpenInNewWindow, setSendToWorkspace, handleFocusZone, handleKeyDown,
    sessionStatuses, flatLabels, labels, resolvedSearchQuery,
    focusedSessionId, selectionStore.state.selected, isMultiSelectActive,
    sessionOptions, contentSearchResults, activeChatMatchInfo, hasPendingPrompt,
  ])

  // --- Empty state (non-search) — render before EntityList ---
  // Don't show empty state when there are collapsed groups with content
  if (flatRows.length === 0 && rowData.groups.length === 0 && !searchActive) {
    return <SessionListEmptyContent
    currentFilter={currentFilter}
    t={t}
    navigate={navigate}
    />
  }

  // --- Render ---
  return <SessionListView
    listContext={listContext}
    rowData={rowData}
    rowIndexMap={rowIndexMap}
    interactions={interactions}
    subagentsBySessionId={subagentsBySessionId}
    handleSelectSession={handleSelectSession}
    handleToggleSelect={handleToggleSelect}
    handleRangeSelect={handleRangeSelect}
    searchActive={searchActive}
    searchQuery={searchQuery}
    onSearchChange={onSearchChange}
    onSearchClose={onSearchClose}
    handleSearchKeyDown={handleSearchKeyDown}
    setIsSearchInputFocused={setIsSearchInputFocused}
    isSearchingContent={isSearchingContent}
    isSearchUnavailable={isSearchUnavailable}
    matchingFilterItems={matchingFilterItems}
    otherResultItems={otherResultItems}
    exceededSearchLimit={exceededSearchLimit}
    searchInputRef={searchInputRef}
    isSearchMode={isSearchMode}
    t={t}
    hasMore={hasMore}
    scrollViewportRef={scrollViewportRef}
    zoneRef={zoneRef}
    collapsedGroups={collapsedGroups}
    toggleGroupCollapse={toggleGroupCollapse}
    collapseAllGroups={collapseAllGroups}
    expandAllGroups={expandAllGroups}
    renameDialogOpen={renameDialogOpen}
    setRenameDialogOpen={setRenameDialogOpen}
    renameName={renameName}
    setRenameName={setRenameName}
    handleRenameSubmit={handleRenameSubmit}
  />
}
