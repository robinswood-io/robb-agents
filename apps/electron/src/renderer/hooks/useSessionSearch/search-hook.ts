import { omitUndefined } from '@craft-agent/shared/utils/json';
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { searchLog } from "@/lib/logger";
import { fuzzyScore } from "@craft-agent/shared/search";
import { getSessionTitle } from "@/utils/session";
import type { SessionMeta } from "@/atoms/sessions";
import type { ContentSearchResult, UseSessionSearchOptions, UseSessionSearchResult } from './matching.ts';
import { BATCH_SIZE, INITIAL_DISPLAY_LIMIT, MAX_SEARCH_RESULTS, computeCollapsedPagination, groupSessionsByDate, sessionMatchesCurrentFilter } from './matching.ts';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSessionSearch({
  items,
  searchActive,
  searchQuery,
  workspaceId,
  currentFilter,
  evaluateViews,
  statusFilter,
  labelFilterMap,
  labelConfigs,
  collapsedGroups,
  groupingMode,
  scrollViewportRef,
}: UseSessionSearchOptions): UseSessionSearchResult {

  const [contentSearchResults, setContentSearchResults] = useState<Map<string, ContentSearchResult>>(new Map())
  const [isSearchingContent, setIsSearchingContent] = useState(false)
  const [isSearchUnavailable, setIsSearchUnavailable] = useState(false)
  const [displayLimit, setDisplayLimit] = useState(INITIAL_DISPLAY_LIMIT)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Search mode is active when search is open AND query has 2+ characters
  const isSearchMode = searchActive && searchQuery.length >= 2
  const highlightQuery = isSearchMode ? searchQuery : undefined

  // --- Content search (ripgrep IPC with debounce + cancellation) ---

  useEffect(() => {
    if (!workspaceId || !isSearchMode) {
      setContentSearchResults(new Map())
      return
    }

    const searchId = Date.now().toString(36)
    searchLog.info('query:change', { searchId, query: searchQuery })

    let cancelled = false
    setIsSearchingContent(true)
    setIsSearchUnavailable(false)

    const timer = setTimeout(async () => {
      try {
        searchLog.info('ipc:call', { searchId })
        const ipcStart = performance.now()

        const results = await window.electronAPI.searchSessionContent(workspaceId, searchQuery, searchId)

        if (cancelled) return

        searchLog.info('ipc:received', {
          searchId,
          durationMs: Math.round(performance.now() - ipcStart),
          resultCount: results.length,
        })

        const resultMap = new Map<string, ContentSearchResult>()
        for (const result of results) {
          resultMap.set(result.sessionId, {
            matchCount: result.matchCount,
            snippet: result.matches[0]?.snippet || '',
          })
        }
        setContentSearchResults(resultMap)

        requestAnimationFrame(() => {
          searchLog.info('render:complete', { searchId, sessionsDisplayed: resultMap.size })
        })
      } catch (error) {
        if (cancelled) return
        // Detect search unavailable (ripgrep not found) vs transient errors
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('SearchUnavailableError') || message.includes('ripgrep')) {
          console.warn('[useSessionSearch] Search unavailable:', message)
          setIsSearchUnavailable(true)
        } else {
          console.error('[useSessionSearch] Content search error:', error)
        }
        setContentSearchResults(new Map())
      } finally {
        if (!cancelled) {
          setIsSearchingContent(false)
        }
      }
    }, 100)

    return () => {
      cancelled = true
      clearTimeout(timer)
      setIsSearchingContent(false)
    }
  }, [workspaceId, isSearchMode, searchQuery])

  // --- Focus search input when search activates ---

  useEffect(() => {
    if (searchActive) {
      searchInputRef.current?.focus()
    }
  }, [searchActive])

  // --- Data pipeline ---

  // Filter out hidden sessions before any processing
  const visibleItems = useMemo(() => items.filter(item => !item.hidden), [items])

  // Sort by most recent activity first
  const sortedItems = useMemo(() =>
    [...visibleItems].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)),
    [visibleItems]
  )

  // Filter items by search query or current filter
  const searchFilteredItems = useMemo(() => {
    if (!isSearchMode) {
      return sortedItems.filter(item =>
        sessionMatchesCurrentFilter(item, currentFilter, omitUndefined({ evaluateViews, statusFilter, labelFilterMap, labelConfigs }))
      )
    }

    return sortedItems
      .filter(item => contentSearchResults.has(item.id))
      .sort((a, b) => {
        const aScore = fuzzyScore(getSessionTitle(a), searchQuery)
        const bScore = fuzzyScore(getSessionTitle(b), searchQuery)

        if (aScore > 0 && bScore === 0) return -1
        if (aScore === 0 && bScore > 0) return 1
        if (aScore !== bScore) return bScore - aScore

        const countA = contentSearchResults.get(a.id)?.matchCount || 0
        const countB = contentSearchResults.get(b.id)?.matchCount || 0
        return countB - countA
      })
  }, [sortedItems, isSearchMode, searchQuery, contentSearchResults, currentFilter, evaluateViews, statusFilter, labelFilterMap, labelConfigs])

  // Split search results: matching current filter vs others
  const { matchingFilterItems, otherResultItems, exceededSearchLimit } = useMemo(() => {
    const hasActiveFilters =
      (currentFilter && currentFilter.kind !== 'allSessions') ||
      (statusFilter && statusFilter.size > 0) ||
      (labelFilterMap && labelFilterMap.size > 0)

    if (searchQuery.trim() && searchFilteredItems.length > 0) {
      searchLog.info('search:grouping', {
        searchQuery,
        currentFilterKind: currentFilter?.kind,
        currentFilterStateId: currentFilter?.kind === 'state' ? currentFilter.stateId : undefined,
        hasActiveFilters,
        statusFilterSize: statusFilter?.size ?? 0,
        labelFilterSize: labelFilterMap?.size ?? 0,
        itemCount: searchFilteredItems.length,
      })
    }

    const totalCount = searchFilteredItems.length
    const exceeded = totalCount > MAX_SEARCH_RESULTS

    if (!isSearchMode || !hasActiveFilters) {
      const limitedItems = searchFilteredItems.slice(0, MAX_SEARCH_RESULTS)
      return { matchingFilterItems: limitedItems, otherResultItems: [] as SessionMeta[], exceededSearchLimit: exceeded }
    }

    const matching: SessionMeta[] = []
    const others: SessionMeta[] = []

    for (const item of searchFilteredItems) {
      if (matching.length + others.length >= MAX_SEARCH_RESULTS) break

      const matches = sessionMatchesCurrentFilter(item, currentFilter, omitUndefined({ evaluateViews, statusFilter, labelFilterMap, labelConfigs }))
      if (matches) {
        matching.push(item)
      } else {
        others.push(item)
      }
    }

    if (searchFilteredItems.length > 0) {
      searchLog.info('search:grouping:result', {
        matchingCount: matching.length,
        othersCount: others.length,
        exceeded,
      })
    }

    return { matchingFilterItems: matching, otherResultItems: others, exceededSearchLimit: exceeded }
  }, [searchFilteredItems, currentFilter, evaluateViews, isSearchMode, statusFilter, labelFilterMap, labelConfigs, searchQuery])

  // --- Pagination ---

  useEffect(() => {
    setDisplayLimit(INITIAL_DISPLAY_LIMIT)
  }, [searchQuery])

  // Collapse-aware pagination: collapsed items are excluded entirely from
  // paginatedItems (and therefore flatItems / keyboard nav). Their counts are
  // returned as collapsedGroupsMeta so the renderer can show header-only groups.
  const { paginatedItems, hasMore, collapsedGroupsMeta } = useMemo(() => {
    return computeCollapsedPagination(searchFilteredItems, displayLimit, collapsedGroups, groupingMode)
  }, [searchFilteredItems, displayLimit, collapsedGroups, groupingMode])

  const loadMore = useCallback(() => {
    setDisplayLimit(prev => Math.min(prev + BATCH_SIZE, searchFilteredItems.length))
  }, [searchFilteredItems.length])

  // Scroll-based pagination: listen for scroll on the actual ScrollArea viewport
  // (IntersectionObserver with root=null doesn't detect scroll inside Radix ScrollArea)
  useEffect(() => {
    if (!hasMore) return
    const viewport = scrollViewportRef?.current
    if (!viewport) return

    const check = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      if (scrollHeight - scrollTop - clientHeight < 200) {
        loadMore()
      }
    }

    check() // fill viewport on mount / after group expand
    viewport.addEventListener('scroll', check, { passive: true })
    return () => viewport.removeEventListener('scroll', check)
  }, [hasMore, loadMore, displayLimit, scrollViewportRef])

  // --- Derived render data ---

  const dateGroups = useMemo(() => groupSessionsByDate(paginatedItems), [paginatedItems])

  const flatItems = useMemo(() => {
    if (isSearchMode) {
      return [...matchingFilterItems, ...otherResultItems]
    }
    return dateGroups.flatMap(group => group.sessions)
  }, [isSearchMode, matchingFilterItems, otherResultItems, dateGroups])

  const sessionIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    flatItems.forEach((item, index) => map.set(item.id, index))
    return map
  }, [flatItems])

  return {
    isSearchMode,
    highlightQuery,
    isSearchingContent,
    isSearchUnavailable,
    contentSearchResults,
    matchingFilterItems,
    otherResultItems,
    exceededSearchLimit,
    flatItems,
    dateGroups,
    sessionIndexMap,
    hasMore,
    collapsedGroupsMeta,
    searchInputRef,
  }
}
