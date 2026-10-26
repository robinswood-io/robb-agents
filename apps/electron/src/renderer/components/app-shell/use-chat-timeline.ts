import * as React from "react";

import { useMemo, useCallback } from "react";

import type { Session } from "../../../shared/types";

import { buildUserInputTimeline, type Turn } from "@craft-agent/ui";

import { getTurnKey } from "./chat-display-contracts";

interface useChatTimelineInput {
  allTurns: Turn[]
  visibleTurnCount: number
  session: Session | null
  turnRefs: React.RefObject<Map<string, HTMLDivElement>>
  setVisibleTurnCount: React.Dispatch<React.SetStateAction<number>>
  followUpOpenNonceRef: React.RefObject<number>
  setOpenAnnotationRequest: React.Dispatch<React.SetStateAction<{ messageId: string; annotationId: string; mode: "view" | "edit"; anchorX?: number; anchorY?: number; nonce: number; } | null>>
  prevSessionIdForScrollRef: React.RefObject<string | null>
  isSearchActive: boolean
}

export function useChatTimeline({
  allTurns,
  visibleTurnCount,
  session,
  turnRefs,
  setVisibleTurnCount,
  followUpOpenNonceRef,
  setOpenAnnotationRequest,
  prevSessionIdForScrollRef,
  isSearchActive,
}: useChatTimelineInput) {
const startIndex = Math.max(0, allTurns.length - visibleTurnCount)

const turns = allTurns.slice(startIndex)

const timeline = useMemo(() => buildUserInputTimeline(allTurns, session?.userInputRequests ?? [], {
    pendingAtEnd: true,
  }), [allTurns, session?.userInputRequests])

const visibleTimeline = timeline.filter(entry => entry.turnIndex >= startIndex)

const hasMoreAbove = startIndex > 0

const assistantTurnIndexByMessageId = useMemo(() => {
    const map = new Map<string, number>()
    allTurns.forEach((turn, index) => {
      if (turn.type !== 'assistant') return
      const messageId = turn.response?.messageId
      if (messageId) map.set(messageId, index)
    })
    return map
  }, [allTurns])

const scrollToFollowUpTurn = useCallback((item: {
    messageId: string
    annotationId: string
  }) => {
    const targetTurnIndex = assistantTurnIndexByMessageId.get(item.messageId)
    if (targetTurnIndex == null) return

    const ensureVisibleCount = allTurns.length - targetTurnIndex

    const scrollToTurn = () => {
      const targetTurn = allTurns[targetTurnIndex]
      if (!targetTurn) return false

      const turnKey = getTurnKey(targetTurn)
      const turnContainer = turnRefs.current.get(turnKey)
      if (!turnContainer) return false

      turnContainer.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return true
    }

    if (ensureVisibleCount > visibleTurnCount) {
      setVisibleTurnCount(ensureVisibleCount)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scrollToTurn()) {
            setTimeout(() => {
              void scrollToTurn()
            }, 80)
          }
        })
      })
      return
    }

    if (!scrollToTurn()) {
      requestAnimationFrame(() => {
        void scrollToTurn()
      })
    }
  }, [assistantTurnIndexByMessageId, allTurns, visibleTurnCount, setVisibleTurnCount, turnRefs])

const handleFollowUpChipClick = useCallback((item: {
    messageId: string
    annotationId: string
  }, anchor?: { x: number; y: number }) => {
    const targetTurnIndex = assistantTurnIndexByMessageId.get(item.messageId)
    if (targetTurnIndex != null) {
      const ensureVisibleCount = allTurns.length - targetTurnIndex
      if (ensureVisibleCount > visibleTurnCount) {
        setVisibleTurnCount(ensureVisibleCount)
      }
    }

    followUpOpenNonceRef.current += 1
    setOpenAnnotationRequest({
      messageId: item.messageId,
      annotationId: item.annotationId,
      mode: 'view',
      anchorX: anchor?.x,
      anchorY: anchor?.y,
      nonce: followUpOpenNonceRef.current,
    })
  }, [assistantTurnIndexByMessageId, allTurns, visibleTurnCount, followUpOpenNonceRef, setOpenAnnotationRequest, setVisibleTurnCount])

const handleFollowUpIndexClick = useCallback((item: {
    messageId: string
    annotationId: string
  }) => {
    scrollToFollowUpTurn(item)
  }, [scrollToFollowUpTurn])

const isSessionSwitchForScroll = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id

const skipScrollToBottom = isSessionSwitchForScroll && isSearchActive
return { skipScrollToBottom, turns, hasMoreAbove, startIndex, visibleTimeline, handleFollowUpChipClick, handleFollowUpIndexClick }
}
