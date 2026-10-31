import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from "react";

import { Archive, Settings, Flag, Tag, DatabaseZap, Zap, Inbox, Globe, FolderOpen, Cake, ListTodo, Clock, Radio, Bot, FolderKanban } from "lucide-react";

import { SquarePenRounded } from "../icons/SquarePenRounded";
import { McpIcon } from "../icons/McpIcon";

import { Button } from "@/components/ui/button";

import { Tooltip, TooltipTrigger, TooltipContent } from "@craft-agent/ui";

import { ContextMenu, ContextMenuTrigger, StyledContextMenuContent } from "@/components/ui/styled-context-menu";
import { ContextMenuProvider } from "@/components/ui/menu-context";
import { SidebarMenu } from "./SidebarMenu";

import { LeftSidebar, type LinkItem } from "./LeftSidebar";
import { type FilterMode } from "./view-filters";

import type { LoadedSource, LoadedSkill, SourceFilter, AutomationFilter } from "../../../shared/types";
import { type SessionMeta } from "@/atoms/sessions";

import type { LabelTreeNode } from "@craft-agent/shared/labels";

import { isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation, isProjectsNavigation, type NavigationState } from "@/contexts/NavigationContext";
import type { SettingsSubpage } from "../../../shared/types";

interface ShellSidebarProps {
  sidebarRef: React.RefObject<HTMLDivElement | null>
  sidebarWidth: number
  sidebarFocused: boolean
  handleSidebarKeyDown: (e: React.KeyboardEvent) => void
  handleNewChat: (newPanel?: boolean) => void
  t: import("i18next").TFunction<"translation", undefined>
  newChatHotkey: string | null
  getSidebarItemProps: (id: string) => { tabIndex: number; 'data-focused': boolean; ref: (el: HTMLElement | null) => void; }
  focusedSidebarItemId: string | null
  workspaceSessionMetas: SessionMeta[]
  sessionFilter: import("@/contexts/NavigationContext").SessionFilter | null
  handleAllSessionsClick: () => void
  activeWorkspaceId: string | null
  setSessionMetaMap: (args_0: Map<string, SessionMeta> | ((prev: Map<string, SessionMeta>) => Map<string, SessionMeta>)) => void
  flaggedCount: number
  handleFlaggedClick: () => void
  archivedCount: number
  handleArchivedClick: () => void
  handleLabelClick: (labelId: string) => void
  isExpanded: (id: string) => boolean
  toggleExpanded: (id: string) => void
  openConfigureLabels: (labelId?: string) => void
  handleAddLabel: (parentId?: string) => void
  buildLabelSidebarItems: (nodes: LabelTreeNode[]) => LinkItem[]
  labelTree: LabelTreeNode[]
  sources: LoadedSource[]
  navState: NavigationState
  sourceFilter: SourceFilter | null
  handleSourcesClick: () => void
  openAddSource: (sourceType?: "api" | "mcp" | "local") => void
  sourceTypeCounts: { api: number; mcp: number; local: number; }
  handleSourcesApiClick: () => void
  handleSourcesMcpClick: () => void
  handleSourcesLocalClick: () => void
  skills: LoadedSkill[]
  handleSkillsClick: () => void
  openAddSkill: () => void
  projects: import("@craft-agent/shared/projects").LoadedProject[]
  handleProjectsClick: () => void
  openAddProject: () => void
  projectFilter: Map<string, FilterMode>
  handleJumpToProjectSessions: (projectId: string) => void
  automations: import("../automations/types").AutomationListItem[]
  automationFilter: AutomationFilter | null
  handleAutomationsClick: () => void
  openAddAutomation: () => void
  automationTypeCounts: { scheduled: number; event: number; agentic: number; }
  handleAutomationsScheduledClick: () => void
  handleAutomationsEventClick: () => void
  handleAutomationsAgenticClick: () => void
  handleSettingsClick: (subpage?: SettingsSubpage) => void
  hasUnseenReleaseNotes: boolean
  handleWhatsNewClick: () => Promise<void>
}

