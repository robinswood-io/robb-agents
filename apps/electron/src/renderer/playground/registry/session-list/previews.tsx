import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from "react";
import type { SessionMeta } from "@/atoms/sessions";
import type { ContentSearchResult } from "@/hooks/useSessionSearch";
import { SessionSearchHeader } from "@/components/app-shell/SessionSearchHeader";
import { SessionItem } from "@/components/app-shell/SessionItem";
import { SessionListProvider } from "@/context/SessionListContext";
import { ActionRegistryProvider } from "@/actions/registry";
import { sampleSessions, createMockContext, noopKeyDown } from "./fixtures";

// ============================================================================
// SessionListSearchPreview - Renders REAL SessionItem components with context
// ============================================================================

interface SessionListSearchPreviewProps {
  /** Current search query (highlights matches in titles) */
  searchQuery?: string | undefined
  /** Show search input bar */
  showSearchInput?: boolean | undefined
  /** Show loading state in status row */
  isSearching?: boolean | undefined
  /** Index of currently selected session (0-based) */
  selectedIndex?: number | undefined
  /** Match count for selected session (shows yellow badge) */
  chatMatchCount?: number | undefined
  /** Whether to show "no results" state */
  showNoResults?: boolean | undefined
  /** Explicit result count to display (defaults to filtered session count) */
  resultCount?: number | undefined
}

export function SessionListSearchPreview({
  searchQuery = '',
  showSearchInput = true,
  isSearching = false,
  selectedIndex = 0,
  chatMatchCount,
  showNoResults = false,
  resultCount,
}: SessionListSearchPreviewProps) {
  // Filter if there's a search query (simple title match for demo)
  const filteredSessions = React.useMemo(() => {
    if (showNoResults) return []
    if (!searchQuery) return sampleSessions
    return sampleSessions.filter(s => (s.name || '').toLowerCase().includes(searchQuery.toLowerCase()))
  }, [showNoResults, searchQuery])

  const selectedSessionId = filteredSessions[selectedIndex]?.id ?? null

  // Build content search results for match badge
  const contentSearchResults = new Map<string, ContentSearchResult>()
  if (chatMatchCount && selectedSessionId) {
    contentSearchResults.set(selectedSessionId, { matchCount: chatMatchCount, snippet: '' })
  }

  const ctx = createMockContext({
    searchQuery,
    selectedSessionId,
    contentSearchResults,
  })

  const displayCount = resultCount ?? filteredSessions.length

  return (
    <ActionRegistryProvider>
      <SessionListProvider value={ctx}>
        <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
          {/* Search header - uses the SAME component as the real app */}
          {showSearchInput && (
            <SessionSearchHeader
              searchQuery={searchQuery}
              isSearching={isSearching}
              resultCount={displayCount}
              readOnly
            />
          )}

          {/* Session list */}
          <div className="flex-1 overflow-auto">
            {showNoResults ? (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <p className="text-sm text-muted-foreground">No conversations found</p>
                <p className="text-xs text-muted-foreground/60 mt-0.5">
                  Searched titles and message content
                </p>
                <button className="text-xs text-foreground hover:underline mt-2">
                  Clear search
                </button>
              </div>
            ) : (
              <div className="flex flex-col pb-4">
                {/* Date header */}
                <div className="px-4 py-2">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Today
                  </span>
                </div>

                {filteredSessions.map((session, index) => (
                  <SessionItem
                    key={session.id}
                    item={session}
                    index={index}
                    itemProps={{ tabIndex: 0, onKeyDown: noopKeyDown }}
                    isSelected={session.id === selectedSessionId}
                    isFirstInGroup={index === 0}
                    isInMultiSelect={false}
                    onSelect={() => {}}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </SessionListProvider>
    </ActionRegistryProvider>
  )
}

// ============================================================================
// SessionItemPreview - Single real SessionItem with context providers
// ============================================================================

interface SessionItemPreviewProps {
  item?: SessionMeta | undefined
  isSelected?: boolean | undefined
  searchQuery?: string | undefined
  chatMatchCount?: number | undefined
  subagentCount?: number | undefined
  runningSubagentCount?: number | undefined
  state?: 'none' | 'loading' | 'plan' | 'new' | undefined
  flagged?: boolean | undefined
}

export function SessionItemPreview({
  item = sampleSessions[0],
  isSelected = false,
  searchQuery = '',
  chatMatchCount,
  subagentCount = 0,
  runningSubagentCount = 0,
  state = 'none',
  flagged = false,
}: SessionItemPreviewProps) {
  const resolvedItem = React.useMemo(() => {
    const base: SessionMeta = omitUndefined<SessionMeta>({ ...item, isProcessing: false, hasUnread: false, lastMessageRole: undefined, isFlagged: flagged })
    switch (state) {
      case 'loading': base.isProcessing = true; break
      case 'plan': base.lastMessageRole = 'plan'; break
      case 'new': base.hasUnread = true; break
    }
    return base
  }, [item, state, flagged])

  const contentSearchResults = new Map<string, ContentSearchResult>()
  if (chatMatchCount && resolvedItem) {
    contentSearchResults.set(resolvedItem.id, { matchCount: chatMatchCount, snippet: '' })
  }

  const ctx = createMockContext({
    searchQuery,
    selectedSessionId: isSelected ? resolvedItem.id : null,
    contentSearchResults,
  })

  return (
    <ActionRegistryProvider>
      <SessionListProvider value={ctx}>
        <SessionItem
          item={resolvedItem}
          index={0}
          itemProps={{ tabIndex: 0, onKeyDown: noopKeyDown }}
          isSelected={isSelected}
          isFirstInGroup
          isInMultiSelect={false}
          subagentSummary={subagentCount > 0 ? {
            totalCount: subagentCount,
            runningCount: Math.min(runningSubagentCount, subagentCount),
          } : undefined}
          onSelect={() => {}}
        />
      </SessionListProvider>
    </ActionRegistryProvider>
  )
}
