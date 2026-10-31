import * as React from 'react';
import { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import "i18next";
import { useTranslation } from 'react-i18next';
import "@craft-agent/core/utils";
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames';
import "motion/react";
import "lucide-react";
import "../../lib/utils";
import "../markdown";
import "../ui/LoadingIndicator";
import "../annotations/AnnotationIslandMenu";
import "../annotations/island-motion";
import "../tooltip";
import "@pierre/diffs";
import "../code-viewer";
import "./TurnCardActionsMenu";
import { computeLastChildSet, groupActivitiesByParent, deriveTurnPhase, shouldShowThinkingIndicator, type AssistantTurn } from './turn-utils';
import "./follow-up-helpers";
import "../annotations/follow-up-state";
import "../annotations/annotation-core";
import "../annotations/annotation-style-tokens";
import "../annotations/block-markers";
import "../annotations/annotation-host-config";
import "../annotations/selection-restore";
import "../annotations/interaction-policy";
import "../annotations/annotation-overlay-geometry";
import "../annotations/AnnotationOverlayLayer";
import "../annotations/interaction-selectors";
import "../annotations/use-annotation-interaction-controller";
import "../annotations/use-annotation-island-presentation";
import "../annotations/use-annotation-island-events";
import "../annotations/use-annotation-cancel-restore";
import "../overlay";
import "./AcceptPlanDropdown";
import "./CompactAcceptPlanDrawer";
import "../ui/StyledDropdown";
import "./use-response-buffer";
import "./use-response-selection-menu";
import "./use-response-text-selection";
import "./use-response-follow-ups";
import "./use-response-annotations";
import "./use-response-selection";
import "./turn-card-contracts";
import { isResponseBuffering } from "./turn-card-buffering";
import { getPreviewText } from "./turn-card-tool-display";
import "./turn-card-activity-row";
import "./turn-card-activity-group";
import "./turn-card-response-helpers";
import "./turn-card-todo";
export { SIZE_CONFIG, type ActivityStatus, type ActivityType, type AnnotationInteractionMode, type TodoStatus, type TodoItem, type ActivityItem, type ResponseContent, type OpenAnnotationRequest, type TurnCardProps } from "./turn-card-contracts";
export { ActivityStatusIcon } from "./turn-card-activity-icon";

import { TurnCardView } from "./turn-card-view";

export { ResponseCard } from "./ResponseCard";























































































import { type TurnCardProps } from "./turn-card-contracts";









export { type ResponseCardProps } from "./turn-card-response-helpers";

// ============================================================================
// Main Component
// ============================================================================

/**
 * TurnCard - Email-like display for one assistant turn
 *
 * Batches all activities (tools, thinking) into a collapsible section
 * with the final response displayed separately below.
 *
 * Memoized to prevent re-renders of completed turns during session switches.
 * Only complete, non-streaming turns are memoized - active turns always re-render.
 */
export const TurnCard = React.memo(function TurnCard({
  sessionId,
  turnId,
  activities,
  response,
  intent,
  isStreaming,
  isComplete,
  defaultExpanded = false,
  isExpanded: externalIsExpanded,
  onExpandedChange,
  expandedActivityGroups: externalExpandedActivityGroups,
  onExpandedActivityGroupsChange,
  onOpenFile,
  onOpenUrl,
  onPopOut,
  onOpenDetails,
  onOpenActivityDetails,
  onOpenMultiFileDiff,
  hasEditOrWriteActivities,
  todos,
  renderActionsMenu,
  onAcceptPlan,
  onAcceptPlanWithCompact,
  isLastResponse,
  sessionFolderPath,
  displayMode = 'detailed',
  presentation = 'default',
  animateResponse = false,
  compactMode = false,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onSaveAndSendFollowUp,
  hasActiveFollowUpAnnotations = false,
  openAnnotationRequest,
  annotationInteractionMode = 'interactive',
  onQuickAction,
}: TurnCardProps) {
  const { t } = useTranslation()
  // Derive the turn phase from props using the state machine.
  // This provides a single source of truth for lifecycle state,
  // replacing the old ad-hoc boolean combinations.
  const turnPhase = useMemo(() => {
    // Construct a minimal turn-like object for deriveTurnPhase
    const turnData: Pick<AssistantTurn, 'isComplete' | 'response' | 'activities'> = {
      isComplete,
      ...(response !== undefined ? { response: response } : {}),
      activities,
    }
    return deriveTurnPhase(turnData as AssistantTurn)
  }, [isComplete, response, activities])

  // Use local state if no controlled state provided
  const [localExpandedTurns, setLocalExpandedTurns] = useState<Set<string>>(() => defaultExpanded ? new Set([turnId]) : new Set())
  const isExpanded = externalIsExpanded ?? localExpandedTurns.has(turnId)

  // Track if user has toggled expansion (skip animation on initial mount)
  const hasUserToggled = useRef(false)

  // Ref for scrollable activities container (to scroll to bottom on expand)
  const activitiesContainerRef = useRef<HTMLDivElement>(null)

  // Track if component has mounted (enable fade-in for new activities after mount)
  const hasMounted = useRef(false)
  useEffect(() => {
    hasMounted.current = true
  }, [])

  const toggleExpanded = useCallback(() => {
    hasUserToggled.current = true
    const newExpanded = !isExpanded
    if (onExpandedChange) {
      onExpandedChange(newExpanded)
    } else {
      setLocalExpandedTurns(prev => {
        const next = new Set(prev)
        if (next.has(turnId)) {
          next.delete(turnId)
        } else {
          next.add(turnId)
        }
        return next
      })
    }
  }, [turnId, isExpanded, onExpandedChange])

  // Scroll to bottom of activities list when user manually expands
  // This shows the most recent step instead of the oldest
  useEffect(() => {
    if (isExpanded && hasUserToggled.current && activitiesContainerRef.current) {
      // Wait for expansion animation to complete (250ms) before scrolling
      const timer = setTimeout(() => {
        activitiesContainerRef.current?.scrollTo({
          top: activitiesContainerRef.current.scrollHeight,
          behavior: 'smooth'
        })
      }, 260)
      return () => clearTimeout(timer)
    }
  
    return undefined;
  }, [isExpanded])

  // Use local state for activity groups if no controlled state provided
  const [localExpandedActivityGroups, setLocalExpandedActivityGroups] = useState<Set<string>>(new Set())
  const expandedActivityGroups = externalExpandedActivityGroups ?? localExpandedActivityGroups
  const handleExpandedActivityGroupsChange = onExpandedActivityGroupsChange ?? setLocalExpandedActivityGroups

  // Check if response is in buffering state
  // No polling needed - parent updates trigger re-evaluation naturally
  const isBuffering = useMemo(
    () => isResponseBuffering(response),
    [response]
  )

  // Track quick action trigger to prevent double-dispatch
  const [quickActionTriggered, setQuickActionTriggered] = useState(false)
  useEffect(() => {
    setQuickActionTriggered(false)
  }, [turnId])

  const handleQuickAction = useCallback((actionText: string) => {
    if (quickActionTriggered || !onQuickAction) return
    setQuickActionTriggered(true)
    onQuickAction(actionText)
  }, [quickActionTriggered, onQuickAction])

  // Compute preview text with cross-fade animation
  const previewText = useMemo(
    () => getPreviewText(activities, intent, isStreaming, !!response, isComplete),
    [activities, intent, isStreaming, response, isComplete]
  )

  // Sort activities by timestamp for correct chronological order
  // This handles the live streaming case (turn-utils sorts on flush for completed turns)
  const allSortedActivities = useMemo(
    () => [...activities].sort((a, b) => a.timestamp - b.timestamp),
    [activities]
  )

  // Separate plan activities from regular activities
  // Plans are rendered as full ResponseCards, not in the collapsible activities section
  const planActivities = useMemo(
    () => allSortedActivities.filter(a => a.type === 'plan'),
    [allSortedActivities]
  )
  const sortedActivities = useMemo(
    () => allSortedActivities.filter(a => a.type !== 'plan'),
    [allSortedActivities]
  )

  // Check if we have any Task subagents - if so, use grouped view
  const hasTaskSubagents = useMemo(
    () => sortedActivities.some(a => isParentTaskTool(a.toolName ?? '')),
    [sortedActivities]
  )

  // Group activities by parent Task for better visualization
  // Only group if there are Task subagents, otherwise keep flat for simpler view
  const groupedActivities = useMemo(
    () => hasTaskSubagents ? groupActivitiesByParent(sortedActivities) : null,
    [sortedActivities, hasTaskSubagents]
  )

  // Pre-compute which activities are last children - O(n) instead of O(n²) per-render check
  // Only used for flat view (non-grouped)
  const lastChildSet = useMemo(
    () => !hasTaskSubagents ? computeLastChildSet(sortedActivities) : new Set<string>(),
    [sortedActivities, hasTaskSubagents]
  )

  // Don't render if nothing to show and turn is complete
  if (activities.length === 0 && !response && isComplete) {
    return null
  }

  // Don't render turns that were interrupted before any meaningful work happened.
  // Hide the turn if:
  // - All tool activities are errors (nothing completed successfully)
  // - Any intermediate activities have no meaningful content (empty or just whitespace)
  // - No response text to show
  // - No plan activities
  // The "Response interrupted" info banner alone is sufficient feedback.
  const hasNoMeaningfulWork = activities.length > 0
    && activities.every(a => {
      // Tool activities must be errors (interrupted/failed)
      if (a.type === 'tool') return a.status === 'error'
      // Intermediate activities must have no meaningful content
      if (a.type === 'intermediate') return !a.content?.trim()
      // Plan activities are meaningful work
      if (a.type === 'plan') return false
      // Other activity types - consider as no meaningful work
      return true
    })
    && !response
  if (hasNoMeaningfulWork) {
    return null
  }

  // Only count non-plan activities for the collapsible section
  const hasActivities = sortedActivities.length > 0

  // Determine if thinking indicator should show using the phase-based state machine.
  // This properly handles the "gap" state (awaiting) between tool completion and next action,
  // which was previously causing the turn card to "disappear".
  const isThinking = shouldShowThinkingIndicator(turnPhase, isBuffering)
  const isCodexPresentation = presentation === 'codex'
  const activityPreviewText = isCodexPresentation && displayMode === 'informative'
    ? (isComplete
        ? `Worked · ${activities.length} ${activities.length === 1 ? 'step' : 'steps'}`
        : 'Working…')
    : previewText

  return (
    <TurnCardView
      isCodexPresentation={isCodexPresentation} hasActivities={hasActivities} toggleExpanded={toggleExpanded}
      isExpanded={isExpanded} activities={activities} activityPreviewText={activityPreviewText}
      renderActionsMenu={renderActionsMenu} onOpenDetails={onOpenDetails} onOpenMultiFileDiff={onOpenMultiFileDiff}
      hasEditOrWriteActivities={hasEditOrWriteActivities} activitiesContainerRef={activitiesContainerRef} sortedActivities={sortedActivities}
      groupedActivities={groupedActivities} expandedActivityGroups={expandedActivityGroups} handleExpandedActivityGroupsChange={handleExpandedActivityGroupsChange}
      onOpenActivityDetails={onOpenActivityDetails} sessionFolderPath={sessionFolderPath} displayMode={displayMode}
      hasUserToggled={hasUserToggled} hasMounted={hasMounted} lastChildSet={lastChildSet}
      isThinking={isThinking} animateResponse={animateResponse} isBuffering={isBuffering}
      todos={todos} planActivities={planActivities} sessionId={sessionId}
      onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} onPopOut={onPopOut}
      presentation={presentation} onAddAnnotation={onAddAnnotation} onRemoveAnnotation={onRemoveAnnotation}
      onUpdateAnnotation={onUpdateAnnotation} onSaveAndSendFollowUp={onSaveAndSendFollowUp} onAcceptPlan={onAcceptPlan}
      onAcceptPlanWithCompact={onAcceptPlanWithCompact} isLastResponse={isLastResponse} compactMode={compactMode}
      onBranch={onBranch} sendMessageKey={sendMessageKey} hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
      openAnnotationRequest={openAnnotationRequest} annotationInteractionMode={annotationInteractionMode} response={response}
      isComplete={isComplete} isStreaming={isStreaming} onQuickAction={onQuickAction}
      quickActionTriggered={quickActionTriggered} handleQuickAction={handleQuickAction} t={t}
    />
  )
}, (prev, next) => {
  // Conservative memoization: only skip re-render for completed, non-streaming turns
  // Active turns (streaming or incomplete) always re-render to show updates

  // Always re-render streaming turns
  if (prev.isStreaming || next.isStreaming) return false

  // Always re-render incomplete turns
  if (!prev.isComplete || !next.isComplete) return false

  // Re-render if expansion state changed
  if (prev.isExpanded !== next.isExpanded) return false
  if (prev.expandedActivityGroups !== next.expandedActivityGroups) return false

  // Re-render if isLastResponse changed (for Accept Plan button visibility)
  if (prev.isLastResponse !== next.isLastResponse) return false

  // Re-render if quick action handler changed
  if (prev.onQuickAction !== next.onQuickAction) return false

  // Re-render if displayMode changed
  if (prev.displayMode !== next.displayMode) return false

  // Re-render if presentation changed
  if (prev.presentation !== next.presentation) return false

  // Re-render if compactMode changed (affects ResponseCard footer rendering)
  if (prev.compactMode !== next.compactMode) return false

  // Re-render if annotation interaction mode changed (interactive vs tooltip-only)
  if (prev.annotationInteractionMode !== next.annotationInteractionMode) return false

  // Re-render if activities changed (important for playground/testing scenarios)
  if (prev.activities !== next.activities) return false

  // Re-render when response object changes (e.g., annotation updates)
  if (prev.response !== next.response) return false

  // Re-render when external annotation-open requests change
  if (prev.openAnnotationRequest !== next.openAnnotationRequest) return false

  // Re-render when active follow-up annotation state changes (plan CTA label)
  if (prev.hasActiveFollowUpAnnotations !== next.hasActiveFollowUpAnnotations) return false

  // For complete, non-streaming turns: skip re-render only when both
  // session and turn identities match. Prevents stale local UI state from
  // leaking across session switches that may reuse turn IDs/components.
  return prev.sessionId === next.sessionId && prev.turnId === next.turnId
})