export function ShellSidebar({
  sidebarRef,
  sidebarWidth,
  sidebarFocused,
  handleSidebarKeyDown,
  handleNewChat,
  t,
  newChatHotkey,
  getSidebarItemProps,
  focusedSidebarItemId,
  workspaceSessionMetas,
  sessionFilter,
  handleAllSessionsClick,
  activeWorkspaceId,
  setSessionMetaMap,
  flaggedCount,
  handleFlaggedClick,
  archivedCount,
  handleArchivedClick,
  handleLabelClick,
  isExpanded,
  toggleExpanded,
  openConfigureLabels,
  handleAddLabel,
  buildLabelSidebarItems,
  labelTree,
  sources,
  navState,
  sourceFilter,
  handleSourcesClick,
  openAddSource,
  sourceTypeCounts,
  handleSourcesApiClick,
  handleSourcesMcpClick,
  handleSourcesLocalClick,
  skills,
  handleSkillsClick,
  openAddSkill,
  projects,
  handleProjectsClick,
  openAddProject,
  projectFilter,
  handleJumpToProjectSessions,
  automations,
  automationFilter,
  handleAutomationsClick,
  openAddAutomation,
  automationTypeCounts,
  handleAutomationsScheduledClick,
  handleAutomationsEventClick,
  handleAutomationsAgenticClick,
  handleSettingsClick,
  hasUnseenReleaseNotes,
  handleWhatsNewClick,
}: ShellSidebarProps) {
  return (
<div
              ref={sidebarRef}
              style={{ width: sidebarWidth }}
              className="h-full font-sans relative"
              data-focus-zone="sidebar"
              tabIndex={sidebarFocused ? 0 : -1}
              onKeyDown={handleSidebarKeyDown}
            >
            <div className="flex h-full flex-col select-none">
              {/* Sidebar Top Section */}
              <div className="flex-1 flex flex-col min-h-0">
                {/* New Session Button - Gmail-style, with context menu for "Open in New Window" */}
                <div className="px-2 pb-2 shrink-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>
                        <ContextMenu modal={true}>
                          <ContextMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              onClick={(e) => handleNewChat(e.metaKey || e.ctrlKey)}
                              className="w-full justify-start gap-2 py-[7px] px-2 text-[13px] font-normal rounded-[6px] shadow-minimal bg-background"
                              data-tutorial="new-chat-button"
                            >
                              <SquarePenRounded className="h-3.5 w-3.5 shrink-0" />
                              {t("session.newSession")}
                            </Button>
                          </ContextMenuTrigger>
                          <StyledContextMenuContent>
                            <ContextMenuProvider>
                              <SidebarMenu type="newSession" />
                            </ContextMenuProvider>
                          </StyledContextMenuContent>
                        </ContextMenu>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">{newChatHotkey}</TooltipContent>
                  </Tooltip>
                </div>
                {/* Primary Nav: All Sessions (▸ Statuses, Flagged, Archived), Labels | Sources, Skills | Settings */}
                {/* pb-4 provides clearance so the last item scrolls above the mask-fade-bottom gradient */}
                <div className="flex-1 overflow-y-auto min-h-0 mask-fade-bottom pb-4">
                <LeftSidebar
                  isCollapsed={false}
                  getItemProps={getSidebarItemProps}
                  focusedItemId={focusedSidebarItemId}
                  links={[
                    // --- Sessions Section ---
                    {
                      id: "nav:allSessions",
                      title: t("sidebar.allSessions"),
                      label: String(workspaceSessionMetas.length),
                      icon: Inbox,
                      variant: sessionFilter?.kind === 'allSessions' ? "default" : "ghost",
                      onClick: handleAllSessionsClick,
                      contextMenu: {
                        type: 'allSessions',
                        onMarkAllRead: () => {
                          if (!activeWorkspaceId) return
                          // Optimistic: clear hasUnread on all workspace session metas
                          setSessionMetaMap(prev => {
                            const next = new Map(prev)
                            for (const [id, meta] of next) {
                              if (meta.workspaceId === activeWorkspaceId && meta.hasUnread) {
                                next.set(id, { ...meta, hasUnread: false })
                              }
                            }
                            return next
                          })
                          window.electronAPI.markAllSessionsRead(activeWorkspaceId)
                        },
                      },
                    },
                    // Flagged (Favoris)
                    {
                      id: "nav:flagged",
                      title: t("sidebar.flagged"),
                      label: String(flaggedCount),
                      icon: Flag,
                      variant: (sessionFilter?.kind === 'flagged' ? "default" : "ghost") as "default" | "ghost",
                      onClick: handleFlaggedClick,
                    },
                    // Archived (Archivées)
                    omitUndefined({
                      id: "nav:archived" as const,
                      title: t("sidebar.archived"),
                      label: archivedCount > 0 ? String(archivedCount) : undefined,
                      icon: Archive,
                      variant: (sessionFilter?.kind === 'archived' ? "default" : "ghost") as "default" | "ghost",
                      onClick: handleArchivedClick,
                    }),
                    // Labels: navigable header (shows all labeled sessions) + hierarchical tree (drag-and-drop reorder + re-parent)
                    {
                      id: "nav:labels",
                      title: t("sidebar.labels"),
                      icon: Tag,
                      // Only highlighted when "Labels" itself is selected (not sub-labels)
                      variant: (sessionFilter?.kind === 'label' && sessionFilter.labelId === '__all__') ? "default" as const : "ghost" as const,
                      // Clicking navigates to "all labeled sessions" view
                      onClick: () => handleLabelClick('__all__'),
                      expandable: true,
                      expanded: isExpanded('nav:labels'),
                      onToggle: () => toggleExpanded('nav:labels'),
                      contextMenu: {
                        type: 'labels' as const,
                        onConfigureLabels: openConfigureLabels,
                        onAddLabel: handleAddLabel,
                      },
                      items: buildLabelSidebarItems(labelTree),
                    },
                    // --- Separator ---
                    { id: "separator:chats-sources", type: "separator" },
                    // --- Sources & Skills Section ---
                    {
                      id: "nav:sources",
                      title: t("sidebar.sources"),
                      label: String(sources.length),
                      icon: DatabaseZap,
                      variant: (isSourcesNavigation(navState) && !sourceFilter) ? "default" : "ghost",
                      onClick: handleSourcesClick,
                      dataTutorial: "sources-nav",
                      expandable: true,
                      expanded: isExpanded('nav:sources'),
                      onToggle: () => toggleExpanded('nav:sources'),
                      contextMenu: {
                        type: 'sources',
                        onAddSource: () => openAddSource(),
                      },
                      items: [
                        {
                          id: "nav:sources:api",
                          title: t("sidebar.apis"),
                          label: String(sourceTypeCounts.api),
                          icon: Globe,
                          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'api') ? "default" : "ghost",
                          onClick: handleSourcesApiClick,
                          contextMenu: {
                            type: 'sources' as const,
                            onAddSource: () => openAddSource('api'),
                            sourceType: 'api',
                          },
                        },
                        {
                          id: "nav:sources:mcp",
                          title: t("sidebar.mcps"),
                          label: String(sourceTypeCounts.mcp),
                          icon: <McpIcon className="h-3.5 w-3.5" />,
                          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'mcp') ? "default" : "ghost",
                          onClick: handleSourcesMcpClick,
                          contextMenu: {
                            type: 'sources' as const,
                            onAddSource: () => openAddSource('mcp'),
                            sourceType: 'mcp',
                          },
                        },
                        {
                          id: "nav:sources:local",
                          title: t("sidebar.localFolders"),
                          label: String(sourceTypeCounts.local),
                          icon: FolderOpen,
                          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'local') ? "default" : "ghost",
                          onClick: handleSourcesLocalClick,
                          contextMenu: {
                            type: 'sources' as const,
                            onAddSource: () => openAddSource('local'),
                            sourceType: 'local',
                          },
                        },
                      ],
                    },
                    {
                      id: "nav:skills",
                      title: t("sidebar.skills"),
                      label: String(skills.length),
                      icon: Zap,
                      variant: isSkillsNavigation(navState) ? "default" : "ghost",
                      onClick: handleSkillsClick,
                      contextMenu: {
                        type: 'skills',
                        onAddSkill: openAddSkill,
                      },
                    },
                    {
                      id: "nav:projects",
                      title: t("sidebar.projects"),
                      label: String(projects.length),
                      icon: FolderKanban,
                      // Highlight only when on Projects view itself, not when a child is "active" (jumped-to filter)
                      variant: isProjectsNavigation(navState) ? "default" : "ghost",
                      onClick: handleProjectsClick,
                      expandable: projects.length > 0,
                      expanded: isExpanded('nav:projects'),
                      onToggle: () => toggleExpanded('nav:projects'),
                      contextMenu: {
                        type: 'projects' as const,
                        onAddProject: openAddProject,
                      },
                      items: projects.map(p => ({
                        id: `nav:projects:${p.config.id}`,
                        title: p.config.name,
                        icon: FolderKanban,
                        // Highlight when on allSessions view AND filter includes this project (the jump-to state)
                        variant: (sessionFilter?.kind === 'allSessions' && projectFilter.get(p.config.id) === 'include') ? "default" as const : "ghost" as const,
                        onClick: () => handleJumpToProjectSessions(p.config.id),
                      })),
                    },
                    {
                      id: "nav:automations",
                      title: t("sidebar.automations"),
                      label: String(automations.length),
                      icon: ListTodo,
                      variant: (isAutomationsNavigation(navState) && !automationFilter) ? "default" : "ghost",
                      onClick: handleAutomationsClick,
                      expandable: true,
                      expanded: isExpanded('nav:automations'),
                      onToggle: () => toggleExpanded('nav:automations'),
                      contextMenu: {
                        type: 'automations' as const,
                        onAddAutomation: openAddAutomation,
                      },
                      items: [
                        {
                          id: "nav:automations:scheduled",
                          title: t("sidebar.scheduled"),
                          label: String(automationTypeCounts.scheduled),
                          icon: Clock,
                          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'scheduled') ? "default" : "ghost",
                          onClick: handleAutomationsScheduledClick,
                          contextMenu: { type: 'automations' as const, onAddAutomation: openAddAutomation },
                        },
                        {
                          id: "nav:automations:event",
                          title: t("sidebar.eventBased"),
                          label: String(automationTypeCounts.event),
                          icon: Radio,
                          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'event') ? "default" : "ghost",
                          onClick: handleAutomationsEventClick,
                          contextMenu: { type: 'automations' as const, onAddAutomation: openAddAutomation },
                        },
                        {
                          id: "nav:automations:agentic",
                          title: t("sidebar.agentic"),
                          label: String(automationTypeCounts.agentic),
                          icon: Bot,
                          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'agentic') ? "default" : "ghost",
                          onClick: handleAutomationsAgenticClick,
                          contextMenu: { type: 'automations' as const, onAddAutomation: openAddAutomation },
                        },
                      ],
                    },
                    // --- Separator ---
                    { id: "separator:skills-settings", type: "separator" },
                    // --- Settings ---
                    {
                      id: "nav:settings",
                      title: t("sidebar.settings"),
                      icon: Settings,
                      variant: isSettingsNavigation(navState) ? "default" : "ghost",
                      onClick: () => handleSettingsClick(),
                    },
                    // --- What's New ---
                    {
                      id: "nav:whats-new",
                      title: t("sidebar.whatsNew"),
                      icon: hasUnseenReleaseNotes ? (
                        <span className="relative">
                          <Cake className="h-3.5 w-3.5" />
                          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
                        </span>
                      ) : Cake,
                      variant: "ghost" as const,
                      onClick: handleWhatsNewClick,
                    },
                  ]}
                />
                {/* Agent Tree: Hierarchical list of agents */}
                {/* Agents section removed */}
                </div>
              </div>

            </div>
          </div>
  )
}
