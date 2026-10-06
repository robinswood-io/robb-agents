import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core/types'
import type { SessionState } from '../../types'
import { processEvent } from '../../processor'
import { projectConversation } from '../../../../../../../packages/ui/src/components/chat/conversation-presentation'
import { createRetryTurnAction } from '../../../components/app-shell/retry-turn-action'
import { getSessionProcessingRevision } from '../../../lib/session-processing-state'

const optimistic: Message = { id: 'optimistic-user', role: 'user', content: 'Ask my preference and use it.', timestamp: 1, isPending: true, isQueued: false }
const accepted: Message = { ...optimistic, id: 'durable-user', timestamp: 2, isPending: undefined }
const initial = (): SessionState => ({ session: { id: 'session', workspaceId: 'workspace', workspaceName: 'Workspace',
  lastMessageAt: 1, isProcessing: true, messages: [{ ...optimistic }] }, streaming: { content: '', turnId: 'turn' } })
const acknowledge = (state: SessionState, status: 'accepted' | 'queued' | 'processing' = 'accepted') => processEvent(state, {
  type: 'user_message', sessionId: 'session', message: accepted, optimisticMessageId: optimistic.id, status,
}).state

describe('canonical identity of accepted user messages', () => {
  it('retries the durable request after an answered question, provisional final and newer Stop', async () => {
    let state = acknowledge(initial())
    const objective = { schemaVersion: 1 as const, objectiveId: accepted.id, userMessageId: accepted.id, lastUserMessageId: accepted.id,
      originalText: accepted.content, startedAt: 2, budgetBaselineUsd: 1, tokenBaseline: 10, continuationCount: 3,
      orchestrationMode: 'direct' as const, risk: 'standard' as const, terminalState: 'active' as const, completionCriteria: [] }
    state = processEvent(state, { type: 'objective_changed', sessionId: 'session', activeObjective: objective, pendingTurnRecovery: null }).state
    const answer: Message = { id: 'durable-answer', role: 'user', content: 'Blue.', timestamp: 3,
      hidden: true, internalOrigin: { kind: 'user-input' } }
    state = processEvent(state, { type: 'user_message', sessionId: 'session', message: answer, status: 'processing' }).state
    state = processEvent(state, { type: 'text_complete', sessionId: 'session', messageId: 'answer-final', turnId: 'turn',
      timestamp: 4, text: 'The chosen colour is blue.', isIntermediate: true }).state
    state = processEvent(state, { type: 'interrupted', sessionId: 'session',
      message: { id: 'new-stop', role: 'info', content: 'Response interrupted', timestamp: 5 } }).state
    const before = structuredClone(state.session)
    const beforeProcessingRevision = getSessionProcessingRevision(state.session)
    const presentation = projectConversation(state.session.messages, state.session)
    expect(presentation.outcome).toMatchObject({ state: 'interrupted', retryUserMessageId: accepted.id, objectiveText: accepted.content })
    const commands: unknown[] = []
    const retry = createRetryTurnAction({ sessionId: 'session', isProcessing: () => state.session.isProcessing,
      sessionCommand: async (_id, command) => { commands.push(command); return { status: 'started' } },
      onPendingChange: () => {}, onError: error => { throw error } })
    await retry(presentation.outcome!.retryUserMessageId!)
    expect(commands).toEqual([{ type: 'retryTurn', userMessageId: accepted.id }])
    expect(structuredClone(state.session)).toEqual(before)
    expect(getSessionProcessingRevision(state.session)).toBe(beforeProcessingRevision)
    expect(state.session.messages.filter(m => m.role === 'user')).toHaveLength(2)
    expect(state.session.messages.find(m => m.id === answer.id)).toMatchObject({ hidden: true, internalOrigin: answer.internalOrigin, content: 'Blue.' })
    expect(state.session.activeObjective).toEqual(objective)
  })

  it('canonicalizes a queued ACK, then reconciles processing, duplicate ACKs and reconnect without duplicating the message', () => {
    let state = acknowledge(initial(), 'queued')
    expect(state.session.messages).toHaveLength(1)
    expect(state.session.messages[0]).toMatchObject({ id: accepted.id, timestamp: accepted.timestamp, isPending: false, isQueued: true })
    state = acknowledge(state, 'processing')
    state = acknowledge(state, 'accepted')
    state = acknowledge(state, 'queued') // Late transport event cannot put it back in the queue.
    expect(state.session.messages).toHaveLength(1)
    expect(state.session.messages[0]).toMatchObject({ id: accepted.id, timestamp: accepted.timestamp, isQueued: false })
    state.session.messages = [{ ...accepted, isQueued: false }]
    state = acknowledge(state, 'accepted')
    expect(state.session.messages.map(m => m.id)).toEqual([accepted.id])
  })

  it('keeps each queued request pending across completion and host state changes until its own dispatch acknowledgement', () => {
    let state = acknowledge(initial())
    const first: Message = { id: 'queued-first', role: 'user', content: 'First follow-up', timestamp: 3 }
    const second: Message = { id: 'queued-second', role: 'user', content: 'Second follow-up', timestamp: 4 }
    for (const message of [first, second]) {
      state = processEvent(state, { type: 'user_message', sessionId: 'session', status: 'queued', message }).state
    }
    const queuedIds = () => state.session.messages.filter(message => message.isQueued).map(message => message.id)
    state = processEvent(state, { type: 'complete', sessionId: 'session' }).state
    expect(state.session.isProcessing).toBe(false)
    expect(queuedIds()).toEqual([first.id, second.id])
    for (const isProcessing of [true, false, true]) {
      state = processEvent(state, { type: 'session_metadata_changed', sessionId: 'session', changes: { isProcessing } }).state
      expect(state.session.isProcessing).toBe(isProcessing)
      expect(queuedIds()).toEqual([first.id, second.id])
    }
    state = processEvent(state, { type: 'user_message', sessionId: 'session', status: 'processing', message: first }).state
    expect(queuedIds()).toEqual([second.id])
    state = processEvent(state, { type: 'complete', sessionId: 'session' }).state
    expect(queuedIds()).toEqual([second.id])
    state = processEvent(state, { type: 'user_message', sessionId: 'session', status: 'accepted', message: second }).state
    expect(state.session.isProcessing).toBe(true)
    expect(queuedIds()).toEqual([])
    expect(state.session.messages.map(message => message.id)).toEqual([accepted.id, first.id, second.id])
  })

  it('matches the explicit optimistic ID before similar content, and never merges two accepted human sends', () => {
    const state = initial()
    state.session.messages.unshift({ ...accepted, id: 'older-durable', timestamp: 0, isQueued: false })
    let result = acknowledge(state)
    expect(result.session.messages.map(m => m.id)).toEqual(['older-durable', accepted.id])
    result = processEvent(result, { type: 'user_message', sessionId: 'session', status: 'accepted',
      message: { ...accepted, id: 'another-durable', timestamp: 3 } }).state
    expect(result.session.messages.map(m => m.id)).toEqual(['older-durable', accepted.id, 'another-durable'])
  })

  it('uses the next canonical user anchor after a genuine new message, not a previous question answer', () => {
    let state = acknowledge(initial())
    state.session.messages.push({ ...optimistic, id: 'next-optimistic', content: 'A new request.', timestamp: 10 })
    state = processEvent(state, { type: 'user_message', sessionId: 'session', status: 'accepted', optimisticMessageId: 'next-optimistic',
      message: { id: 'next-durable', role: 'user', content: 'A new request.', timestamp: 11 } }).state
    state = processEvent(state, { type: 'interrupted', sessionId: 'session',
      message: { id: 'next-stop', role: 'info', content: 'Response interrupted', timestamp: 12 } }).state
    expect(projectConversation(state.session.messages, state.session).outcome?.retryUserMessageId).toBe('next-durable')
  })
})
