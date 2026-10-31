import { useEffectEvent } from 'react';
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useEffect,useMemo } from "react";
import "lucide-react";
import "motion/react";
import "sonner";
import "@/components/ui/scroll-area";
import "@/lib/utils";
import "@/lib/input-text";
import "@/components/markdown";
import "@/components/ui/collapsible";
import { projectConversation,type UserInputCardProps } from "@craft-agent/ui";
import { useFocusZone } from "@/hooks/keyboard";
import { useTheme } from "@/hooks/useTheme";
import "@craft-agent/ui";
import "@/components/chat/AuthRequestCard";
import "./input";
import "@/hooks/useTurnCardExpansion";
import { useNavigation } from "@/contexts/NavigationContext";
import { useAppShellContext,useActiveDescendantSessionIds,usePendingDescendantAuthRequests,useConversationPermissionRecoveries,useConversationAgentActivity } from "@/context/AppShellContext";
import "./PermissionRecoveryCard";
import "@/lib/navigate";
import "@/config/layout";
import "@/lib/file-changes";
import "./stop-conversation";
import "./branching";
import "./error-message-actions";
import "./AutonomyPanel";
import "@/utils/session";
import "./ChatDisplay.follow-ups";

import { useChatTimeline } from "./use-chat-timeline";































import { useChatActions } from "./use-chat-actions";

import { useChatScrollEvents } from "./use-chat-scroll-events";

import { useChatFollowUps } from "./use-chat-follow-ups";

import { useChatOverlays } from "./use-chat-overlays";

import { useChatSearchHighlights } from "./use-chat-search-highlights";

import { useChatSearchMatches } from "./use-chat-search-matches";

import { useChatScrollState } from "./use-chat-scroll-state";

import { ChatDisplayView } from "./chat-display-view";
import { type ChatDisplayProps,type ChatDisplayHandle } from "./chat-display-contracts";

export { type ChatDisplayHandle } from "./chat-display-contracts";





































/**
 * ChatDisplay - Main chat interface for a selected session
 *
 * Structure:
 * - Session Header: Avatar + workspace name
 * - Messages Area: Scrollable list of MessageBubble components
 * - Input Area: Textarea + Send button
 *
 * Shows empty state when no session is selected
 */
