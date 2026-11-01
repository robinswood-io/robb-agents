import type { ActivityItem } from "../TurnCard";
import type { AssistantTurn, Turn, UserTurn } from './turn-types.ts';

// ============================================================================
// Last Turn/Message Utilities
// ============================================================================

/**
 * Get the last assistant turn from a list of turns.
 * Useful for determining the current/most recent assistant response.
 */
export function getLastAssistantTurn(turns: Turn[]): AssistantTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type === 'assistant') {
      return turn as AssistantTurn
    }
  }
  return undefined
}

/**
 * Get the timestamp of the last user message from turns.
 * Useful for calculating elapsed time since user sent their message.
 */
export function getLastUserMessageTime(turns: Turn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type === 'user') {
      return (turn as UserTurn).timestamp
    }
  }
  return undefined
}

/**
 * Check if the last assistant turn is still streaming/processing.
 */
export function isLastTurnStreaming(turns: Turn[]): boolean {
  const lastAssistant = getLastAssistantTurn(turns)
  return lastAssistant?.isStreaming ?? false
}

/**
 * Pre-compute which activities are the last child at their depth level.
 * Returns a Set of activity IDs that are last children.
 * This is O(n) instead of O(n²) for checking during render.
 */
export function computeLastChildSet(activities: ActivityItem[]): Set<string> {
  // Track the last activity for each parentId
  const lastByParent = new Map<string | undefined, string>()

  for (const activity of activities) {
    if (activity.depth && activity.depth > 0) {
      // This activity has a parent - mark it as the (potentially) last child
      lastByParent.set(activity.parentId, activity.id)
    }
  }

  return new Set(lastByParent.values())
}
