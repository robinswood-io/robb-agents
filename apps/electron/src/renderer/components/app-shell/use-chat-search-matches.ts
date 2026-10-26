import * as React from "react";

import { useEffect, useState, useMemo, useCallback } from "react";

import type { Session } from "../../../shared/types";

import { type Turn } from "@craft-agent/ui";

import type { RichTextInputHandle } from "@/components/ui/rich-text-input";
import { useTurnCardExpansion } from "@/hooks/useTurnCardExpansion";

import { getTurnKey } from "./chat-display-contracts";

interface useChatSearchMatchesInput {
  session: Session | null
  externalSearchQuery: string | undefined
  isSearchModeActive: boolean
  isFocused: boolean
  isFocusedPanel: boolean
  textareaRef: React.RefObject<RichTextInputHandle | null>
  setSendMessageKey: React.Dispatch<React.SetStateAction<"enter" | "cmd-enter">>
  allTurns: Turn[]
  visibleTurnCount: number
  setVisibleTurnCount: React.Dispatch<React.SetStateAction<number>>
}

export function useChatSearchMatches({
  session,
  externalSearchQuery,
  isSearchModeActive,
  isFocused,
  isFocusedPanel,
  textareaRef,
  setSendMessageKey,
  allTurns,
  visibleTurnCount,
  setVisibleTurnCount,
}: useChatSearchMatchesInput) {
const {
    expandedTurns,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  } = useTurnCardExpansion(session?.id)

const [currentMatchIndex, setCurrentMatchIndex] = useState(0)

const turnRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())

React.useEffect(() => {
    const id = 'search-highlight-styles'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      ::highlight(search-passive) { background-color: rgb(253 224 71 / 0.3); color: inherit; }
      ::highlight(search-active) { background-color: rgb(253 224 71); color: rgb(0 0 0 / 0.9); }
    `
    document.head.appendChild(style)
  }, [])

const shouldScrollToMatchRef = React.useRef(false)

const prevSessionIdForScrollRef = React.useRef<string | null>(null)

const searchQuery = externalSearchQuery || ''

const isSearchActive = searchQuery.trim().length >= 2

useEffect(() => {
    if (session && !isSearchModeActive && isFocused && isFocusedPanel) {
      textareaRef.current?.focus()
    }
  }, [session?.id, isFocused, isSearchModeActive, isFocusedPanel, session, textareaRef])

useEffect(() => {
    let isMounted = true

    const loadSendMessageKey = async () => {
      if (!window.electronAPI) return

      try {
        const key = await window.electronAPI.getSendMessageKey()
        if (!isMounted) return
        setSendMessageKey(key ?? 'enter')
      } catch (error) {
        console.error('Failed to load send message key for follow-up view:', error)
      }
    }

    loadSendMessageKey()

    return () => {
      isMounted = false
    }
  }, [ setSendMessageKey])

useEffect(() => {
    const isSessionSwitch = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id
    prevSessionIdForScrollRef.current = session?.id ?? null

    // If session switched with search active, trigger scroll to first match
    if (isSessionSwitch && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }

    setCurrentMatchIndex(0)
  }, [session?.id, searchQuery, isSearchActive])

const countOccurrences = useCallback((text: string, query: string): number => {
    const lowerText = text.toLowerCase()
    const lowerQuery = query.toLowerCase()
    let count = 0
    let pos = 0
    while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
      count++
      pos += lowerQuery.length
    }
    return count
  }, [])

const matchingOccurrences = useMemo(() => {
    if (!searchQuery.trim() || !session?.messages) return []
    const startTime = performance.now()
    const query = searchQuery.toLowerCase()
    const turns = allTurns
    const matches: { matchId: string; turnId: string; turnIndex: number; matchIndexInTurn: number }[] = []

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
      const turn = turns[turnIndex]
      let textContent = ''
      let turnId = ''

      // Use getTurnKey() for consistent IDs between text scan and DOM refs
      turnId = getTurnKey(turn)

      if (turn.type === 'user') {
        const content = turn.message.content as unknown
        if (typeof content === 'string') {
          textContent = content
        } else if (Array.isArray(content)) {
          textContent = content
            .filter((block: { type?: string }) => block.type === 'text')
            .map((block: { text?: string }) => block.text || '')
            .join('\n')
        }
      } else if (turn.type === 'assistant') {
        if (turn.response?.text) {
          textContent = turn.response.text
        }
      } else if (turn.type === 'system') {
        textContent = turn.message.content
      }

      // Count occurrences in this turn's text content
      const occurrenceCount = countOccurrences(textContent, query)
      for (let i = 0; i < occurrenceCount; i++) {
        matches.push({
          matchId: `${turnId}-match-${i}`,
          turnId,
          turnIndex,
          matchIndexInTurn: i,
        })
      }
    }
    return matches
  }, [searchQuery, allTurns, countOccurrences, session?.messages])

useEffect(() => {
    if (!isSearchActive || matchingOccurrences.length === 0) return

    // Find the earliest matching turn index (reduce to avoid RangeError on large arrays)
    const earliestMatchTurnIndex = matchingOccurrences.reduce(
      (min, m) => m.turnIndex < min ? m.turnIndex : min,
      matchingOccurrences[0]!.turnIndex
    )
    const totalTurns = allTurns.length

    // Calculate how many turns we need to show to include all matches
    // totalTurns - visibleTurnCount = startIndex, so we need visibleTurnCount = totalTurns - earliestMatchTurnIndex + buffer
    const requiredVisibleCount = totalTurns - earliestMatchTurnIndex + 5 // +5 buffer for context

    if (requiredVisibleCount > visibleTurnCount) {
      setVisibleTurnCount(requiredVisibleCount)
    }
  }, [isSearchActive, matchingOccurrences, allTurns, visibleTurnCount, setVisibleTurnCount])

const matchingTurnIds = useMemo(() => {
    const uniqueTurnIds = new Set(matchingOccurrences.map(m => m.turnId))
    return Array.from(uniqueTurnIds)
  }, [matchingOccurrences])

const validMatches = matchingOccurrences

useEffect(() => {
    if (validMatches.length === 1 && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }
  }, [validMatches.length, isSearchActive])
return { shouldScrollToMatchRef, validMatches, currentMatchIndex, turnRefs, searchQuery, isSearchActive, matchingTurnIds, setCurrentMatchIndex, prevSessionIdForScrollRef, expandedTurns, toggleTurn, expandedActivityGroups, setExpandedActivityGroups }
}