export const ChatDisplay = React.forwardRef<ChatDisplayHandle, ChatDisplayProps>(function ChatDisplay({
  session,
  onSendMessage,
  onOpenFile,
  onOpenUrl,
  currentModel,
  onModelChange,
  onConnectionChange,
  textareaRef: externalTextareaRef,
  disabled = false,
  pendingPermission,
  onRespondToPermission,
  pendingCredential,
  onRespondToCredential,
  onRespondToUserInput,
  // Thinking level
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  // Advanced options
  permissionMode = 'ask',
  onPermissionModeChange,
  enabledModes,
  // Input value preservation
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  // Skills (for @mentions)
  skills,
  // Labels (for #labels)
  labels,
  onLabelsChange,
  // States (for # menu and badge)
  sessionStatuses,
  onSessionStatusChange,
  workspaceId,
  // Working directory
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  // Lazy loading
  messagesLoading = false,
  messagesLoadError,
  messagesRetrying = false,
  onRetryMessagesLoad,
  // Tutorial
  disableSend = false,
  // Search highlighting
  searchQuery: externalSearchQuery,
  isSearchModeActive = false,
  onMatchInfoChange,
  // Compact mode (for EditPopover embedding and auto-compact / WebUI mobile)
  compactMode = false,
  enableCompactModelPicker = false,
  placeholder,
  // Connection unavailable
  connectionUnavailable = false,
}, ref) {
  const { t } = useTranslation()

  // Panel focus state (for multi-panel auto-scroll behavior)
  const appShellContext = useAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // Input is only disabled when explicitly disabled (e.g., agent needs activation)
  // User can type during streaming - submitting will stop the stream and send
  const {
    isFocusedPanelRef,
    textareaRef,
    setSendMessageKey,
    visibleTurnCount,
    setVisibleTurnCount,
    scrollViewportRef,
    isStickToBottomRef,
    setShowScrollToLatest,
    TURNS_PER_PAGE,
    prevSessionIdRef,
    messagesEndRef,
    skipSmoothScrollUntilRef,
    prevSessionIdForCommitScrollRef,
    prevLastMessageIdRef,
    prevMessageCountRef,
    isInputDisabled,
    followUpOpenNonceRef,
    setOpenAnnotationRequest,
    handleInitialTranscriptScroll,
    sendMessageKey,
    openAnnotationRequest,
    showScrollToLatest,
  } = useChatScrollState({
    disabled, isFocusedPanel, externalTextareaRef,
  })

  // Navigation for session branching
  const { navigate } = useNavigation()

  // Get isDark from useTheme hook for overlay theme
  // This accounts for scenic themes (like Haze) that force dark mode
  const { isDark } = useTheme()

  // Register as focus zone - when zone gains focus, focus the textarea
  // Guard with isFocusedPanelRef so only the focused panel responds in multi-panel layouts
  const { zoneRef, isFocused } = useFocusZone({
    zoneId: 'chat',
    enabled: isFocusedPanel,
    focusFirst: () => {
      if (isFocusedPanelRef.current) {
        textareaRef.current?.focus()
      }
    },
  })

  const activeDescendantIds = useActiveDescendantSessionIds(session?.id ?? '')
  const agentActivity = useConversationAgentActivity(session?.id ?? '')
  const pendingDescendantAuthRequests = usePendingDescendantAuthRequests(session?.id ?? '')
  const permissionRecoveries = useConversationPermissionRecoveries(session?.id ?? '')
  const isConversationProcessing = !!session?.isProcessing || activeDescendantIds.length > 0
  const hasPendingUserInput = session?.userInputRequests?.some(request => request.status === 'pending') ?? false
  const respondToUserInput = React.useCallback<NonNullable<UserInputCardProps['onRespond']>>(
    (originSessionId, response) => onRespondToUserInput
      ? onRespondToUserInput(originSessionId, response)
      : window.electronAPI.respondToUserInput(originSessionId, response), [onRespondToUserInput])

  // One user-facing projection powers rendering, search and pagination alike.
  // Keep the persisted execution transcript intact for runtime and diagnostics.
  const presentation = useMemo(() => projectConversation(session?.messages ?? [], {
    isProcessing: !!session?.isProcessing,
    ...(session?.id !== undefined ? { sessionId: session?.id } : {}),
    ...(session?.parentSessionId !== undefined ? { parentSessionId: session?.parentSessionId } : {}),
    hasActiveDescendants: activeDescendantIds.length > 0,
    ...(session?.activeObjective !== undefined ? { activeObjective: session?.activeObjective } : {}),
    ...(session?.pendingTurnRecovery !== undefined ? { pendingTurnRecovery: session?.pendingTurnRecovery } : {}),
    awaitingInput: !!pendingPermission || !!pendingCredential || pendingDescendantAuthRequests.length > 0 || permissionRecoveries.length > 0
      || hasPendingUserInput,
  }), [session?.id, session?.parentSessionId, session?.messages, session?.isProcessing, activeDescendantIds.length, session?.activeObjective, session?.pendingTurnRecovery, pendingPermission, pendingCredential, pendingDescendantAuthRequests.length, permissionRecoveries.length, hasPendingUserInput])
  const allTurns = presentation.turns

  // TurnCard expansion state — persisted to localStorage across session switches
  const {
    shouldScrollToMatchRef,
    validMatches,
    currentMatchIndex,
    turnRefs,
    searchQuery,
    isSearchActive,
    matchingTurnIds,
    setCurrentMatchIndex,
    prevSessionIdForScrollRef,
    expandedTurns,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  } = useChatSearchMatches({
    session, externalSearchQuery, isSearchModeActive,
    isFocused, isFocusedPanel, textareaRef,
    setSendMessageKey, allTurns, visibleTurnCount,
    setVisibleTurnCount,
  })

  // Scroll to current match turn
  // Only scrolls when shouldScrollToMatchRef is true (single match auto-scroll or nav button click)
  const scrollSearchMatch = useEffectEvent(() => {
    if (!shouldScrollToMatchRef.current) return

    if (validMatches.length > 0 && currentMatchIndex < validMatches.length) {
      const matchData = validMatches[currentMatchIndex]
      if (!matchData) return
      const { turnId, turnIndex } = matchData
      const totalTurns = totalTurnCountRef.current

      // Check if the match is outside the visible range
      const currentStartIndex = Math.max(0, totalTurns - visibleTurnCount)
      if (turnIndex < currentStartIndex) {
        const newVisibleCount = totalTurns - turnIndex + 5
        setVisibleTurnCount(newVisibleCount)
        return
      }

      // Scroll the turn into view
      const turnEl = turnRefs.current.get(turnId)
      if (turnEl) {
        const rect = turnEl.getBoundingClientRect()
        const buffer = 128
        const isVisible = rect.top >= buffer && rect.bottom <= window.innerHeight - buffer
        if (!isVisible) {
          turnEl.scrollIntoView({ behavior: 'instant', block: 'center' })
        }
      }
      shouldScrollToMatchRef.current = false
    }
  // totalTurnCountRef is stable and is declared below; the callback reads it after render.
  });
useEffect(() => scrollSearchMatch(), [validMatches, currentMatchIndex, session?.id, visibleTurnCount, setVisibleTurnCount, shouldScrollToMatchRef, turnRefs]);

  // ---------------------------------------------------------------------------
  // CSS Custom Highlight API — non-destructive text highlighting
  // Creates browser-native highlight ranges over matching text without
  // modifying the DOM tree. Safe with React re-renders and streaming.
  // Uses cross-node matching: concatenates text across node boundaries
  // to find matches that span multiple DOM nodes (e.g. Shiki-split tokens).
  // ---------------------------------------------------------------------------

  useChatSearchHighlights({
    searchQuery, isSearchActive, matchingTurnIds,
    turnRefs, session, visibleTurnCount,
    currentMatchIndex, validMatches, setCurrentMatchIndex,
    shouldScrollToMatchRef, ref, onMatchInfoChange,
  })

  // ============================================================================
  // Overlay State Management
  // ============================================================================

  // Overlay state - controls which overlay is shown (if any)
  const {
    setOverlayState,
    overlayState,
    useStackedActivityOverlay,
    handleCloseOverlay,
    overlayCards,
    activityOutputOverlayData,
    diffViewerSettings,
    handleDiffViewerSettingsChange,
  } = useChatOverlays({
    session,
  })

  // Ref to track total turn count for scroll handler
  const {
    totalTurnCountRef,
    lastMessageId,
    messageCount,
    lastMessageRole,
    pendingFollowUpAnnotations,
    followUpInputItems,
  } = useChatFollowUps({
    session,
  })

  // Track scroll position to toggle sticky-bottom behavior
  // - User scrolls up → unstick (stop auto-scrolling)
  // - User scrolls back to bottom → re-stick (resume auto-scrolling)
  // Also handles loading more turns when scrolling near top
  const {
    handleReturnToLatestMessage,
  } = useChatScrollEvents({
    scrollViewportRef, isStickToBottomRef, setShowScrollToLatest,
    setVisibleTurnCount, totalTurnCountRef, TURNS_PER_PAGE,
    prevSessionIdRef, session, isFocusedPanelRef,
    messagesEndRef, skipSmoothScrollUntilRef, prevSessionIdForCommitScrollRef,
    prevLastMessageIdRef, lastMessageId, prevMessageCountRef,
    messageCount, lastMessageRole,
  })

  // Handle message submission from InputContainer
  // Backend handles interruption and queueing if currently processing
  const {
    handleSaveAndSendFollowUp,
    handleAnimatedHeightChange,
    handleSubmit,
    handleStop,
    structuredInput,
    handleStructuredResponse,
  } = useChatActions({
    pendingFollowUpAnnotations, isStickToBottomRef, setShowScrollToLatest,
    onSendMessage, session, messagesEndRef,
    isInputDisabled, disableSend, connectionUnavailable,
    t, isConversationProcessing, onInputChange,
    inputValue, activeDescendantIds, scrollViewportRef,
    onRespondToPermission, onRespondToCredential, pendingPermission,
    pendingCredential,
  })

  // Keep ref in sync for scroll handler
  totalTurnCountRef.current = allTurns.length

  // Reverse pagination: only render last N turns for fast initial render
  const {
    skipScrollToBottom,
    turns,
    hasMoreAbove,
    startIndex,
    visibleTimeline,
    handleFollowUpChipClick,
    handleFollowUpIndexClick,
  } = useChatTimeline({
    allTurns, visibleTurnCount, session,
    turnRefs, setVisibleTurnCount, followUpOpenNonceRef,
    setOpenAnnotationRequest, prevSessionIdForScrollRef, isSearchActive,
  })


  return (
    <ChatDisplayView
      zoneRef={zoneRef} session={session} scrollViewportRef={scrollViewportRef}
      compactMode={compactMode} messagesLoading={messagesLoading} messagesLoadError={messagesLoadError}
      t={t} onRetryMessagesLoad={onRetryMessagesLoad} messagesRetrying={messagesRetrying}
      skipScrollToBottom={skipScrollToBottom} handleInitialTranscriptScroll={handleInitialTranscriptScroll} turns={turns}
      hasMoreAbove={hasMoreAbove} startIndex={startIndex} visibleTimeline={visibleTimeline}
      respondToUserInput={respondToUserInput} isSearchActive={isSearchActive} matchingTurnIds={matchingTurnIds}
      currentMatchIndex={currentMatchIndex} turnRefs={turnRefs} onOpenFile={onOpenFile}
      onOpenUrl={onOpenUrl} onRespondToCredential={onRespondToCredential} pendingFollowUpAnnotations={pendingFollowUpAnnotations}
      expandedTurns={expandedTurns} toggleTurn={toggleTurn} expandedActivityGroups={expandedActivityGroups}
      setExpandedActivityGroups={setExpandedActivityGroups} sendMessageKey={sendMessageKey} openAnnotationRequest={openAnnotationRequest}
      onSendMessage={onSendMessage} appShellContext={appShellContext} navigate={navigate}
      handleSaveAndSendFollowUp={handleSaveAndSendFollowUp} setOverlayState={setOverlayState} pendingDescendantAuthRequests={pendingDescendantAuthRequests}
      permissionRecoveries={permissionRecoveries} presentation={presentation} agentActivity={agentActivity}
      messagesEndRef={messagesEndRef} showScrollToLatest={showScrollToLatest} handleReturnToLatestMessage={handleReturnToLatestMessage}
      permissionMode={permissionMode} onPermissionModeChange={onPermissionModeChange} sessionFolderPath={sessionFolderPath}
      onInputChange={onInputChange} labels={labels} onLabelsChange={onLabelsChange}
      sessionStatuses={sessionStatuses} onSessionStatusChange={onSessionStatusChange} placeholder={placeholder}
      isInputDisabled={isInputDisabled} isConversationProcessing={isConversationProcessing} handleAnimatedHeightChange={handleAnimatedHeightChange}
      handleSubmit={handleSubmit} handleStop={handleStop} textareaRef={textareaRef}
      currentModel={currentModel} onModelChange={onModelChange} thinkingLevel={thinkingLevel}
      onThinkingLevelChange={onThinkingLevelChange} enabledModes={enabledModes} enableCompactModelPicker={enableCompactModelPicker}
      structuredInput={structuredInput} handleStructuredResponse={handleStructuredResponse} inputValue={inputValue}
      attachmentsValue={attachmentsValue} onAttachmentsChange={onAttachmentsChange} skills={skills}
      workspaceId={workspaceId} workingDirectory={workingDirectory} onWorkingDirectoryChange={onWorkingDirectoryChange}
      disableSend={disableSend} connectionUnavailable={connectionUnavailable} onConnectionChange={onConnectionChange}
      followUpInputItems={followUpInputItems} handleFollowUpChipClick={handleFollowUpChipClick} handleFollowUpIndexClick={handleFollowUpIndexClick}
      overlayState={overlayState} useStackedActivityOverlay={useStackedActivityOverlay} handleCloseOverlay={handleCloseOverlay}
      overlayCards={overlayCards} isDark={isDark} activityOutputOverlayData={activityOutputOverlayData}
      diffViewerSettings={diffViewerSettings} handleDiffViewerSettingsChange={handleDiffViewerSettingsChange}
    />
  )
})
