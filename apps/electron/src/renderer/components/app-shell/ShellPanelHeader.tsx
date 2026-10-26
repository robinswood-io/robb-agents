import * as React from "react";
import "lucide-react";
import "@/lib/utils";
import "@/components/ui/HeaderIconButton";
import "@craft-agent/ui";
import "@/components/ui/styled-dropdown";
import "./kanban/BoardListToggle";
import "./CompactSessionListFilter";
import "@/config/session-status-config";
import "@/components/ui/label-icon";
import "@craft-agent/shared/labels";
import "@/lib/navigate";
import "@/contexts/NavigationContext";
import "./PanelHeader";
import "@/components/ui/EditPopover";
import "./app-shell-filter-controls";
import "./FilterLabelItems";

import { ShellPanelHeaderView } from "./shell-panel-header-view";


import { type ChatGroupingMode } from "./SessionList";

import { type FilterMode } from "./view-filters";

import type { Workspace, SourceFilter, AutomationFilter } from "../../../shared/types";

import { type SessionStatusId, type SessionStatus } from "@/config/session-status-config";

import { type LabelMenuItem } from "@/components/ui/label-menu-utils";

import type { LabelConfig } from "@craft-agent/shared/labels";

import { type NavigationState } from "@/contexts/NavigationContext";

interface ShellPanelHeaderProps {
  isSidebarVisible: boolean
  listTitle: string
  automationFilter: AutomationFilter | null
  isAutoCompact: boolean
  navState: NavigationState
  listFilter: Map<string, FilterMode>
  setListFilter: (updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => void
  labelFilter: Map<string, FilterMode>
  setLabelFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void
  pinnedFilters: { pinnedStatusId: string | null; pinnedLabelId: string | null; pinnedFlagged: boolean; }
  effectiveSessionStatuses: SessionStatus[]
  displayLabelConfigs: LabelConfig[]
  labelConfigs: LabelConfig[]
  chatGroupingMode: ChatGroupingMode
  setChatGroupingMode: (mode: ChatGroupingMode) => void
  isStateSubView: boolean
  setSearchActive: React.Dispatch<React.SetStateAction<boolean>>
  setFilterDropdownQuery: React.Dispatch<React.SetStateAction<string>>
  setFilterAltHeld: React.Dispatch<React.SetStateAction<boolean>>
  projectFilter: Map<string, FilterMode>
  filterDropdownQuery: string
  filterDropdownInputRef: React.RefObject<HTMLInputElement | null>
  t: import("i18next").TFunction<"translation", undefined>
  setProjectFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void
  filterDropdownResults: { states: SessionStatus[]; labels: LabelMenuItem[]; }
  setFilterDropdownSelectedIdx: React.Dispatch<React.SetStateAction<number>>
  filterDropdownSelectedIdx: number
  projectMenuOptions: { id: string; slug: string; name: string; color: string | undefined; }[]
  filterAltHeld: boolean
  filterDropdownListRef: React.RefObject<HTMLDivElement | null>
  activeWorkspace: Workspace | undefined
  sourceFilter: SourceFilter | null
  openAddProject: () => void
}

export function ShellPanelHeader({
  isSidebarVisible,
  listTitle,
  automationFilter,
  isAutoCompact,
  navState,
  listFilter,
  setListFilter,
  labelFilter,
  setLabelFilter,
  pinnedFilters,
  effectiveSessionStatuses,
  displayLabelConfigs,
  labelConfigs,
  chatGroupingMode,
  setChatGroupingMode,
  isStateSubView,
  setSearchActive,
  setFilterDropdownQuery,
  setFilterAltHeld,
  projectFilter,
  filterDropdownQuery,
  filterDropdownInputRef,
  t,
  setProjectFilter,
  filterDropdownResults,
  setFilterDropdownSelectedIdx,
  filterDropdownSelectedIdx,
  projectMenuOptions,
  filterAltHeld,
  filterDropdownListRef,
  activeWorkspace,
  sourceFilter,
  openAddProject,
}: ShellPanelHeaderProps) {
  return (
    <ShellPanelHeaderView
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
  )
}
