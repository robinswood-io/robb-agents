import * as React from "react";
import { Trans } from "react-i18next";

import { Button } from "@/components/ui/button";

import { DocumentFormattedMarkdownOverlay } from "@craft-agent/ui";

import { type ChatGroupingMode } from "./SessionList";

import { PanelStackContainer } from "./PanelStackContainer";

import { type LinkItem } from "./LeftSidebar";
import { type FilterMode } from "./view-filters";

import { AppShellProvider, type AppShellContextType } from "@/context/AppShellContext";

import { getResizeGradientStyle } from "@/hooks/useResizeGradient";

import type { Workspace, LoadedSource, LoadedSkill, SourceFilter, AutomationFilter } from "../../../shared/types";
import { type SessionMeta } from "@/atoms/sessions";

import { type SessionStatusId, type SessionStatus } from "@/config/session-status-config";

import { type LabelMenuItem } from "@/components/ui/label-menu-utils";

import type { LabelConfig, LabelTreeNode } from "@craft-agent/shared/labels";

import { navigate, routes } from "@/lib/navigate";
import { isSessionsNavigation, isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation, isProjectsNavigation, type NavigationState } from "@/contexts/NavigationContext";
import type { SettingsSubpage } from "../../../shared/types";
import { SourcesListPanel } from "./SourcesListPanel";
import { SkillsListPanel } from "./SkillsListPanel";
import { AutomationsListPanel } from "../automations/AutomationsListPanel";
import { ProjectsListPanel } from "./ProjectsListPanel";
import { AUTOMATION_TYPE_TO_FILTER_KIND } from "../automations/types";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

import { FabNewChat } from "./FabNewChat";
import { SendToWorkspaceDialog } from "./SendToWorkspaceDialog";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { MessagingDialogHost } from "@/components/messaging/MessagingDialogHost";

import SettingsNavigator from "@/pages/settings/SettingsNavigator";
import { PANEL_GAP, PANEL_EDGE_INSET, PANEL_SASH_HALF_HIT_WIDTH, PANEL_SASH_HIT_WIDTH, PANEL_SASH_LINE_WIDTH, PANEL_STACK_VERTICAL_OVERFLOW } from "./panel-constants";

import { ShellTopBar } from "./ShellTopBar";
import { ShellSidebar } from "./ShellSidebar";
import { ShellPanelHeader } from "./ShellPanelHeader";
import { ShellSessionList } from "./ShellSessionList";
import { ShellDialogs } from "./ShellDialogs";

