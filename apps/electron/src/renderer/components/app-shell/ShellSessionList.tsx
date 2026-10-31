import * as React from "react";

import { SessionList, type ChatGroupingMode } from "./SessionList";

import { type FilterMode } from "./view-filters";

import { type SessionMeta } from "@/atoms/sessions";

import { type SessionStatus } from "@/config/session-status-config";

import type { LabelConfig } from "@craft-agent/shared/labels";

import { navigate, routes } from "@/lib/navigate";

interface ShellSessionListProps {
  sessionFilter: import("@/contexts/NavigationContext").SessionFilter | null
  searchActive: boolean
  workspaceSessionMetas: SessionMeta[]
  filteredSessionMetas: SessionMeta[]
  workspaceSessionFamilyMetas: SessionMeta[]
  handleDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  onFlagSession: (sessionId: string) => void
  onUnflagSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
  onUnarchiveSession: (sessionId: string) => void
  onMarkSessionUnread: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: import("@craft-agent/shared/protocol").SessionStatus) => void
  onRenameSession: (sessionId: string, name: string) => void
  focusChatInputForSession: (targetSessionId?: string | null) => void
  focusedSessionId: string | null
  session: { selected: string | null; }
  navigateToSession: (sessionId: string) => void
  activeWorkspaceId: string | null
  sessionOptions: Map<string, import("../../hooks/useSessionOptions").SessionOptions>
  searchQuery: string
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  setSearchActive: React.Dispatch<React.SetStateAction<boolean>>
  effectiveSessionStatuses: SessionStatus[]
  evaluateViews: (meta: SessionMeta) => import("@craft-agent/shared/views").ViewConfig[]
  displayLabelConfigs: LabelConfig[]
  handleSessionLabelsChange: (sessionId: string, labels: string[]) => Promise<void>
  handleToggleLabelFilter: (labelId: string) => void
  projectMenuOptions: { id: string; slug: string; name: string; color: string | undefined; }[]
  handleSessionProjectChange: (sessionId: string, projectId: string | null) => Promise<void>
  chatGroupingMode: ChatGroupingMode
  listFilter: Map<string, FilterMode>
  labelFilter: Map<string, FilterMode>
  panelCount: number
  navigateToSessionInPanel: (sessionId: string) => void
  hasPendingPrompt: (sessionId: string) => boolean
  chatMatchInfo: { sessionId: string | null; count: number; index: number; isHighlighting?: boolean; }
}

export function ShellSessionList({
  sessionFilter,
  searchActive,
  workspaceSessionMetas,
  filteredSessionMetas,
  workspaceSessionFamilyMetas,
  handleDeleteSession,
  onFlagSession,
  onUnflagSession,
  onArchiveSession,
  onUnarchiveSession,
  onMarkSessionUnread,
  onSessionStatusChange,
  onRenameSession,
  focusChatInputForSession,
  focusedSessionId,
  session,
  navigateToSession,
  activeWorkspaceId,
  sessionOptions,
  searchQuery,
  setSearchQuery,
  setSearchActive,
  effectiveSessionStatuses,
  evaluateViews,
  displayLabelConfigs,
  handleSessionLabelsChange,
  handleToggleLabelFilter,
  projectMenuOptions,
  handleSessionProjectChange,
  chatGroupingMode,
  listFilter,
  labelFilter,
  panelCount,
  navigateToSessionInPanel,
  hasPendingPrompt,
  chatMatchInfo,
}: ShellSessionListProps) {
  return (
<>
                {/* SessionList: Scrollable list of session cards */}
                {/* Key on sidebarMode forces full remount when switching views, skipping animations */}
                <SessionList
                  key={sessionFilter?.kind}
                  items={searchActive ? workspaceSessionMetas : filteredSessionMetas}
                  relatedItems={workspaceSessionFamilyMetas}
                  onDelete={handleDeleteSession}
                  onFlag={onFlagSession}
                  onUnflag={onUnflagSession}
                  onArchive={onArchiveSession}
                  onUnarchive={onUnarchiveSession}
                  onMarkUnread={onMarkSessionUnread}
                  onSessionStatusChange={onSessionStatusChange}
                  onRename={onRenameSession}
                  onFocusChatInput={(targetSessionId) => {
                    focusChatInputForSession(targetSessionId ?? focusedSessionId ?? session.selected)
                  }}
                  onSessionSelect={(selectedMeta) => {
                    navigateToSession(selectedMeta.id)
                  }}
                  onOpenInNewWindow={(selectedMeta) => {
                    if (activeWorkspaceId) {
                      window.electronAPI.openSessionInNewWindow(activeWorkspaceId, selectedMeta.id)
                    }
                  }}
                  onNavigateToView={(view) => {
                    if (view === 'allSessions') {
                      navigate(routes.view.allSessions())
                    } else if (view === 'flagged') {
                      navigate(routes.view.flagged())
                    }
                  }}
                  sessionOptions={sessionOptions}
                  searchActive={searchActive}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSearchClose={() => {
                    setSearchActive(false)
                    setSearchQuery('')
                  }}
                  sessionStatuses={effectiveSessionStatuses}
                  evaluateViews={evaluateViews}
                  labels={displayLabelConfigs}
                  onLabelsChange={handleSessionLabelsChange}
                  onToggleLabelFilter={handleToggleLabelFilter}
                  projects={projectMenuOptions}
                  onSetProjectId={handleSessionProjectChange}
                  groupingMode={chatGroupingMode}
                  workspaceId={activeWorkspaceId ?? undefined}
                  statusFilter={listFilter}
                  labelFilterMap={labelFilter}
                  focusedSessionId={panelCount === 0 ? null : panelCount > 1 ? focusedSessionId : undefined}
                  onNavigateToSession={panelCount > 1 ? navigateToSessionInPanel : undefined}
                  hasPendingPrompt={hasPendingPrompt}
                  activeChatMatchInfo={chatMatchInfo}
                />
              </>
  )
}
