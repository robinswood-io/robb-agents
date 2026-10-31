/**
 * turn-utils.ts
 *
 * Utilities for grouping messages by turn for TurnCard rendering.
 * Converts the flat Message[] array into grouped turns for email-like display.
 */
import type { Message } from "@craft-agent/core";
import type { ActivityItem, ActivityStatus, ActivityType } from "../TurnCard";
import { calculateActivityDepths, extractTodosFromActivities, messageToActivity } from './activity-conversion.ts';
import type { AssistantTurn, Turn } from './turn-types.ts';

// ============================================================================
// Main Grouping Function
// ============================================================================

export interface GroupTurnsOptions {
  /**
   * Whether the session is still actively processing.
   *
   * When `false`, the open turn (if any has activities) is marked complete
   * before the final flush, so the existing "promote last intermediate text
   * to response" branch fires and the chat doesn't sit on "Thinking…" forever
   * when a turn ends on a tool call with no non-intermediate `text_complete`.
   *
   * Mirrors the messaging-gateway/renderer.ts lastAssistantText fallback.
   */
  isSessionProcessing?: boolean | undefined
}

/**
 * Groups messages into turns for TurnCard rendering
 *
 * Rules:
 * - User messages flush and start fresh context
 * - Tool messages + intermediate assistant messages belong to current turn
 * - Final assistant message (non-streaming, non-intermediate) flushes the turn
 * - Error/status/info messages are standalone system turns
 *
 * Note: We intentionally ignore turnId for grouping. The SDK generates a new
 * turnId for each API message, but from a user perspective, all work between
 * a user message and the final response should be ONE turn. We use isIntermediate
 * as the signal: isIntermediate=true means more work coming, isIntermediate=false
 * means final response.
 */
