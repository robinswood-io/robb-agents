import { describe, expect, it } from 'bun:test'
import type { UserInputRequest } from '@craft-agent/core'
import type { Turn } from '../turn-utils'
import { buildUserInputTimeline } from '../user-input-timeline'

const user = (id: string, timestamp: number): Turn => ({
  type: 'user', timestamp, message: { id, role: 'user', content: id, timestamp },
})
const request = (id: string, createdAt: number, status: UserInputRequest['status'] = 'answered'): UserInputRequest => ({
  id, createdAt, status, sessionId: 'session', originWorkspaceId: 'workspace',
  questions: [{ id: 'format', question: 'Quel format ?' }],
  ...(status === 'answered' ? { answers: [{ questionId: 'format', optionIds: [], text: 'PDF' }] } : {}),
})
const ids = (timeline: ReturnType<typeof buildUserInputTimeline>) => timeline.map(entry =>
  entry.type === 'user-input' ? entry.request.id : entry.turn.type === 'assistant'
    ? entry.turn.response?.messageId : entry.turn.message.id)

describe('conversation question chronology', () => {
  it('keeps multiple answered and cancelled questions before subsequent messages, even when requests arrive out of order', () => {
    const turns = [user('original', 10), user('answer-1', 30), user('follow-up', 50), user('answer-2', 70), user('latest', 90)]
    const requests = [request('question-2', 60), request('cancelled', 40, 'cancelled'), request('question-1', 20)]
    const timeline = buildUserInputTimeline(turns, requests, { pendingAtEnd: true })
    expect(ids(timeline)).toEqual(['original', 'question-1', 'answer-1', 'cancelled', 'follow-up', 'question-2', 'answer-2', 'latest'])
    expect(requests[0]!.id).toBe('question-2')
    expect(timeline.filter(entry => entry.type === 'user-input')).toHaveLength(3)
  })

  it('keeps the active form reachable then moves its accepted answer into the original history slot', () => {
    const turns = [user('original', 10), user('later', 50)]
    const pending = request('active', 20, 'pending')
    expect(ids(buildUserInputTimeline(turns, [pending], { pendingAtEnd: true }))).toEqual(['original', 'later', 'active'])
    expect(ids(buildUserInputTimeline(turns, [{ ...pending, status: 'answered' }], { pendingAtEnd: true })))
      .toEqual(['original', 'active', 'later'])
    expect(ids(buildUserInputTimeline(turns, [pending]))).toEqual(['original', 'active', 'later'])
  })

  it('paginates history without relocating older answers into the latest page', () => {
    const timeline = buildUserInputTimeline([user('original', 10), user('middle', 50), user('latest', 90)],
      [request('old-answer', 20), request('recent-answer', 70), request('active', 15, 'pending')], { pendingAtEnd: true })
    expect(ids(timeline.filter(entry => entry.turnIndex >= 2))).toEqual(['recent-answer', 'latest', 'active'])
  })

  it('uses host identities when a legacy question has no usable timestamp or clocks disagree', () => {
    const turns = [user('original', 10), user('answer', 30), user('latest', 50)]
    expect(ids(buildUserInputTimeline(turns, [{ ...request('legacy', 0), responseMessageId: 'answer' }])))
      .toEqual(['original', 'legacy', 'answer', 'latest'])
    expect(ids(buildUserInputTimeline(turns, [{ ...request('skew', 100), responseMessageId: 'answer', objectiveUserMessageId: 'original' }])))
      .toEqual(['original', 'skew', 'answer', 'latest'])
  })

  it('places delegated and hidden-response questions using their durable creation time', () => {
    expect(ids(buildUserInputTimeline([user('parent', 10), user('later', 50)],
      [{ ...request('child-question', 20), sessionId: 'child', objectiveUserMessageId: 'child-objective', responseMessageId: 'hidden-child-response' }])))
      .toEqual(['parent', 'child-question', 'later'])
    expect(ids(buildUserInputTimeline([], [request('orphan', 20)]))).toEqual(['orphan'])
  })
})
