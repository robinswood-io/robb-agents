import * as React from "react";
import { ListFilter, Plus, Info } from "lucide-react";

import { HeaderIconButton } from "@/components/ui/HeaderIconButton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@craft-agent/ui";
import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent } from "@/components/ui/styled-dropdown";
import { type ChatGroupingMode } from "./SessionList";
import { BoardListToggle } from "./kanban/BoardListToggle";
import { CompactSessionListFilter } from "./CompactSessionListFilter";
import { type FilterMode } from "./view-filters";
import type { Workspace, SourceFilter, AutomationFilter } from "../../../shared/types";
import { type SessionStatusId, type SessionStatus } from "@/config/session-status-config";

import { type LabelMenuItem } from "@/components/ui/label-menu-utils";

import type { LabelConfig } from "@craft-agent/shared/labels";
import { navigate, routes } from "@/lib/navigate";
import { isSessionsNavigation, isSourcesNavigation, isSkillsNavigation, isAutomationsNavigation, isProjectsNavigation, type NavigationState } from "@/contexts/NavigationContext";
import { PanelHeader } from "./PanelHeader";
import { EditPopover, getEditConfig, type EditContextKey } from "@/components/ui/EditPopover";

import { ShellFilterSearch } from "./ShellFilterSearch";
import { ShellFilterChoices } from "./ShellFilterChoices";
import { ShellFilterGrouping } from "./ShellFilterGrouping";