export function groupMessagesByTurn(messages: Message[], options: GroupTurnsOptions = {}): Turn[] {
  // Drop hidden messages before grouping. These are system-generated nudges that
  // must reach the model (they drive a turn) but must never render as a bubble —
  // e.g. the WS2 background-task-completion nudge that wakes an idle session. The
  // assistant response they trigger has its own turnId and still renders normally.
  const visibleMessages = messages.filter(m => !m.hidden)
  // Sort by timestamp for correct chronological order
  // This ensures correct turn grouping even if messages are added out of order during streaming
  const sortedMessages = [...visibleMessages].sort((a, b) => a.timestamp - b.timestamp)

  const turns: Turn[] = []
  let currentTurn: AssistantTurn | null = null

  const flushCurrentTurn = (interrupted = false) => {
    if (currentTurn) {
      // Sort activities by timestamp to ensure correct chronological order
      // This is necessary because buffering can delay when messages are added
      // to the array, causing commentary to appear after tools that started later
      currentTurn.activities.sort((a, b) => a.timestamp - b.timestamp)

      // Calculate nesting depths for parent-child tool relationships
      calculateActivityDepths(currentTurn.activities)

      // Extract todos from TodoWrite tool results
      currentTurn.todos = extractTodosFromActivities(currentTurn.activities)

      // If interrupted, mark any running activities as error and todos as interrupted
      if (interrupted) {
        currentTurn.activities = currentTurn.activities.map(activity =>
          activity.status === 'running'
            ? { ...activity, status: 'error' as ActivityStatus, error: 'Interrupted' }
            : activity
        )
        if (currentTurn.todos) {
          currentTurn.todos = currentTurn.todos.map(todo =>
            todo.status === 'in_progress'
              ? { ...todo, status: 'interrupted' as const }
              : todo
          )
        }
        currentTurn.isStreaming = false
        currentTurn.isComplete = true
      }

      // If no response but we have intermediate text, promote the last one to response
      // Don't do this for interrupted turns - respect user interruptions
      // Don't do this for turns with plans - the plan is the final output
      // Only promote when turn is complete (processing indicator hidden)
      const hasPlan = currentTurn.activities.some(a => a.type === 'plan')
      if (!interrupted && !hasPlan && !currentTurn.response && currentTurn.isComplete && currentTurn.activities.length > 0) {
        // Find the last intermediate text activity (reverse to get most recent)
        const lastTextActivity = [...currentTurn.activities]
          .reverse()
          .find(a => a.type === 'intermediate' && a.content)

        if (lastTextActivity?.content) {
          currentTurn.response = {
            text: lastTextActivity.content,
            isStreaming: false,
            messageId: lastTextActivity.id,
          }
        }
      }

      turns.push(currentTurn)
      currentTurn = null
    }
  }

  for (const message of sortedMessages) {
    // Auth-request messages are standalone turns (credential input, OAuth flows)
    if (message.role === 'auth-request') {
      // If there's a current turn, it's complete (something follows it)
      if (currentTurn) currentTurn.isComplete = true
      flushCurrentTurn()
      turns.push({
        type: 'auth-request',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // User messages are their own turn
    if (message.role === 'user') {
      // If there's a current turn, it's complete (something follows it)
      if (currentTurn) currentTurn.isComplete = true
      flushCurrentTurn()
      turns.push({
        type: 'user',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // Status messages become activities within the current turn (don't break turn)
    if (message.role === 'status') {
      if (!currentTurn) {
        // Start a new turn for this status
        currentTurn = {
          type: 'assistant',
          turnId: message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: true,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      const statusActivity: ActivityItem = {
        id: message.id,
        type: 'status',
        status: 'running',
        content: message.content,
        timestamp: message.timestamp,
        ...(message.statusType !== undefined ? { statusType: message.statusType } : {}),
        depth: 0,
      }
      currentTurn.activities.push(statusActivity)
      continue
    }

    // Info messages with compaction_complete update the matching status activity
    if (message.role === 'info' && message.statusType === 'compaction_complete') {
      if (currentTurn) {
        const statusIdx = currentTurn.activities.findIndex(
          a => a.type === 'status' && a.statusType === 'compacting'
        )
        const existingActivity = currentTurn.activities[statusIdx]
        if (statusIdx !== -1 && existingActivity) {
          currentTurn.activities[statusIdx] = {
            ...existingActivity,
            status: 'completed',
            content: message.content,
          }
        }
      }
      continue  // Don't create a separate system turn
    }

    // Error/info/warning messages are standalone
    if (message.role === 'error' || message.role === 'info' || message.role === 'warning') {
      // Flush current turn first (mark as interrupted if info message)
      const isInterruption = message.role === 'info'
      // For error/warning (not info), the previous turn is complete
      if (currentTurn && !isInterruption) currentTurn.isComplete = true
      flushCurrentTurn(isInterruption)
      turns.push({
        type: 'system',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // Plan messages are added as activities to be time-sorted with tool calls
    // This ensures SubmitPlan tool appears before the plan content chronologically
    if (message.role === 'plan') {
      if (!currentTurn) {
        // Edge case: plan without preceding activities
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: false,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      // Add plan as an activity so it gets time-sorted with other activities
      currentTurn.activities.push({
        id: message.id,
        type: 'plan' as ActivityType,
        status: 'completed',
        content: message.content,
        messageId: message.id,
        ...(message.annotations !== undefined ? { annotations: message.annotations } : {}),
        displayName: 'Plan',
        timestamp: message.timestamp,
      })
      currentTurn.isStreaming = false
      currentTurn.isComplete = true
      flushCurrentTurn()
      continue
    }

    // Tool messages belong to current assistant turn
    if (message.role === 'tool') {
      // Tool is complete if toolStatus is 'completed' OR toolResult exists (but NOT if backgrounded)
      const isToolComplete = (message.toolStatus === 'completed' || message.toolResult !== undefined) && message.toolStatus !== 'backgrounded'
      if (!currentTurn) {
        // Start a new turn
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: message.toolIntent,
          isStreaming: !isToolComplete,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      // Always add to current turn (ignoring turnId differences)
      // Pass existing activities for incremental depth calculation
      currentTurn.activities.push(messageToActivity(message, currentTurn.activities))
      currentTurn.isStreaming = !isToolComplete
      continue
    }

    // Assistant messages are the response part of a turn
    if (message.role === 'assistant') {
      // Intermediate messages OR pending messages (don't know yet) are activities, not responses
      // Pending: streaming text where we don't yet know if it's intermediate - treat as intermediate
      // until text_complete arrives with the definitive isIntermediate flag
      if (message.isIntermediate || message.isPending) {
        if (!currentTurn) {
          // Start a new turn for this intermediate message
          currentTurn = {
            type: 'assistant',
            turnId: message.turnId || message.id,
            activities: [],
            response: undefined,
            intent: undefined,
            isStreaming: !!message.isPending,
            isComplete: false,
            timestamp: message.timestamp,
          }
        }
        // Always add to current turn as activity (ignoring turnId differences)
        // Pending messages show as 'running' until we know they're complete
        // Include parentId for intermediate messages to support nesting within subagents
        const intermediateActivity: ActivityItem = {
          id: message.id,
          type: 'intermediate',
          status: message.isPending ? 'running' : 'completed',
          content: message.content,
          timestamp: message.timestamp,
          ...(message.parentToolUseId !== undefined ? { parentId: message.parentToolUseId } : {}),
        }
        // Calculate depth for intermediate messages too
        if (intermediateActivity.parentId) {
          const parent = currentTurn.activities.find(a => a.toolUseId === intermediateActivity.parentId)
          intermediateActivity.depth = parent ? (parent.depth || 0) + 1 : 1
        } else {
          intermediateActivity.depth = 0
        }
        currentTurn.activities.push(intermediateActivity)

        // Update turn streaming state based on this message
        // If message is no longer pending/streaming, update turn state accordingly
        if (!message.isPending && !message.isStreaming) {
          currentTurn.isStreaming = false
        }
        continue
      }

      // Non-intermediate assistant message = final response
      if (!currentTurn) {
        // This is a response-only turn (no tools)
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: !!message.isStreaming,
          isComplete: !message.isStreaming,
          timestamp: message.timestamp,
        }
      }

      // Set as response on current turn (ignoring turnId differences)
      currentTurn.response = {
        text: message.content,
        isStreaming: !!message.isStreaming,
        streamStartTime: message.isStreaming ? message.timestamp : undefined,
        messageId: message.id,
        ...(message.annotations !== undefined ? { annotations: message.annotations } : {}),
      }
      currentTurn.isStreaming = !!message.isStreaming
      currentTurn.isComplete = !message.isStreaming

      // Flush when turn is complete (non-streaming = final response received)
      if (!message.isStreaming) {
        flushCurrentTurn()
      }
      continue
    }
  }

  // Session-complete fallback (mirrors messaging-gateway/renderer.ts lastAssistantText fallback).
  // When the session has stopped processing and the open turn has activities but never received
  // a non-intermediate assistant final, mark it complete so the existing "promote last
  // intermediate to response" branch in flushCurrentTurn fires. Without this the chat sits on
  // "Thinking…" forever when a turn ends on a tool call.
  if (
    options.isSessionProcessing === false
    && currentTurn
    && (currentTurn as AssistantTurn).activities.length > 0
  ) {
    (currentTurn as AssistantTurn).isComplete = true
  }

  // Flush any remaining turn
  flushCurrentTurn()

  return turns
}
