import type { AssistantTurn } from './turn-types.ts';

/**
 * Get the primary intent for a turn (first available intent from activities)
 */
export function getTurnIntent(turn: AssistantTurn): string | undefined {
  // First check explicit turn intent
  if (turn.intent) return turn.intent

  // Then look for activity intents
  for (const activity of turn.activities) {
    if (activity.intent) return activity.intent
  }

  return undefined
}

/**
 * Check if any activity in the turn is still running
 */
export function hasPendingActivities(turn: AssistantTurn): boolean {
  return turn.activities.some(a => a.status === 'running' || a.status === 'pending' || a.status === 'backgrounded')
}

/**
 * Check if any activity in the turn has an error
 */
export function hasErrorActivities(turn: AssistantTurn): boolean {
  return turn.activities.some(a => a.status === 'error')
}

/**
 * Get a summary of completed activities
 */
export function getActivitySummary(turn: AssistantTurn): string {
  const completed = turn.activities.filter(a => a.status === 'completed').length
  const running = turn.activities.filter(a => a.status === 'running').length
  const errors = turn.activities.filter(a => a.status === 'error').length
  const checkpoints = turn.activities.filter(a => a.status === 'checkpoint').length

  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (completed > 0) parts.push(`${completed} completed`)
  if (errors > 0) parts.push(`${errors} failed`)
  if (checkpoints > 0) parts.push(`${checkpoints} not executed`)

  return parts.join(', ') || 'No activities'
}
