import * as React from "react";

import type { Session } from "../../../shared/types";

interface useChatScrollEventsInput {
  scrollViewportRef: React.RefObject<HTMLDivElement | null>
  isStickToBottomRef: React.RefObject<boolean>
  setShowScrollToLatest: React.Dispatch<React.SetStateAction<boolean>>
  setVisibleTurnCount: React.Dispatch<React.SetStateAction<number>>
  totalTurnCountRef: React.RefObject<number>
  TURNS_PER_PAGE: number
  prevSessionIdRef: React.RefObject<string | null>
  session: Session | null
  isFocusedPanelRef: React.RefObject<boolean>
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  skipSmoothScrollUntilRef: React.RefObject<number>
  prevSessionIdForCommitScrollRef: React.RefObject<string | null>
  prevLastMessageIdRef: React.RefObject<string | null>
  lastMessageId: string | undefined
  prevMessageCountRef: React.RefObject<number>
  messageCount: number
  lastMessageRole: import("@craft-agent/core").MessageRole | undefined
}

export function useChatScrollEvents({
  scrollViewportRef,
  isStickToBottomRef,
  setShowScrollToLatest,
  setVisibleTurnCount,
  totalTurnCountRef,
  TURNS_PER_PAGE,
  prevSessionIdRef,
  session,
  isFocusedPanelRef,
  messagesEndRef,
  skipSmoothScrollUntilRef,
  prevSessionIdForCommitScrollRef,
  prevLastMessageIdRef,
  lastMessageId,
  prevMessageCountRef,
  messageCount,
  lastMessageRole,
}: useChatScrollEventsInput) {
const handleScroll = React.useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    const { scrollTop, scrollHeight, clientHeight } = viewport
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    // 20px threshold for "at bottom" detection
    const isAtBottom = distanceFromBottom < 20
    isStickToBottomRef.current = isAtBottom
    setShowScrollToLatest(!isAtBottom)

    // Load more turns when scrolling near top (within 100px)
    if (scrollTop < 100) {
      setVisibleTurnCount(prev => {
        // Check if there are more turns to load
        const currentStartIndex = Math.max(0, totalTurnCountRef.current - prev)
        if (currentStartIndex <= 0) return prev // Already showing all

        // Remember scroll height before adding more items
        const prevScrollHeight = viewport.scrollHeight

        // Schedule scroll position adjustment after render
        requestAnimationFrame(() => {
          const newScrollHeight = viewport.scrollHeight
          viewport.scrollTop = newScrollHeight - prevScrollHeight + scrollTop
        })

        return prev + TURNS_PER_PAGE
      })
    }
  }, [ TURNS_PER_PAGE, isStickToBottomRef, scrollViewportRef, setShowScrollToLatest, setVisibleTurnCount, totalTurnCountRef])

const handleReturnToLatestMessage = React.useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    // Rejoining the live edge intentionally re-enables the existing streaming
    // and input-height auto-scroll behavior.
    isStickToBottomRef.current = true
    setShowScrollToLatest(false)
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
  }, [ isStickToBottomRef, scrollViewportRef, setShowScrollToLatest])

React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [handleScroll, scrollViewportRef])

React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const isSessionSwitch = prevSessionIdRef.current !== session?.id
    prevSessionIdRef.current = session?.id ?? null

    // On session switch: reset UI state (scroll handled by ScrollOnMount)
    if (isSessionSwitch) {
      isStickToBottomRef.current = true
      setShowScrollToLatest(false)
      setVisibleTurnCount(TURNS_PER_PAGE)
    }

    // Debounced scroll for streaming - waits for layout to settle
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const resizeObserver = new ResizeObserver(() => {
      // Unfocused panels: always scroll to bottom instantly (user isn't reading them)
      if (!isFocusedPanelRef.current) {
        isStickToBottomRef.current = true
        setShowScrollToLatest(false)
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
        return
      }

      // Focused panel: respect sticky-bottom preference
      if (!isStickToBottomRef.current) return

      // Clear pending scroll and wait for layout to settle
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        // The user may have scrolled up while this debounced callback was pending.
        if (!isStickToBottomRef.current) return

        // Layout commonly changes again just after the initial session scroll
        // (input hydration, rich blocks, mobile safe areas). Keep the viewport
        // pinned instantly during that settling window instead of dropping the
        // only follow-up scroll.
        if (Date.now() < skipSmoothScrollUntilRef.current) {
          viewport.scrollTop = viewport.scrollHeight
          return
        }
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 200)
    })

    // Observe both the viewport (mobile keyboard/browser chrome/safe-area
    // changes) and its content (streaming and late-rendered rich blocks).
    resizeObserver.observe(viewport)
    const content = viewport.firstElementChild
    if (content) {
      resizeObserver.observe(content)
    }

    return () => {
      resizeObserver.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [session?.id, TURNS_PER_PAGE, isFocusedPanelRef, isStickToBottomRef, messagesEndRef, prevSessionIdRef, scrollViewportRef, setShowScrollToLatest, setVisibleTurnCount, skipSmoothScrollUntilRef])

React.useEffect(() => {
    const currentSessionId = session?.id ?? null

    // Reset baseline on session switch; defer to ScrollOnMount/session-switch logic.
    if (prevSessionIdForCommitScrollRef.current !== currentSessionId) {
      prevSessionIdForCommitScrollRef.current = currentSessionId
      prevLastMessageIdRef.current = lastMessageId ?? null
      prevMessageCountRef.current = messageCount
      return
    }

    const previousCount = prevMessageCountRef.current
    const previousLastId = prevLastMessageIdRef.current
    const messageActuallyChanged = !!lastMessageId && lastMessageId !== previousLastId
    const countIncreased = messageCount > previousCount

    // Update baselines before early returns to keep refs consistent.
    prevLastMessageIdRef.current = lastMessageId ?? null
    prevMessageCountRef.current = messageCount

    if (!messageActuallyChanged || !countIncreased) return
    if (lastMessageRole !== 'user') return

    // Sending a message should always re-stick to bottom.
    isStickToBottomRef.current = true
    setShowScrollToLatest(false)

    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: isFocusedPanelRef.current ? 'smooth' : 'instant',
      })
    })
  }, [session?.id, messageCount, lastMessageId, lastMessageRole, isFocusedPanelRef, isStickToBottomRef, messagesEndRef, prevLastMessageIdRef, prevMessageCountRef, prevSessionIdForCommitScrollRef, setShowScrollToLatest])
return { handleReturnToLatestMessage }
}
