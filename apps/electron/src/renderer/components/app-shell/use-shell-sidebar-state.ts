import * as React from "react";

import { useCallback } from "react";

import { type ChatGroupingMode } from "./SessionList";

import type { ChatDisplayHandle } from "./ChatDisplay";

import { type ViewFiltersMap } from "./view-filters";

import { useAction } from "@/actions";

import * as storage from "@/lib/local-storage";

import { isSessionsNavigation, type NavigationState } from "@/contexts/NavigationContext";

interface useShellSidebarStateInput {
  sessionFilter: import("@/contexts/NavigationContext").SessionFilter | null
  viewFiltersMap: ViewFiltersMap
  sessionFilterKey: string | null
  setViewFiltersMap: React.Dispatch<React.SetStateAction<ViewFiltersMap>>
  navState: NavigationState
}

export function useShellSidebarState({
  sessionFilter,
  viewFiltersMap,
  sessionFilterKey,
  setViewFiltersMap,
  navState,
}: useShellSidebarStateInput) {
const [searchActive, setSearchActive] = React.useState(false)

const [searchQuery, setSearchQuery] = React.useState('')

const isStateSubView = sessionFilter?.kind === 'state'

const chatGroupingMode: ChatGroupingMode = isStateSubView
    ? 'date'
    : (viewFiltersMap[sessionFilterKey ?? '']?.groupingMode ?? 'date')

const setChatGroupingMode = useCallback((mode: ChatGroupingMode) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const existing = prev[sessionFilterKey] ?? { statuses: {}, labels: {} }
      return {
        ...prev,
        [sessionFilterKey]: { ...existing, groupingMode: mode }
      }
    })
  }, [sessionFilterKey, setViewFiltersMap])

const chatDisplayRef = React.useRef<ChatDisplayHandle>(null)

const [chatMatchInfo, setChatMatchInfo] = React.useState<{ sessionId: string | null; count: number; index: number; isHighlighting?: boolean }>({ sessionId: null, count: 0, index: 0 })

const handleChatMatchInfoChange = React.useCallback((info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => {
    setChatMatchInfo(prev => {
      if (prev.sessionId === info.sessionId && prev.count === info.count && prev.index === info.index && prev.isHighlighting === info.isHighlighting) {
        return prev
      }
      return info
    })
  }, [])

React.useEffect(() => {
    if (!searchActive || !searchQuery) {
      setChatMatchInfo({ sessionId: null, count: 0, index: 0 })
    }
  }, [searchActive, searchQuery])

const [filterDropdownQuery, setFilterDropdownQuery] = React.useState('')

const [filterAltHeld, setFilterAltHeld] = React.useState(false)

const navFilterKey = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      const filter = navState.filter
      return `chats:${filter.kind}:${filter.kind === 'state' ? filter.stateId : ''}`
    }
    return navState.navigator
  }, [navState])

React.useEffect(() => {
    setSearchActive(false)
    setSearchQuery('')
  }, [navFilterKey])

useAction('app.search', () => setSearchActive(true))

const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => {
    const saved = storage.get<string[]>(storage.KEYS.expandedFolders, [])
    return new Set(saved)
  })

const [focusedSidebarItemId, setFocusedSidebarItemId] = React.useState<string | null>(null)

const sidebarItemRefs = React.useRef<Map<string, HTMLElement>>(new Map())

const [collapsedItems, setCollapsedItems] = React.useState<Set<string>>(() => {
    const saved = storage.get<string[] | null>(storage.KEYS.collapsedSidebarItems, null)
    if (saved !== null) return new Set(saved)
    return new Set(['nav:labels'])
  })

const isExpanded = React.useCallback((id: string) => !collapsedItems.has(id), [collapsedItems])

const toggleExpanded = React.useCallback((id: string) => {
    setCollapsedItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
return { setSearchActive, setSearchQuery, setFilterDropdownQuery, setFocusedSidebarItemId, setExpandedFolders, setCollapsedItems, filterDropdownQuery, chatDisplayRef, searchActive, chatMatchInfo, expandedFolders, collapsedItems, focusedSidebarItemId, sidebarItemRefs, isExpanded, toggleExpanded, searchQuery, handleChatMatchInfoChange, chatGroupingMode, setChatGroupingMode, isStateSubView, setFilterAltHeld, filterAltHeld }
}