interface ShellPanelHeaderViewProps {
  isSidebarVisible: boolean; listTitle: string; automationFilter: AutomationFilter | null;
  isAutoCompact: boolean; navState: NavigationState; listFilter: Map<string, FilterMode>;
  setListFilter: (updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => void; labelFilter: Map<string, FilterMode>; setLabelFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void;
  pinnedFilters: { pinnedStatusId: string | null; pinnedLabelId: string | null; pinnedFlagged: boolean; }; effectiveSessionStatuses: SessionStatus[]; displayLabelConfigs: LabelConfig[];
  labelConfigs: LabelConfig[]; chatGroupingMode: ChatGroupingMode; setChatGroupingMode: (mode: ChatGroupingMode) => void;
  isStateSubView: boolean; setSearchActive: React.Dispatch<React.SetStateAction<boolean>>; setFilterDropdownQuery: React.Dispatch<React.SetStateAction<string>>;
  setFilterAltHeld: React.Dispatch<React.SetStateAction<boolean>>; projectFilter: Map<string, FilterMode>; filterDropdownQuery: string;
  filterDropdownInputRef: React.RefObject<HTMLInputElement | null>; t: import("i18next").TFunction<"translation", undefined>; setProjectFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void;
  filterDropdownResults: { states: SessionStatus[]; labels: LabelMenuItem[]; }; setFilterDropdownSelectedIdx: React.Dispatch<React.SetStateAction<number>>; filterDropdownSelectedIdx: number;
  projectMenuOptions: { id: string; slug: string; name: string; color: string | undefined; }[]; filterAltHeld: boolean; filterDropdownListRef: React.RefObject<HTMLDivElement | null>;
  activeWorkspace: Workspace | undefined; sourceFilter: SourceFilter | null; openAddProject: () => void;
}

export function ShellPanelHeaderView({
  isSidebarVisible, listTitle, automationFilter,
  isAutoCompact, navState, listFilter,
  setListFilter, labelFilter, setLabelFilter,
  pinnedFilters, effectiveSessionStatuses, displayLabelConfigs,
  labelConfigs, chatGroupingMode, setChatGroupingMode,
  isStateSubView, setSearchActive, setFilterDropdownQuery,
  setFilterAltHeld, projectFilter, filterDropdownQuery,
  filterDropdownInputRef, t, setProjectFilter,
  filterDropdownResults, setFilterDropdownSelectedIdx, filterDropdownSelectedIdx,
  projectMenuOptions, filterAltHeld, filterDropdownListRef,
  activeWorkspace, sourceFilter, openAddProject,
}: ShellPanelHeaderViewProps) {

  return (
<PanelHeader
              title={isSidebarVisible ? listTitle : undefined}
              compensateForStoplight={!isSidebarVisible}
              badge={automationFilter?.automationType === 'scheduled' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground/50 cursor-default flex items-center titlebar-no-drag">
                      <Info className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[220px]">
                    Scheduling requires your machine to be running. It can be locked, but must be powered on.
                  </TooltipContent>
                </Tooltip>
              ) : undefined}
              actions={
                <>
                  {/* List ⇄ Board view switch (sessions mode, desktop widths only).
                      In board view the navigator is collapsed, so the board hosts its own copy. */}
                  {!isAutoCompact && isSessionsNavigation(navState) && (
                    <BoardListToggle
                      value="list"
                      onChange={view => {
                        if (view === 'board') navigate(routes.view.board())
                      }}
                    />
                  )}
                  {/* Filter dropdown - available in ALL chat views.
                      Shows user-added filters (removable) and pinned filters (non-removable, derived from route).
                      Pinned filters: state views pin a status, label views pin a label, flagged pins the flag. */}
                  {isSessionsNavigation(navState) && (
                    isAutoCompact ? (
                      <CompactSessionListFilter
                        listFilter={listFilter}
                        setListFilter={setListFilter}
                        labelFilter={labelFilter}
                        setLabelFilter={setLabelFilter}
                        pinnedFilters={pinnedFilters}
                        effectiveSessionStatuses={effectiveSessionStatuses}
                        displayLabelConfigs={displayLabelConfigs}
                        labelConfigs={labelConfigs}
                        chatGroupingMode={chatGroupingMode}
                        setChatGroupingMode={setChatGroupingMode}
                        isStateSubView={isStateSubView}
                        onOpenSearch={() => setSearchActive(true)}
                      />
                    ) : (
                    <DropdownMenu onOpenChange={(open) => { if (!open) { setFilterDropdownQuery(''); setFilterAltHeld(false) } }}>
                      <DropdownMenuTrigger asChild>
                        <HeaderIconButton
                          icon={<ListFilter className="h-4 w-4" />}
                          className={(listFilter.size > 0 || labelFilter.size > 0 || projectFilter.size > 0) ? "bg-accent/5 text-accent rounded-[8px] shadow-tinted" : "rounded-[8px]"}
                          style={(listFilter.size > 0 || labelFilter.size > 0 || projectFilter.size > 0) ? { '--shadow-color': 'var(--accent-rgb)' } as React.CSSProperties : undefined}
                        />
                      </DropdownMenuTrigger>
                      <StyledDropdownMenuContent
                        align="end"
                        light
                        minWidth="min-w-[200px]"
                        onKeyDown={(e: React.KeyboardEvent) => {
                          if (e.key === 'Alt') setFilterAltHeld(true)
                          // When on the first menu item and pressing Up, refocus the search input
                          if (e.key === 'ArrowUp' && !filterDropdownQuery.trim()) {
                            const menu = (e.target as HTMLElement).closest('[role="menu"]')
                            const items = menu?.querySelectorAll('[role="menuitem"]')
                            if (items && items.length > 0 && document.activeElement === items[0]) {
                              e.preventDefault()
                              e.stopPropagation()
                              filterDropdownInputRef.current?.focus()
                            }
                          }
                        }}
                        onKeyUp={(e: React.KeyboardEvent) => {
                          if (e.key === 'Alt') setFilterAltHeld(false)
                        }}
                      >
                        {/* Header with title and clear button (only clears user-added filters, never pinned) */}
                        <div className="flex items-center justify-between px-2 py-1.5">
                          <span className="text-xs font-medium text-muted-foreground">{t("sidebar.filterChats")}</span>
                          {(listFilter.size > 0 || labelFilter.size > 0 || projectFilter.size > 0) && (
                            <button
                              onClick={(e) => {
                                e.preventDefault()
                                setListFilter(new Map())
                                setLabelFilter(new Map())
                                setProjectFilter(new Map())
                              }}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Clear
                            </button>
                          )}
                        </div>

                        {/* Search input — typing switches from hierarchical submenus to a flat filtered list.
                            stopPropagation prevents Radix from intercepting keys. Arrow/Enter handled for navigation. */}
                        <ShellFilterSearch
  filterDropdownInputRef={filterDropdownInputRef}
  filterDropdownQuery={filterDropdownQuery}
  setFilterDropdownQuery={setFilterDropdownQuery}
  filterDropdownResults={filterDropdownResults}
  setFilterDropdownSelectedIdx={setFilterDropdownSelectedIdx}
  filterDropdownSelectedIdx={filterDropdownSelectedIdx}
  pinnedFilters={pinnedFilters}
  setListFilter={setListFilter}
  setLabelFilter={setLabelFilter}
  t={t}
/>

                        {/* ── Conditional body: hierarchical (no query) vs flat filtered list (has query) ── */}
                        {filterDropdownQuery.trim() === '' ? (
                          <ShellFilterChoices
  pinnedFilters={pinnedFilters}
  listFilter={listFilter}
  labelFilter={labelFilter}
  projectFilter={projectFilter}
  t={t}
  effectiveSessionStatuses={effectiveSessionStatuses}
  labelConfigs={labelConfigs}
  setListFilter={setListFilter}
  setLabelFilter={setLabelFilter}
  projectMenuOptions={projectMenuOptions}
  setProjectFilter={setProjectFilter}
  filterAltHeld={filterAltHeld}
  displayLabelConfigs={displayLabelConfigs}
  isStateSubView={isStateSubView}
  setChatGroupingMode={setChatGroupingMode}
  chatGroupingMode={chatGroupingMode}
  setSearchActive={setSearchActive}
/>
                        ) : (
                          <ShellFilterGrouping
  filterDropdownResults={filterDropdownResults}
  filterDropdownListRef={filterDropdownListRef}
  pinnedFilters={pinnedFilters}
  listFilter={listFilter}
  filterDropdownSelectedIdx={filterDropdownSelectedIdx}
  setFilterDropdownSelectedIdx={setFilterDropdownSelectedIdx}
  setListFilter={setListFilter}
  t={t}
  filterAltHeld={filterAltHeld}
  labelFilter={labelFilter}
  setLabelFilter={setLabelFilter}
/>
                        )}
                      </StyledDropdownMenuContent>
                    </DropdownMenu>
                    )
                  )}
                  {/* Add Source button (only for sources mode) - uses filter-aware edit config */}
                  {isSourcesNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addSource")}
                          data-tutorial="add-source-button"
                        />
                      }
                      {...getEditConfig(
                        sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as EditContextKey : 'add-source',
                        activeWorkspace.rootPath
                      )}
                    />
                  )}
                  {/* Add Skill button (only for skills mode) */}
                  {isSkillsNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addSkill")}
                          data-tutorial="add-skill-button"
                        />
                      }
                      {...getEditConfig('add-skill', activeWorkspace.rootPath)}
                    />
                  )}
                  {/* Add Automation button (only for automations mode) */}
                  {isAutomationsNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addAutomation")}
                        />
                      }
                      {...getEditConfig('automation-config', activeWorkspace.rootPath)}
                    />
                  )}
                  {/* Add Project button (only for projects mode) */}
                  {isProjectsNavigation(navState) && activeWorkspace && (
                    <HeaderIconButton
                      icon={<Plus className="h-4 w-4" />}
                      tooltip={t("sidebarMenu.addProject")}
                      onClick={openAddProject}
                    />
                  )}
                </>
              }
            />
  )
}
