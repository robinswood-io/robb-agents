/**
 * turn-utils.ts
 *
 * Utilities for grouping messages by turn for TurnCard rendering.
 * Converts the flat Message[] array into grouped turns for email-like display.
 */
import type { Message } from "@craft-agent/core";
import type { ActivityItem, ActivityStatus, ActivityType, TodoItem } from "../TurnCard";
import { stripErrorTags } from './turn-types.ts';

// ============================================================================
// Helper Functions
// ============================================================================

/** Convert tool status from message to ActivityStatus */
function getToolStatus(message: Message): ActivityStatus {
  // The result envelope completed, but the requested operation did not run.
  // Render this separately from both success and operational failure.
  if (message.toolExecuted === false) return 'checkpoint'
  // response_too_large is success (data was saved, just too large for inline display)
  if (message.errorCode === 'response_too_large') return 'completed'
  if (message.isError) return 'error'
  // Backgrounded takes priority — tool_result arrives before task_backgrounded,
  // so toolResult is set but the task is still running in the background
  if (message.toolStatus === 'backgrounded') return 'backgrounded'
  // Check explicit toolStatus first (set by tool_result handler)
  if (message.toolStatus === 'completed') return 'completed'
  // Fallback: check if toolResult exists (handles empty string results)
  if (message.toolResult !== undefined) return 'completed'
  if (message.toolStatus === 'pending') return 'pending'
  return 'running'
}

/**
 * Convert message to ActivityItem with incremental depth calculation.
 * Depth is calculated immediately using existing activities, enabling
 * correct tree view rendering during streaming (not just on flush).
 *
 * @param message - The message to convert
 * @param existingActivities - Activities already in the turn (for depth lookup)
 */
export function messageToActivity(message: Message, existingActivities: ActivityItem[] = []): ActivityItem {
  const activity: ActivityItem = {
    id: message.id,
    type: 'tool' as ActivityType,
    status: getToolStatus(message),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.toolUseId !== undefined ? { toolUseId: message.toolUseId } : {}),  // For parent-child matching
    ...(message.toolInput !== undefined ? { toolInput: message.toolInput } : {}),
    content: message.toolResult || message.content,
    ...(message.toolIntent !== undefined ? { intent: message.toolIntent } : {}),
    ...(message.toolDisplayName !== undefined ? { displayName: message.toolDisplayName } : {}),  // LLM-generated human-friendly name
    ...(message.toolDisplayMeta !== undefined ? { toolDisplayMeta: message.toolDisplayMeta } : {}),  // Embedded metadata with base64 icon for viewer
    timestamp: message.timestamp,
    error: message.isError ? stripErrorTags(message.toolResult || message.content) : undefined,
    ...(message.toolExecuted !== undefined ? { executed: message.toolExecuted } : {}),
    ...(message.toolCheckpoint !== undefined ? { checkpoint: message.toolCheckpoint } : {}),
    // parentId: The toolUseId of the parent tool (e.g., Task subagent).
    // This is tracked by session manager's parentToolStack, NOT the SDK's
    // parent_tool_use_id which is for result-matching, not hierarchy.
    ...(message.parentToolUseId !== undefined ? { parentId: message.parentToolUseId } : {}),
    // Background task fields
    ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
    ...(message.shellId !== undefined ? { shellId: message.shellId } : {}),
    ...(message.elapsedSeconds !== undefined ? { elapsedSeconds: message.elapsedSeconds } : {}),
    ...(message.isBackground !== undefined ? { isBackground: message.isBackground } : {}),
  }

  // Calculate depth incrementally using existing activities
  // This enables correct tree view rendering during streaming
  if (activity.parentId) {
    const parent = existingActivities.find(a => a.toolUseId === activity.parentId)
    activity.depth = parent ? (parent.depth || 0) + 1 : 1
  } else {
    activity.depth = 0
  }

  return activity
}

/**
 * Calculate nesting depths for activities based on parent-child relationships.
 * Modifies activities in place, adding depth field (0 = root, 1 = child, etc.)
 *
 * Note: With incremental depth calculation in messageToActivity(), this function
 * serves as a safety net for edge cases (e.g., parent arrives after child) and
 * ensures all depths are correctly set when a turn is flushed.
 */
export function calculateActivityDepths(activities: ActivityItem[]): void {
  // Build a map of toolUseId -> activity for fast parent lookup
  const toolIdToActivity = new Map<string, ActivityItem>()
  for (const activity of activities) {
    if (activity.toolUseId) {
      toolIdToActivity.set(activity.toolUseId, activity)
    }
  }

  // Calculate depth for each activity (recalculates to handle edge cases)
  for (const activity of activities) {
    let depth = 0
    let parentId = activity.parentId

    // Walk up the parent chain, max 10 levels to prevent infinite loops
    while (parentId && depth < 10) {
      depth++
      const parent = toolIdToActivity.get(parentId)
      parentId = parent?.parentId
    }

    activity.depth = depth
  }
}

// ============================================================================
// TodoWrite Extraction
// ============================================================================

/**
 * Extract todos from TodoWrite tool results in activities.
 * Returns the latest todo state (from the most recent TodoWrite call).
 */
export function extractTodosFromActivities(activities: ActivityItem[]): TodoItem[] | undefined {
  // Find all TodoWrite tool results, get the latest one
  const todoWriteActivities = activities
    .filter(a => a.toolName === 'TodoWrite' && a.status === 'completed' && a.content)
    .sort((a, b) => b.timestamp - a.timestamp) // Most recent first

  const latestActivity = todoWriteActivities[0]
  if (!latestActivity) return undefined

  const latestResult = latestActivity.content
  if (!latestResult) return undefined

  try {
    // TodoWrite result is typically a success message, but the input contains the todos
    // We need to get the toolInput which has the todos array
    const input = latestActivity.toolInput
    if (input && Array.isArray(input["todos"])) {
      return input["todos"].map((todo: { content: string; status: string; activeForm?: string }) => ({
        content: todo.content,
        status: todo.status as 'pending' | 'in_progress' | 'completed',
        activeForm: todo.activeForm,
      }))
    }
  } catch {
    // Failed to parse, return undefined
  }

  return undefined
}
