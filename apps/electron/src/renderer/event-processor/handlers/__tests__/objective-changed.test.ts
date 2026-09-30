import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { SessionState } from '../../types'
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions'
import { projectConversation } from '../../../../../../../packages/ui/src/components/chat/conversation-presentation'

const visibleResponses = (state: SessionState, hasActiveDescendants = false) =>
  projectConversation(state.session.messages, { ...state.session, hasActiveDescendants }).turns
    .flatMap(turn => turn.type === 'assistant' && turn.response ? [turn.response.text] : [])

const objective: ActiveSessionObjective = {
  schemaVersion: 1, userMessageId: 'u1', objectiveId: 'u1', lastUserMessageId: 'u1',
  originalText: 'Préparer le rapport.', startedAt: 1, budgetBaselineUsd: 0,
  tokenBaseline: 0, continuationCount: 0, orchestrationMode: 'mission',
  risk: 'standard', terminalState: 'active', completionCriteria: [],
}
const initial = (): SessionState => ({
  session: {
    id: 'session-1', workspaceId: 'workspace', workspaceName: 'Workspace',
    lastMessageAt: 1, isProcessing: true,
    messages: [
      { id: 'u1', role: 'user', content: objective.originalText!, timestamp: 1 },
      { id: 'a2', role: 'assistant', content: 'Votre rapport est prêt.', timestamp: 2 },
    ],
  },
  streaming: { content: '', turnId: 'turn' },
})

