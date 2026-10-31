

import { Inbox, Archive } from "lucide-react";

import { Spinner } from "@craft-agent/ui";
import { EntityListEmptyScreen } from "@/components/ui/entity-list-empty";
import { EntityList, type EntityListGroup } from "@/components/ui/entity-list";
import { RenameDialog } from "@/components/ui/rename-dialog";
import { SessionSearchHeader } from "./SessionSearchHeader";
import { SessionItem } from "./SessionItem";
import { SessionListProvider, type SessionListContextValue } from "@/context/SessionListContext";

import { routes } from "@/contexts/NavigationContext";

import { type SessionMeta } from "@/atoms/sessions";

import type { SessionListRow } from "./session-list-data";

interface SessionListViewProps {
  listContext: SessionListContextValue
  rowData: { rows: SessionListRow[]; groups: EntityListGroup<SessionListRow>[]; }
  rowIndexMap: Map<string, number>
  interactions: import("@/hooks/useEntityListInteractions").EntityListInteractions<SessionListRow>
  subagentsBySessionId: Map<string, import("@/utils/session-subagent-summary").SessionSubagentSummary>
  handleSelectSession: (row: SessionListRow, index: number) => void
  handleToggleSelect: (row: SessionListRow, index: number) => void
  handleRangeSelect: (toIndex: number) => void
  searchActive: boolean | undefined
  searchQuery: string
  onSearchChange: ((query: string) => void) | undefined
  onSearchClose: (() => void) | undefined
  handleSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  setIsSearchInputFocused: import("react").Dispatch<import("react").SetStateAction<boolean>>
  isSearchingContent: boolean
  isSearchUnavailable: boolean
  matchingFilterItems: SessionMeta[]
  otherResultItems: SessionMeta[]
  exceededSearchLimit: boolean
  searchInputRef: import("react").RefObject<HTMLInputElement | null>
  isSearchMode: boolean
  t: import("i18next").TFunction<"translation", undefined>
  hasMore: boolean
  scrollViewportRef: import("react").RefObject<HTMLDivElement | null>
  zoneRef: import("react").RefObject<HTMLDivElement | null>
  collapsedGroups: Set<string>
  toggleGroupCollapse: (groupKey: string) => void
  collapseAllGroups: () => void
  expandAllGroups: () => void
  renameDialogOpen: boolean
  setRenameDialogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>
  renameName: string
  setRenameName: import("react").Dispatch<import("react").SetStateAction<string>>
  handleRenameSubmit: () => void
}

export function SessionListView({
  listContext,
  rowData,
  rowIndexMap,
  interactions,
  subagentsBySessionId,
  handleSelectSession,
  handleToggleSelect,
  handleRangeSelect,
  searchActive,
  searchQuery,
  onSearchChange,
  onSearchClose,
  handleSearchKeyDown,
  setIsSearchInputFocused,
  isSearchingContent,
  isSearchUnavailable,
  matchingFilterItems,
  otherResultItems,
  exceededSearchLimit,
  searchInputRef,
  isSearchMode,
  t,
  hasMore,
  scrollViewportRef,
  zoneRef,
  collapsedGroups,
  toggleGroupCollapse,
  collapseAllGroups,
  expandAllGroups,
  renameDialogOpen,
  setRenameDialogOpen,
  renameName,
  setRenameName,
  handleRenameSubmit,
}: SessionListViewProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <SessionListProvider value={listContext}>
      <EntityList<SessionListRow>
        groups={rowData.groups}
        getKey={(row) => row.item.id}
        renderItem={(row, _indexInGroup, isFirstInGroup) => {
          const flatIndex = rowIndexMap.get(row.item.id) ?? 0
          const rowProps = interactions.getRowProps(row, flatIndex)
          return (
            <SessionItem
              item={row.item}
              index={flatIndex}
              itemProps={rowProps.buttonProps as Record<string, unknown>}
              isSelected={rowProps.isSelected}
              isFirstInGroup={isFirstInGroup}
              isInMultiSelect={rowProps.isInMultiSelect ?? false}
              subagentSummary={subagentsBySessionId.get(row.item.id)}
              onSelect={() => handleSelectSession(row, flatIndex)}
              onToggleSelect={() => handleToggleSelect(row, flatIndex)}
              onRangeSelect={() => handleRangeSelect(flatIndex)}
            />
          )
        }}
        header={
          <>
            {searchActive && (
              <SessionSearchHeader
                searchQuery={searchQuery}
                onSearchChange={onSearchChange}
                onSearchClose={onSearchClose}
                onKeyDown={handleSearchKeyDown}
                onFocus={() => setIsSearchInputFocused(true)}
                onBlur={() => setIsSearchInputFocused(false)}
                isSearching={isSearchingContent}
                isUnavailable={isSearchUnavailable}
                resultCount={matchingFilterItems.length + otherResultItems.length}
                exceededLimit={exceededSearchLimit}
                inputRef={searchInputRef}
              />
            )}
            {isSearchMode && matchingFilterItems.length === 0 && otherResultItems.length > 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                {t("session.noResultsInFilter")}
              </div>
            )}
          </>
        }
        emptyState={
          isSearchMode && !isSearchingContent ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <p className="text-sm text-muted-foreground">{t("session.noSessionsFound")}</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                {t("session.noSessionsFoundDesc")}
              </p>
              <button
                onClick={() => onSearchChange?.('')}
                className="text-xs text-foreground hover:underline mt-2"
              >
                {t("session.clearSearch")}
              </button>
            </div>
          ) : undefined
        }
        footer={
          hasMore ? (
            <div className="flex justify-center py-4">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : undefined
        }
        viewportRef={scrollViewportRef}
        containerRef={zoneRef}
        containerProps={{
          'data-focus-zone': 'navigator',
          'data-list-role': 'sessions',
          role: 'listbox',
          'aria-label': 'Sessions',
        }}
        scrollAreaClassName="select-none mask-fade-top-short"
        collapsedGroups={collapsedGroups}
        onToggleCollapse={toggleGroupCollapse}
        onCollapseAll={collapseAllGroups}
        onExpandAll={expandAllGroups}
      />
      </SessionListProvider>

      {/* Rename Dialog */}
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t("session.renameSession")}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t("session.enterSessionName")}
      />
    </div>
  )
}

interface SessionListEmptyContentProps {
  currentFilter: import("@/contexts/NavigationContext").SessionFilter | undefined
  t: import("i18next").TFunction<"translation", undefined>
  navigate: (route: import("@/contexts/NavigationContext").Route, options?: import("../../lib/navigate").NavigateOptions) => void | Promise<void>
}

export function SessionListEmptyContent({
  currentFilter,
  t,
  navigate,
}: SessionListEmptyContentProps) {
    if (currentFilter?.kind === 'archived') {
      return (
        <EntityListEmptyScreen
          icon={<Archive />}
          title={t("session.noArchivedSessions")}
          description={t("session.noArchivedSessionsDesc")}
          className="h-full"
        />
      )
    }

    return (
      <EntityListEmptyScreen
        icon={<Inbox />}
        title={t("session.noSessionsYet")}
        description={t("session.noSessionsYetDesc")}
        className="h-full"
      >
        <button
          onClick={() => {
            const params: { status?: string; label?: string } = {}
            if (currentFilter?.kind === 'state') params.status = currentFilter.stateId
            else if (currentFilter?.kind === 'label') params.label = currentFilter.labelId
            navigate(routes.action.newSession(Object.keys(params).length > 0 ? params : undefined))
          }}
          className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors"
        >
          {t("session.newSession")}
        </button>
      </EntityListEmptyScreen>
    )
  }
