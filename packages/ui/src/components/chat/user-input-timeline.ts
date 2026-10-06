import type { UserInputRequest } from '@craft-agent/core'
import type { Turn } from './turn-utils'

export type ConversationTimelineEntry =
  | { type: 'turn'; turn: Turn; turnIndex: number }
  | { type: 'user-input'; request: UserInputRequest; turnIndex: number }

/** Keep durable questions at their original history position. Pending forms
 * stay reachable at the end of an interactive, reverse-paginated transcript.
 * Entries retain their keys when an answer moves the form into history, so a
 * durable answer whose dispatch fails still has its recorded-answer retry. */
export function buildUserInputTimeline(
  turns: readonly Turn[],
  requests: readonly UserInputRequest[],
  options: { pendingAtEnd?: boolean } = {},
): ConversationTimelineEntry[] {
  const messageIndexes = new Map<string, number>()
  turns.forEach((turn, index) => {
    const id = turn.type === 'assistant' ? turn.response?.messageId : turn.message.id
    if (id) messageIndexes.set(id, index)
  })
  const slots = new Map<number, UserInputRequest[]>()
  for (const request of [...requests].sort((a, b) => a.createdAt - b.createdAt)) {
    let index = turns.length
    if (!(options.pendingAtEnd && request.status === 'pending')) {
      const responseIndex = request.responseMessageId ? messageIndexes.get(request.responseMessageId) : undefined
      const objectiveIndex = request.objectiveUserMessageId ? messageIndexes.get(request.objectiveUserMessageId) : undefined
      if (Number.isFinite(request.createdAt) && request.createdAt > 0) {
        const next = turns.findIndex(turn => turn.timestamp > request.createdAt)
        if (next >= 0) index = next
        // Host message identities bound the position when clocks disagree.
        if (responseIndex !== undefined) index = Math.min(index, responseIndex)
        if (objectiveIndex !== undefined) index = Math.max(index, objectiveIndex + 1)
      } else {
        index = responseIndex ?? (objectiveIndex !== undefined ? objectiveIndex + 1 : turns.length)
      }
    }
    const slot = slots.get(index) ?? []
    slot.push(request)
    slots.set(index, slot)
  }
  const timeline: ConversationTimelineEntry[] = []
  for (let index = 0; index <= turns.length; index++) {
    for (const request of slots.get(index) ?? []) timeline.push({ type: 'user-input', request, turnIndex: index })
    if (index < turns.length) timeline.push({ type: 'turn', turn: turns[index]!, turnIndex: index })
  }
  return timeline
}