describe('host objective events in the conversation', () => {
  it('preserves the produced deliverable through live demotion and recovery, then appends the verified summary', () => {
    const deliverable = Array.from({ length: 300 }, (_, index) => `${index + 1} : REPRISE-OK`).join('\n')
    const receipt = { state: 'complete_verified' as const, criteria: [], remainingWork: [], blocker: null }
    let state = initial()
    state.session.messages = state.session.messages.slice(0, 1)
    state = processEvent(state, { type: 'text_complete', sessionId: 'session-1', messageId: 'a2',
      turnId: 'turn', timestamp: 2, text: deliverable, objectiveOutcome: receipt }).state
    state = processEvent(state, { type: 'objective_changed', sessionId: 'session-1', activeObjective: objective,
      pendingTurnRecovery: { userMessageId: 'u1', startedAt: 1, attempts: 1, lastCause: 'objective_incomplete' },
    }).state
    state = processEvent(state, { type: 'text_complete', sessionId: 'session-1', messageId: 'a2',
      turnId: 'demoted', timestamp: 2, text: deliverable, isIntermediate: true, objectiveOutcome: receipt }).state
    state = processEvent(state, { type: 'user_message', sessionId: 'session-1', status: 'accepted',
      message: { id: 'u3', role: 'user', timestamp: 3, hidden: true, content: '<automatic_turn_recovery>' },
    }).state
    state = processEvent(state, { type: 'text_complete', sessionId: 'session-1', messageId: 'a4',
      turnId: 'recovery', timestamp: 4, text: 'Je vérifie les lignes produites.', isIntermediate: true,
    }).state
    expect(visibleResponses(state)).toEqual([deliverable])
    expect(projectConversation(state.session.messages, state.session).outcome).toBeUndefined()
    const hydrated = { ...state, session: JSON.parse(JSON.stringify(state.session)) }
    expect(visibleResponses(hydrated)).toEqual([deliverable])
    state = processEvent(state, { type: 'text_complete', sessionId: 'session-1', messageId: 'a5',
      turnId: 'verified', timestamp: 5, text: 'Les 300 lignes sont vérifiées.', objectiveOutcome: receipt,
    }).state
    expect(projectConversation(state.session.messages, state.session).outcome).toBeUndefined()
    state = processEvent(state, { type: 'objective_changed', sessionId: 'session-1',
      activeObjective: { ...objective, terminalState: 'complete_verified' }, pendingTurnRecovery: null,
    }).state
    state = processEvent(state, { type: 'complete', sessionId: 'session-1' }).state
    const result = projectConversation(state.session.messages, state.session)
    expect(visibleResponses(state)).toEqual([deliverable, 'Les 300 lignes sont vérifiées.'])
    expect(result.turns.filter(turn => turn.type === 'user')).toHaveLength(1)
    expect(result.outcome?.state).toBe('succeeded')
  })

  it('shows current validation gaps from the typed host error immediately', () => {
    const changed = processEvent(initial(), { type: 'objective_changed', sessionId: 'session-1',
      activeObjective: { ...objective, terminalState: 'exhausted' }, pendingTurnRecovery: null,
    }).state
    const details = ['missing criterion: no-safe-work-remaining', 'criterion lacks observed evidence: relevant-checks-passed']
    const stopped = processEvent(changed, { type: 'typed_error', sessionId: 'session-1', timestamp: 3,
      error: { code: 'objective_validation_failed', title: 'Completion could not be verified',
        message: 'Validation stopped after bounded recovery.', details, actions: [], canRetry: true },
    }).state
    expect(stopped.session.messages.at(-1)).toMatchObject({ errorCode: 'objective_validation_failed', errorDetails: details })
    expect(projectConversation(stopped.session.messages, stopped.session).outcome)
      .toMatchObject({ state: 'failed', retryUserMessageId: 'u1', validationGaps: details })
  })

  it('shows the live human report after receipt rejection, demotion and stop without another user message', () => {
    let state = initial()
    state.session.messages = state.session.messages.slice(0, 1)
    state = processEvent(state, {
      type: 'text_complete', sessionId: 'session-1', messageId: 'a2', turnId: 'turn', timestamp: 2,
      text: 'Le rapport est préparé, mais sa validation reste incomplète.',
      objectiveOutcome: null, objectiveOutcomeError: 'malformed objective outcome receipt',
    }).state
    state = processEvent(state, {
      type: 'objective_changed', sessionId: 'session-1',
      activeObjective: { ...objective, terminalState: 'exhausted' }, pendingTurnRecovery: null,
    }).state
    state = processEvent(state, {
      type: 'text_complete', sessionId: 'session-1', messageId: 'a2', turnId: 'turn-demoted', timestamp: 2,
      text: state.session.messages[1]!.content, isIntermediate: true,
      objectiveOutcome: null, objectiveOutcomeError: 'malformed objective outcome receipt',
    }).state
    expect(visibleResponses(state)).toEqual(['Le rapport est préparé, mais sa validation reste incomplète.'])
    expect(projectConversation(state.session.messages, state.session).outcome).toBeUndefined()
    state = processEvent(state, { type: 'error', sessionId: 'session-1', error: 'Objective validation exhausted' }).state
    state = processEvent(state, { type: 'complete', sessionId: 'session-1' }).state
    expect(state.session.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(state.session.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(state.session.messages[1]).toMatchObject({ id: 'a2', isIntermediate: true, objectiveOutcomeError: 'malformed objective outcome receipt' })
    expect(visibleResponses(state)).toEqual(['Le rapport est préparé, mais sa validation reste incomplète.'])
    expect(projectConversation(state.session.messages, state.session).outcome)
      .toMatchObject({ state: 'failed', hasFinalResponse: true, retryUserMessageId: 'u1' })
  })

  it('keeps the completed parent answer visible while a descendant is still active', () => {
    for (const completeFirst of [false, true]) {
      let state = initial()
      const complete = { type: 'complete', sessionId: 'session-1' } as const
      const verified = { type: 'objective_changed', sessionId: 'session-1',
        activeObjective: { ...objective, terminalState: 'complete_verified' as const }, pendingTurnRecovery: null } as const
      for (const event of completeFirst ? [complete, verified] : [verified, complete]) state = processEvent(state, event).state
      const projected = projectConversation(state.session.messages, { ...state.session, hasActiveDescendants: true })
      expect(visibleResponses(state, true)).toEqual(['Votre rapport est prêt.'])
      expect(projected.progress?.state).toBe('running')
      expect(projected.outcome).toBeUndefined()
      expect(projectConversation(state.session.messages, state.session).outcome?.state).toBe('succeeded')
    }
  })

  it('preserves the active turn when a hidden question reply is queued, then starts that same reply after completion', () => {
    const before = initial()
    const reply = { id: 'u3', role: 'user' as const, content: 'Use option A.', timestamp: 3, hidden: true }
    const queued = processEvent(before, { type: 'user_message', sessionId: 'session-1', message: reply, status: 'queued' }).state
    expect(queued.session.isProcessing).toBe(true)
    expect(queued.streaming).toBe(before.streaming)
    expect(queued.session.messages.at(-1)?.isQueued).toBe(true)
    expect(visibleResponses(queued)).toEqual([])
    const completed = processEvent(queued, { type: 'complete', sessionId: 'session-1' }).state
    expect(completed.session.isProcessing).toBe(false)
    const processing = processEvent(completed, { type: 'user_message', sessionId: 'session-1', message: reply, status: 'processing' }).state
    expect(processing.session.isProcessing).toBe(true)
    expect(processing.session.messages.filter(message => message.id === reply.id)).toHaveLength(1)
    expect(processing.session.messages.at(-1)).toMatchObject({ hidden: true, isQueued: false })
    expect(projectConversation(processing.session.messages, processing.session).turns.filter(turn => turn.type === 'user')).toHaveLength(1)
    expect(processEvent({ ...before, session: { ...before.session, isProcessing: false } }, {
      type: 'user_message', sessionId: 'session-1', message: reply, status: 'queued',
    }).state.session.isProcessing).toBe(false)
  })

  it('shows a verified final only after the host completes the turn', () => {
    const before = initial()
    const changed = processEvent(before, {
      type: 'objective_changed', sessionId: 'session-1',
      activeObjective: { ...objective, terminalState: 'complete_verified' }, pendingTurnRecovery: null,
    })
    expect(changed.effects).toEqual([])
    expect(changed.state.session.messages).toBe(before.session.messages)
    expect(changed.state.streaming).toBe(before.streaming)
    expect(changed.state.session.isProcessing).toBe(true)
    expect(projectConversation(changed.state.session.messages, changed.state.session).outcome).toBeUndefined()
    const completed = processEvent(changed.state, { type: 'complete', sessionId: 'session-1' })
    expect(projectConversation(completed.state.session.messages, completed.state.session).outcome)
      .toMatchObject({ state: 'succeeded', hasFinalResponse: true, objectiveText: objective.originalText })
  })

  it('clears the previous result explicitly and retains the ongoing conversation', () => {
    const before = initial()
    before.session.activeObjective = { ...objective, terminalState: 'complete_verified' }
    const cleared = processEvent(before, {
      type: 'objective_changed', sessionId: 'session-1', activeObjective: null, pendingTurnRecovery: null,
    })
    expect(cleared.state.session.activeObjective).toBeUndefined()
    expect(cleared.state.session.pendingTurnRecovery).toBeUndefined()
    expect(cleared.state.session.messages).toBe(before.session.messages)
    expect(cleared.state.session.isProcessing).toBe(true)
    expect(before.session.activeObjective?.terminalState).toBe('complete_verified')
  })
})
