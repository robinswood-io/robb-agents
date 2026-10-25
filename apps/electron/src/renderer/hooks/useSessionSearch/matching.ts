import { isToday, isYesterday, format, startOfDay } from "date-fns";
import { parseLabelEntry, matchesLabelFilter } from "@craft-agent/shared/labels";
import type { LabelConfig } from "@craft-agent/shared/labels";
import { getSessionStatus } from "@/utils/session";
import type { SessionMeta } from "@/atoms/sessions";
import type { ViewConfig } from "@craft-agent/shared/views";
import type { SessionFilter } from "@/contexts/NavigationContext";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INITIAL_DISPLAY_LIMIT = 50

export const BATCH_SIZE = 50

export const MAX_SEARCH_RESULTS = 100

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching */
export type FilterMode = 'include' | 'exclude'

export interface DateGroup {
  date: Date
  label: string
  sessions: SessionMeta[]
}

export interface ContentSearchResult {
  matchCount: number
  snippet: string
}

/** Metadata for a collapsed group — emitted by the data pipeline so the renderer can show header-only groups */
export interface CollapsedGroupMeta {
  key: string
  count: number
}

export interface UseSessionSearchOptions {
  items: SessionMeta[]
  searchActive: boolean
  searchQuery: string
  workspaceId?: string
  currentFilter?: SessionFilter
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  statusFilter?: Map<string, FilterMode>
  labelFilterMap?: Map<string, FilterMode>
  /** Workspace label tree — label filters match descendants through it (shared matchesLabelFilter). */
  labelConfigs?: LabelConfig[]
  /** Collapsed group keys — collapsed items are excluded from pagination and flatItems */
  collapsedGroups?: Set<string>
  /** Grouping mode — needed to compute group keys for collapse-aware pagination */
  groupingMode?: 'date' | 'status' | 'unread' | 'project'
  /** Ref to the ScrollArea viewport element — used for scroll-based pagination */
  scrollViewportRef?: React.RefObject<HTMLDivElement | null>
}

export interface UseSessionSearchResult {
  // Search state
  isSearchMode: boolean
  highlightQuery: string | undefined
  isSearchingContent: boolean
  /** Whether the search service is unavailable (e.g. ripgrep not found on remote server) */
  isSearchUnavailable: boolean
  /** Raw content search results — needed by SessionItem for `chatMatchCount` */
  contentSearchResults: Map<string, ContentSearchResult>

  // Filtered + grouped results
  matchingFilterItems: SessionMeta[]
  otherResultItems: SessionMeta[]
  exceededSearchLimit: boolean

  // Render-ready outputs
  flatItems: SessionMeta[]
  dateGroups: DateGroup[]
  sessionIndexMap: Map<string, number>

  // Pagination
  hasMore: boolean
  /** Metadata for collapsed groups (key + item count) — used to build header-only placeholder groups */
  collapsedGroupsMeta: CollapsedGroupMeta[]

  // Refs
  searchInputRef: React.RefObject<HTMLInputElement | null>
}

// ---------------------------------------------------------------------------
// Pure helpers (moved from SessionList)
// ---------------------------------------------------------------------------

function formatDateHeader(date: Date): string {
  if (isToday(date)) return "Today"
  if (isYesterday(date)) return "Yesterday"
  return format(date, "MMM d")
}

export function groupSessionsByDate(sessions: SessionMeta[]): DateGroup[] {
  const groups = new Map<string, { date: Date; sessions: SessionMeta[] }>()

  for (const session of sessions) {
    const timestamp = session.lastMessageAt || 0
    const date = startOfDay(new Date(timestamp))
    const key = date.toISOString()

    if (!groups.has(key)) {
      groups.set(key, { date, sessions: [] })
    }
    groups.get(key)!.sessions.push(session)
  }

  return Array.from(groups.values())
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map(group => ({
      ...group,
      label: formatDateHeader(group.date),
    }))
}

function getCollapseGroupKey(item: SessionMeta, groupingMode?: 'date' | 'status' | 'unread' | 'project'): string {
  if (groupingMode === 'status') return `status-${getSessionStatus(item)}`
  if (groupingMode === 'unread') return item.hasUnread ? 'unread-yes' : 'unread-no'
  if (groupingMode === 'project') return `project-${(item as { projectId?: string }).projectId ?? '__none__'}`
  return startOfDay(new Date(item.lastMessageAt || 0)).toISOString()
}

export interface CollapsedPaginationResult {
  paginatedItems: SessionMeta[]
  hasMore: boolean
  collapsedGroupsMeta: CollapsedGroupMeta[]
}