interface AppShellViewProps {
  appShellContextValue: AppShellContextType; workspaces: Workspace[]; activeWorkspaceId: string | null; onSelectWorkspace: (id: string, openInNewWindow?: boolean) => void | Promise<void>;
  workspaceUnreadMap: Record<string, boolean>; onRefreshWorkspaces: (() => void) | undefined; effectiveSessionId: string | null; handleNewChat: (newPanel?: boolean) => void;
  onOpenSettings: () => void; handleSettingsClick: (subpage?: SettingsSubpage) => void; onOpenKeyboardShortcuts: () => void; onOpenStoredUserPreferences: () => void;
  goBack: () => void; goForward: () => void; canGoBack: boolean; canGoForward: boolean;
  handleToggleSidebar: () => void; setIsSidebarAndNavigatorHidden: React.Dispatch<React.SetStateAction<boolean>>; handleNewBrowserWindow: () => Promise<void>; isAutoCompact: boolean;
  shellRef: React.RefObject<HTMLDivElement | null>; sidebarRef: React.RefObject<HTMLDivElement | null>; sidebarWidth: number; sidebarFocused: boolean;
  handleSidebarKeyDown: (e: React.KeyboardEvent) => void; t: import("i18next").TFunction<"translation", undefined>; newChatHotkey: string | null; getSidebarItemProps: (id: string) => { tabIndex: number; 'data-focused': boolean; ref: (el: HTMLElement | null) => void; };
  focusedSidebarItemId: string | null; workspaceSessionMetas: SessionMeta[]; sessionFilter: import("@/contexts/NavigationContext").SessionFilter | null; handleAllSessionsClick: () => void;
  setSessionMetaMap: (args_0: Map<string, SessionMeta> | ((prev: Map<string, SessionMeta>) => Map<string, SessionMeta>)) => void; flaggedCount: number; handleFlaggedClick: () => void; archivedCount: number;
  handleArchivedClick: () => void; handleLabelClick: (labelId: string) => void; isExpanded: (id: string) => boolean; toggleExpanded: (id: string) => void;
  openConfigureLabels: (labelId?: string) => void; handleAddLabel: (parentId?: string) => void; buildLabelSidebarItems: (nodes: LabelTreeNode[]) => LinkItem[]; labelTree: LabelTreeNode[];
  sources: LoadedSource[]; navState: NavigationState; sourceFilter: SourceFilter | null; handleSourcesClick: () => void;
  openAddSource: (sourceType?: "api" | "mcp" | "local") => void; sourceTypeCounts: { api: number; mcp: number; local: number; }; handleSourcesApiClick: () => void; handleSourcesMcpClick: () => void;
  handleSourcesLocalClick: () => void; skills: LoadedSkill[]; handleSkillsClick: () => void; openAddSkill: () => void;
  projects: import("@craft-agent/shared/projects").LoadedProject[]; handleProjectsClick: () => void; openAddProject: () => void; projectFilter: Map<string, FilterMode>;
  handleJumpToProjectSessions: (projectId: string) => void; automations: import("../automations/types").AutomationListItem[]; automationFilter: AutomationFilter | null; handleAutomationsClick: () => void;
  openAddAutomation: () => void; automationTypeCounts: { scheduled: number; event: number; agentic: number; }; handleAutomationsScheduledClick: () => void; handleAutomationsEventClick: () => void;
  handleAutomationsAgenticClick: () => void; hasUnseenReleaseNotes: boolean; handleWhatsNewClick: () => Promise<void>; effectiveSidebarAndNavigatorHidden: boolean;
  isSidebarVisible: boolean; sessionListWidth: number; listTitle: string; listFilter: Map<string, FilterMode>;
  setListFilter: (updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => void; labelFilter: Map<string, FilterMode>; setLabelFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void; pinnedFilters: { pinnedStatusId: string | null; pinnedLabelId: string | null; pinnedFlagged: boolean; };
  effectiveSessionStatuses: SessionStatus[]; displayLabelConfigs: LabelConfig[]; labelConfigs: LabelConfig[]; chatGroupingMode: ChatGroupingMode;
  setChatGroupingMode: (mode: ChatGroupingMode) => void; isStateSubView: boolean; setSearchActive: React.Dispatch<React.SetStateAction<boolean>>; setFilterDropdownQuery: React.Dispatch<React.SetStateAction<string>>;
  setFilterAltHeld: React.Dispatch<React.SetStateAction<boolean>>; filterDropdownQuery: string; filterDropdownInputRef: React.RefObject<HTMLInputElement | null>; setProjectFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void;
  filterDropdownResults: { states: SessionStatus[]; labels: LabelMenuItem[]; }; setFilterDropdownSelectedIdx: React.Dispatch<React.SetStateAction<number>>; filterDropdownSelectedIdx: number; projectMenuOptions: { id: string; slug: string; name: string; color: string | undefined; }[];
  filterAltHeld: boolean; filterDropdownListRef: React.RefObject<HTMLDivElement | null>; activeWorkspace: Workspace | undefined; handleDeleteSource: (sourceSlug: string) => Promise<void>;
  handleSourceSelect: (source: LoadedSource) => void; localMcpEnabled: boolean; handleSkillSelect: (skill: LoadedSkill) => void; handleDeleteSkill: (skillSlug: string) => Promise<void>;
  handleAutomationSelect: (automationId: string) => void; handleTestAutomation: (automationId: string) => void; handleToggleAutomation: (automationId: string) => void; handleDuplicateAutomation: (automationId: string) => void;
  handleDeleteAutomation: (automationId: string) => void; searchActive: boolean; filteredSessionMetas: SessionMeta[]; workspaceSessionFamilyMetas: SessionMeta[];
  handleDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>; onFlagSession: (sessionId: string) => void; onUnflagSession: (sessionId: string) => void; onArchiveSession: (sessionId: string) => void;
  onUnarchiveSession: (sessionId: string) => void; onMarkSessionUnread: (sessionId: string) => void; onSessionStatusChange: (sessionId: string, state: import("@craft-agent/shared/protocol").SessionStatus) => void; onRenameSession: (sessionId: string, name: string) => void;
  focusChatInputForSession: (targetSessionId?: string | null) => void; focusedSessionId: string | null; session: { selected: string | null; }; navigateToSession: (sessionId: string) => void;
  sessionOptions: Map<string, import("../../hooks/useSessionOptions").SessionOptions>; searchQuery: string; setSearchQuery: React.Dispatch<React.SetStateAction<string>>; evaluateViews: (meta: SessionMeta) => import("@craft-agent/shared/views").ViewConfig[];
  handleSessionLabelsChange: (sessionId: string, labels: string[]) => Promise<void>; handleToggleLabelFilter: (labelId: string) => void; handleSessionProjectChange: (sessionId: string, projectId: string | null) => Promise<void>; panelCount: number;
  navigateToSessionInPanel: (sessionId: string) => void; hasPendingPrompt: (sessionId: string) => boolean; chatMatchInfo: { sessionId: string | null; count: number; index: number; isHighlighting?: boolean; }; isFullWidthView: boolean;
  isResizing: "sidebar" | "session-list" | null; resizeHandleRef: React.RefObject<HTMLDivElement | null>; setIsResizing: React.Dispatch<React.SetStateAction<"sidebar" | "session-list" | null>>; setSidebarHandleY: React.Dispatch<React.SetStateAction<number | null>>;
  sidebarHandleY: number | null; sessionListHandleRef: React.RefObject<HTMLDivElement | null>; setSessionListHandleY: React.Dispatch<React.SetStateAction<number | null>>; sessionListHandleY: number | null;
  editPopoverOpen: "labels" | "statuses" | "views" | "add-source" | "add-source-api" | "add-source-mcp" | "add-source-local" | "add-skill" | "add-label" | "automation-config" | "add-project" | null; setEditPopoverOpen: React.Dispatch<React.SetStateAction<"labels" | "statuses" | "views" | "add-source" | "add-source-api" | "add-source-mcp" | "add-source-local" | "add-skill" | "add-label" | "automation-config" | "add-project" | null>>; editPopoverAnchorY: React.RefObject<number>; editLabelTargetId: React.RefObject<string | undefined>;
  showWhatsNew: boolean; setShowWhatsNew: React.Dispatch<React.SetStateAction<boolean>>; releaseNotesContent: string; automationPendingDelete: string | null;
  setAutomationPendingDelete: (id: string | null) => void; pendingDeleteAutomation: import("../automations/types").AutomationListItem | undefined; confirmDeleteAutomation: () => void; sendToWorkspaceIds: string[];
  setSendToWorkspaceIds: (args_0: string[] | ((prev: string[]) => string[])) => void; handleTransferComplete: (targetWorkspaceId: string, _newSessionIds: string[]) => void; createProjectDialogOpen: boolean; setCreateProjectDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleCreateProjectSubmit: (name: string) => Promise<void>;
}

export function AppShellView({
  appShellContextValue, workspaces, activeWorkspaceId, onSelectWorkspace,
  workspaceUnreadMap, onRefreshWorkspaces, effectiveSessionId, handleNewChat,
  onOpenSettings, handleSettingsClick, onOpenKeyboardShortcuts, onOpenStoredUserPreferences,
  goBack, goForward, canGoBack, canGoForward,
  handleToggleSidebar, setIsSidebarAndNavigatorHidden, handleNewBrowserWindow, isAutoCompact,
  shellRef, sidebarRef, sidebarWidth, sidebarFocused,
  handleSidebarKeyDown, t, newChatHotkey, getSidebarItemProps,
  focusedSidebarItemId, workspaceSessionMetas, sessionFilter, handleAllSessionsClick,
  setSessionMetaMap, flaggedCount, handleFlaggedClick, archivedCount,
  handleArchivedClick, handleLabelClick, isExpanded, toggleExpanded,
  openConfigureLabels, handleAddLabel, buildLabelSidebarItems, labelTree,
  sources, navState, sourceFilter, handleSourcesClick,
  openAddSource, sourceTypeCounts, handleSourcesApiClick, handleSourcesMcpClick,
  handleSourcesLocalClick, skills, handleSkillsClick, openAddSkill,
  projects, handleProjectsClick, openAddProject, projectFilter,
  handleJumpToProjectSessions, automations, automationFilter, handleAutomationsClick,
  openAddAutomation, automationTypeCounts, handleAutomationsScheduledClick, handleAutomationsEventClick,
  handleAutomationsAgenticClick, hasUnseenReleaseNotes, handleWhatsNewClick, effectiveSidebarAndNavigatorHidden,
  isSidebarVisible, sessionListWidth, listTitle, listFilter,
  setListFilter, labelFilter, setLabelFilter, pinnedFilters,
  effectiveSessionStatuses, displayLabelConfigs, labelConfigs, chatGroupingMode,
  setChatGroupingMode, isStateSubView, setSearchActive, setFilterDropdownQuery,
  setFilterAltHeld, filterDropdownQuery, filterDropdownInputRef, setProjectFilter,
  filterDropdownResults, setFilterDropdownSelectedIdx, filterDropdownSelectedIdx, projectMenuOptions,
  filterAltHeld, filterDropdownListRef, activeWorkspace, handleDeleteSource,
  handleSourceSelect, localMcpEnabled, handleSkillSelect, handleDeleteSkill,
  handleAutomationSelect, handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation,
  handleDeleteAutomation, searchActive, filteredSessionMetas, workspaceSessionFamilyMetas,
  handleDeleteSession, onFlagSession, onUnflagSession, onArchiveSession,
  onUnarchiveSession, onMarkSessionUnread, onSessionStatusChange, onRenameSession,
  focusChatInputForSession, focusedSessionId, session, navigateToSession,
  sessionOptions, searchQuery, setSearchQuery, evaluateViews,
  handleSessionLabelsChange, handleToggleLabelFilter, handleSessionProjectChange, panelCount,
  navigateToSessionInPanel, hasPendingPrompt, chatMatchInfo, isFullWidthView,
  isResizing, resizeHandleRef, setIsResizing, setSidebarHandleY,
  sidebarHandleY, sessionListHandleRef, setSessionListHandleY, sessionListHandleY,
  editPopoverOpen, setEditPopoverOpen, editPopoverAnchorY, editLabelTargetId,
  showWhatsNew, setShowWhatsNew, releaseNotesContent, automationPendingDelete,
  setAutomationPendingDelete, pendingDeleteAutomation, confirmDeleteAutomation, sendToWorkspaceIds,
  setSendToWorkspaceIds, handleTransferComplete, createProjectDialogOpen, setCreateProjectDialogOpen,
  handleCreateProjectSubmit,
}: AppShellViewProps) {

  return (
    <AppShellProvider value={appShellContextValue}>
        {/* === TOP BAR === */}
        <ShellTopBar
          workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onSelectWorkspace={onSelectWorkspace}
          workspaceUnreadMap={workspaceUnreadMap} onRefreshWorkspaces={onRefreshWorkspaces} effectiveSessionId={effectiveSessionId}
          handleNewChat={handleNewChat} onOpenSettings={onOpenSettings} handleSettingsClick={handleSettingsClick}
          onOpenKeyboardShortcuts={onOpenKeyboardShortcuts} onOpenStoredUserPreferences={onOpenStoredUserPreferences} goBack={goBack}
          goForward={goForward} canGoBack={canGoBack} canGoForward={canGoForward}
          handleToggleSidebar={handleToggleSidebar} setIsSidebarAndNavigatorHidden={setIsSidebarAndNavigatorHidden} handleNewBrowserWindow={handleNewBrowserWindow}
          isAutoCompact={isAutoCompact}
        />

      {/* === OUTER LAYOUT: Unified Panel Stack | Right Sidebar === */}
      <div
        ref={shellRef}
        className="flex items-stretch relative"
        style={{
          height: '100%',
          paddingRight: isAutoCompact ? 0 : PANEL_EDGE_INSET,
          paddingBottom: isAutoCompact ? 0 : PANEL_EDGE_INSET,
          paddingLeft: 0,
          gap: PANEL_GAP,
        }}
      >
        <PanelStackContainer
          sidebarSlot={
            <ShellSidebar
              sidebarRef={sidebarRef} sidebarWidth={sidebarWidth} sidebarFocused={sidebarFocused}
              handleSidebarKeyDown={handleSidebarKeyDown} handleNewChat={handleNewChat} t={t}
              newChatHotkey={newChatHotkey} getSidebarItemProps={getSidebarItemProps} focusedSidebarItemId={focusedSidebarItemId}
              workspaceSessionMetas={workspaceSessionMetas} sessionFilter={sessionFilter} handleAllSessionsClick={handleAllSessionsClick}
              activeWorkspaceId={activeWorkspaceId} setSessionMetaMap={setSessionMetaMap} flaggedCount={flaggedCount}
              handleFlaggedClick={handleFlaggedClick} archivedCount={archivedCount} handleArchivedClick={handleArchivedClick}
              handleLabelClick={handleLabelClick} isExpanded={isExpanded} toggleExpanded={toggleExpanded}
              openConfigureLabels={openConfigureLabels} handleAddLabel={handleAddLabel} buildLabelSidebarItems={buildLabelSidebarItems}
              labelTree={labelTree} sources={sources} navState={navState}
              sourceFilter={sourceFilter} handleSourcesClick={handleSourcesClick} openAddSource={openAddSource}
              sourceTypeCounts={sourceTypeCounts} handleSourcesApiClick={handleSourcesApiClick} handleSourcesMcpClick={handleSourcesMcpClick}
              handleSourcesLocalClick={handleSourcesLocalClick} skills={skills} handleSkillsClick={handleSkillsClick}
              openAddSkill={openAddSkill} projects={projects} handleProjectsClick={handleProjectsClick}
              openAddProject={openAddProject} projectFilter={projectFilter} handleJumpToProjectSessions={handleJumpToProjectSessions}
              automations={automations} automationFilter={automationFilter} handleAutomationsClick={handleAutomationsClick}
              openAddAutomation={openAddAutomation} automationTypeCounts={automationTypeCounts} handleAutomationsScheduledClick={handleAutomationsScheduledClick}
              handleAutomationsEventClick={handleAutomationsEventClick} handleAutomationsAgenticClick={handleAutomationsAgenticClick} handleSettingsClick={handleSettingsClick}
              hasUnseenReleaseNotes={hasUnseenReleaseNotes} handleWhatsNewClick={handleWhatsNewClick}
            />
          }
          sidebarWidth={effectiveSidebarAndNavigatorHidden ? 0 : (isSidebarVisible ? sidebarWidth : 0)}
          navigatorSlot={
            <div
              style={{ width: isAutoCompact ? '100%' : sessionListWidth }}
              className="h-full flex flex-col min-w-0 relative z-panel"
            >
            <ShellPanelHeader
              isSidebarVisible={isSidebarVisible} listTitle={listTitle} automationFilter={automationFilter}
              isAutoCompact={isAutoCompact} navState={navState} listFilter={listFilter}
              setListFilter={setListFilter} labelFilter={labelFilter} setLabelFilter={setLabelFilter}
              pinnedFilters={pinnedFilters} effectiveSessionStatuses={effectiveSessionStatuses} displayLabelConfigs={displayLabelConfigs}
              labelConfigs={labelConfigs} chatGroupingMode={chatGroupingMode} setChatGroupingMode={setChatGroupingMode}
              isStateSubView={isStateSubView} setSearchActive={setSearchActive} setFilterDropdownQuery={setFilterDropdownQuery}
              setFilterAltHeld={setFilterAltHeld} projectFilter={projectFilter} filterDropdownQuery={filterDropdownQuery}
              filterDropdownInputRef={filterDropdownInputRef} t={t} setProjectFilter={setProjectFilter}
              filterDropdownResults={filterDropdownResults} setFilterDropdownSelectedIdx={setFilterDropdownSelectedIdx} filterDropdownSelectedIdx={filterDropdownSelectedIdx}
              projectMenuOptions={projectMenuOptions} filterAltHeld={filterAltHeld} filterDropdownListRef={filterDropdownListRef}
              activeWorkspace={activeWorkspace} sourceFilter={sourceFilter} openAddProject={openAddProject}
            />
            {/* Content: SessionList, SourcesListPanel, or SettingsNavigator based on navigation state */}
            {isSourcesNavigation(navState) && (
              /* Sources List - filtered by type if sourceFilter is active */
              <SourcesListPanel
                sources={sources}
                sourceFilter={sourceFilter}
                workspaceRootPath={activeWorkspace?.rootPath}
                onDeleteSource={handleDeleteSource}
                onSourceClick={handleSourceSelect}
                selectedSourceSlug={isSourcesNavigation(navState) && navState.details ? navState.details.sourceSlug : null}
                localMcpEnabled={localMcpEnabled}
              />
            )}
            {isSkillsNavigation(navState) && activeWorkspaceId && (
              /* Skills List */
              <SkillsListPanel
                skills={skills}
                workspaceId={activeWorkspaceId}
                workspaceRootPath={activeWorkspace?.rootPath}
                onSkillClick={handleSkillSelect}
                onDeleteSkill={handleDeleteSkill}
                selectedSkillSlug={isSkillsNavigation(navState) && navState.details?.type === 'skill' ? navState.details.skillSlug : null}
              />
            )}
            {isProjectsNavigation(navState) && activeWorkspaceId && (
              /* Projects List */
              <ProjectsListPanel
                projects={projects}
                workspaceId={activeWorkspaceId}
                onProjectClick={(slug) => navigate(routes.view.projects(slug))}
                onAddProject={openAddProject}
                onJumpToSessions={handleJumpToProjectSessions}
                selectedProjectSlug={isProjectsNavigation(navState) ? navState.details?.projectSlug ?? null : null}
              />
            )}
            {isAutomationsNavigation(navState) && (
              /* Automations List - filtered by type if automationFilter is active */
              <AutomationsListPanel
                automations={automations}
                automationFilter={automationFilter ? { kind: AUTOMATION_TYPE_TO_FILTER_KIND[automationFilter.automationType] ?? 'all' } : undefined}
                onAutomationClick={handleAutomationSelect}
                onTestAutomation={handleTestAutomation}
                onToggleAutomation={handleToggleAutomation}
                onDuplicateAutomation={handleDuplicateAutomation}
                onDeleteAutomation={handleDeleteAutomation}
                selectedAutomationId={isAutomationsNavigation(navState) && navState.details ? navState.details.automationId : null}
                workspaceRootPath={activeWorkspace?.rootPath}
              />
            )}
            {isSettingsNavigation(navState) && (
              /* Settings Navigator */
              <SettingsNavigator
                selectedSubpage={navState.subpage}
                onSelectSubpage={(subpage) => handleSettingsClick(subpage)}
              />
            )}
            {isSessionsNavigation(navState) && (
              /* Sessions List */
              <ShellSessionList
                sessionFilter={sessionFilter} searchActive={searchActive} workspaceSessionMetas={workspaceSessionMetas}
                filteredSessionMetas={filteredSessionMetas} workspaceSessionFamilyMetas={workspaceSessionFamilyMetas} handleDeleteSession={handleDeleteSession}
                onFlagSession={onFlagSession} onUnflagSession={onUnflagSession} onArchiveSession={onArchiveSession}
                onUnarchiveSession={onUnarchiveSession} onMarkSessionUnread={onMarkSessionUnread} onSessionStatusChange={onSessionStatusChange}
                onRenameSession={onRenameSession} focusChatInputForSession={focusChatInputForSession} focusedSessionId={focusedSessionId}
                session={session} navigateToSession={navigateToSession} activeWorkspaceId={activeWorkspaceId}
                sessionOptions={sessionOptions} searchQuery={searchQuery} setSearchQuery={setSearchQuery}
                setSearchActive={setSearchActive} effectiveSessionStatuses={effectiveSessionStatuses} evaluateViews={evaluateViews}
                displayLabelConfigs={displayLabelConfigs} handleSessionLabelsChange={handleSessionLabelsChange} handleToggleLabelFilter={handleToggleLabelFilter}
                projectMenuOptions={projectMenuOptions} handleSessionProjectChange={handleSessionProjectChange} chatGroupingMode={chatGroupingMode}
                listFilter={listFilter} labelFilter={labelFilter} panelCount={panelCount}
                navigateToSessionInPanel={navigateToSessionInPanel} hasPendingPrompt={hasPendingPrompt} chatMatchInfo={chatMatchInfo}
              />
            )}
            {/* Mobile/compact-only FAB for starting a new chat — only on the
                session list itself, not when a chat is open (it would overlap
                the chat input). */}
            {isAutoCompact && isSessionsNavigation(navState) && !navState.details && (
              <FabNewChat onClick={() => handleNewChat()} />
            )}
            </div>
          }
          navigatorWidth={isAutoCompact ? sessionListWidth : (effectiveSidebarAndNavigatorHidden || isFullWidthView ? 0 : sessionListWidth)}
          isSidebarAndNavigatorHidden={effectiveSidebarAndNavigatorHidden}
          isRightSidebarVisible={false}
          isCompact={isAutoCompact}
          isResizing={!!isResizing}
        />

        {/* Sidebar Resize Handle (absolute, hidden in focused mode) */}
        {!effectiveSidebarAndNavigatorHidden && (
        <div
          ref={resizeHandleRef}
          onMouseDown={(e) => { e.preventDefault(); setIsResizing('sidebar') }}
          onMouseMove={(e) => {
            if (resizeHandleRef.current) {
              const rect = resizeHandleRef.current.getBoundingClientRect()
              setSidebarHandleY(e.clientY - rect.top)
            }
          }}
          onMouseLeave={() => { if (!isResizing) setSidebarHandleY(null) }}
          className="absolute cursor-col-resize z-panel flex justify-center"
          style={{
            width: PANEL_SASH_HIT_WIDTH,
            top: PANEL_STACK_VERTICAL_OVERFLOW,
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
            left: isSidebarVisible
              ? sidebarWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH
              : -PANEL_GAP,
            transition: isResizing === 'sidebar' ? undefined : 'left 0.15s ease-out',
          }}
        >
          <div
            className="h-full"
            style={{
              ...getResizeGradientStyle(sidebarHandleY, resizeHandleRef.current?.clientHeight ?? null),
              width: PANEL_SASH_LINE_WIDTH,
            }}
          />
        </div>
        )}

        {/* Session List Resize Handle (absolute, hidden in focused mode and board view) */}
        {!effectiveSidebarAndNavigatorHidden && !isFullWidthView && (
        <div
          ref={sessionListHandleRef}
          onMouseDown={(e) => { e.preventDefault(); setIsResizing('session-list') }}
          onMouseMove={(e) => {
            if (sessionListHandleRef.current) {
              const rect = sessionListHandleRef.current.getBoundingClientRect()
              setSessionListHandleY(e.clientY - rect.top)
            }
          }}
          onMouseLeave={() => { if (isResizing !== 'session-list') setSessionListHandleY(null) }}
          className="absolute cursor-col-resize z-panel flex justify-center"
          style={{
            width: PANEL_SASH_HIT_WIDTH,
            top: PANEL_STACK_VERTICAL_OVERFLOW,
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
            left:
              (isSidebarVisible ? sidebarWidth + PANEL_GAP : PANEL_EDGE_INSET) +
              sessionListWidth +
              (PANEL_GAP / 2) -
              PANEL_SASH_HALF_HIT_WIDTH,
            transition: isResizing === 'session-list' ? undefined : 'left 0.15s ease-out',
          }}
        >
          <div
            className="h-full"
            style={{
              ...getResizeGradientStyle(sessionListHandleY, sessionListHandleRef.current?.clientHeight ?? null),
              width: PANEL_SASH_LINE_WIDTH,
            }}
          />
        </div>
        )}

      </div>

      {/* ============================================================================
       * CONTEXT MENU TRIGGERED EDIT POPOVERS
       * ============================================================================
       * These EditPopovers are opened programmatically from sidebar context menus.
       * They use controlled state (editPopoverOpen) and invisible anchors for positioning.
       * The anchor Y position is captured from the right-clicked item (editPopoverAnchorY ref)
       * so the popover appears near the triggering item rather than at a fixed location.
       * modal={true} prevents auto-close when focus shifts after context menu closes.
       */}
      {activeWorkspace && (
        <ShellDialogs
          editPopoverOpen={editPopoverOpen} setEditPopoverOpen={setEditPopoverOpen} sidebarWidth={sidebarWidth}
          editPopoverAnchorY={editPopoverAnchorY} activeWorkspace={activeWorkspace} editLabelTargetId={editLabelTargetId}
          labelConfigs={labelConfigs}
        />
      )}

      {/* What's New overlay */}
      <DocumentFormattedMarkdownOverlay
        isOpen={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
        content={releaseNotesContent}
        onOpenUrl={(url) => window.electronAPI.openUrl(url)}
      />

      {/* Delete automation confirmation dialog */}
      <Dialog open={!!automationPendingDelete} onOpenChange={(open) => { if (!open) setAutomationPendingDelete(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("dialog.deleteAutomation.title")}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="dialog.deleteAutomation.description"
                values={{ name: pendingDeleteAutomation?.name }}
                components={{ strong: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAutomationPendingDelete(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={confirmDeleteAutomation}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send to Workspace dialog (driven by sendToWorkspaceAtom) */}
      <SendToWorkspaceDialog
        open={sendToWorkspaceIds.length > 0}
        onOpenChange={(open) => { if (!open) setSendToWorkspaceIds([]) }}
        sessionIds={sendToWorkspaceIds}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onTransferComplete={handleTransferComplete}
      />

      {/* Create Project dialog — prompts for a name so slugs stay meaningful */}
      <CreateProjectDialog
        open={createProjectDialogOpen}
        onCancel={() => setCreateProjectDialogOpen(false)}
        onSubmit={handleCreateProjectSubmit}
      />

      {/* Messaging dialogs (pairing-code + WA connect) — driven by messagingDialogAtom.
          Mounted here so they survive context-menu / dropdown close. */}
      <MessagingDialogHost />

    </AppShellProvider>
  )
}