export function computeCollapsedPagination(
  items: SessionMeta[],
  displayLimit: number,
  collapsedGroups?: Set<string>,
  groupingMode?: 'date' | 'status' | 'unread' | 'project',
): CollapsedPaginationResult {
  // `date` grouping is inherently chronological, so a single global window
  // (newest-first, grow on scroll) is the correct lazy-load behavior.
  //
  // `status` / `unread` grouping is NOT chronological: an old To-do/Needs-review
  // or unread session should surface in its group regardless of age. A global
  // chronological slice silently drops such items out of their group once they
  // fall past the loaded window (#501). For these modes we therefore paginate
  // *per group* — each group reveals up to `displayLimit` of its own most-recent
  // items — so small open-work groups show in full while large groups (e.g.
  // Done) stay bounded. `displayLimit` still grows on scroll via the caller.
  const perGroup = groupingMode === 'status' || groupingMode === 'unread'

  // Pick the visible items honoring `displayLimit`, optionally skipping groups in
  // `excludeKeys` (collapsed groups). Preserves the incoming item order.
  const paginate = (excludeKeys?: Set<string>): { picked: SessionMeta[]; hasMore: boolean } => {
    if (!perGroup) {
      const list = excludeKeys && excludeKeys.size > 0
        ? items.filter(item => !excludeKeys.has(getCollapseGroupKey(item, groupingMode)))
        : items
      return { picked: list.slice(0, displayLimit), hasMore: displayLimit < list.length }
    }
    const perGroupCount = new Map<string, number>()
    const picked: SessionMeta[] = []
    let hasMore = false
    for (const item of items) {
      const key = getCollapseGroupKey(item, groupingMode)
      if (excludeKeys?.has(key)) continue
      const shown = perGroupCount.get(key) ?? 0
      if (shown < displayLimit) {
        picked.push(item)
        perGroupCount.set(key, shown + 1)
      } else {
        hasMore = true
      }
    }
    return { picked, hasMore }
  }

  // Fast path: no collapse state.
  if (!collapsedGroups || collapsedGroups.size === 0) {
    const { picked, hasMore } = paginate()
    return { paginatedItems: picked, hasMore, collapsedGroupsMeta: [] }
  }

  const groupKeysInView = new Set(items.map(item => getCollapseGroupKey(item, groupingMode)))

  // Safety guard: don't allow collapse state to hide the entire list when only one
  // group exists in the current filtered view (there would be no meaningful collapse UX).
  if (groupKeysInView.size <= 1) {
    const { picked, hasMore } = paginate()
    return { paginatedItems: picked, hasMore, collapsedGroupsMeta: [] }
  }

  const effectiveCollapsedKeys = new Set(
    Array.from(collapsedGroups).filter(key => groupKeysInView.has(key))
  )

  if (effectiveCollapsedKeys.size === 0) {
    const { picked, hasMore } = paginate()
    return { paginatedItems: picked, hasMore, collapsedGroupsMeta: [] }
  }

  const collapsedCounts = new Map<string, number>()
  for (const item of items) {
    const groupKey = getCollapseGroupKey(item, groupingMode)
    if (effectiveCollapsedKeys.has(groupKey)) {
      collapsedCounts.set(groupKey, (collapsedCounts.get(groupKey) || 0) + 1)
    }
  }

  const { picked, hasMore } = paginate(effectiveCollapsedKeys)
  const meta: CollapsedGroupMeta[] = Array.from(collapsedCounts.entries()).map(
    ([key, count]) => ({ key, count })
  )

  return { paginatedItems: picked, hasMore, collapsedGroupsMeta: meta }
}

interface FilterMatchOptions {
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  statusFilter?: Map<string, 'include' | 'exclude'>
  labelFilterMap?: Map<string, 'include' | 'exclude'>
  labelConfigs?: LabelConfig[]
}

export function sessionMatchesCurrentFilter(
  session: SessionMeta,
  currentFilter: SessionFilter | undefined,
  options: FilterMatchOptions = {}
): boolean {
  const { evaluateViews, statusFilter, labelFilterMap, labelConfigs } = options

  const passesStatusFilter = (): boolean => {
    if (!statusFilter || statusFilter.size === 0) return true
    const sessionState = (session.sessionStatus || 'todo') as string

    let hasIncludes = false
    let matchesInclude = false
    for (const [stateId, mode] of statusFilter) {
      if (mode === 'exclude' && sessionState === stateId) return false
      if (mode === 'include') {
        hasIncludes = true
        if (sessionState === stateId) matchesInclude = true
      }
    }
    return !hasIncludes || matchesInclude
  }

  const passesLabelFilter = (): boolean => {
    if (!labelFilterMap || labelFilterMap.size === 0) return true
    const sessionLabelIds = session.labels?.map(l => parseLabelEntry(l).id) || []

    let hasIncludes = false
    let matchesInclude = false
    for (const [labelId, mode] of labelFilterMap) {
      if (mode === 'exclude' && sessionLabelIds.includes(labelId)) return false
      if (mode === 'include') {
        hasIncludes = true
        if (sessionLabelIds.includes(labelId)) matchesInclude = true
      }
    }
    return !hasIncludes || matchesInclude
  }

  if (!passesStatusFilter() || !passesLabelFilter()) return false

  if (!currentFilter) return true

  switch (currentFilter.kind) {
    case 'allSessions':
      return session.isArchived !== true

    case 'flagged':
      return session.isFlagged === true && session.isArchived !== true

    case 'archived':
      return session.isArchived === true

    case 'state':
      return (session.sessionStatus || 'todo') === currentFilter.stateId && session.isArchived !== true

    case 'label': {
      if (session.isArchived === true) return false
      // Shared predicate (descendant-aware + optional project scope) — keep in
      // sync with AppShell's filtered set by construction, not by copy.
      return matchesLabelFilter(session, currentFilter, labelConfigs ?? [])
    }

    case 'view':
      if (session.isArchived === true) return false
      if (!evaluateViews) return true
      const matched = evaluateViews(session)
      if (currentFilter.viewId === '__all__') return matched.length > 0
      return matched.some(v => v.id === currentFilter.viewId)

    default:
      const _exhaustive: never = currentFilter
      return true
  }
}
