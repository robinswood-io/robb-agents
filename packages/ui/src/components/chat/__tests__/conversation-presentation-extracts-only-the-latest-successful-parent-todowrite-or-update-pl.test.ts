import { describe, expect, it } from "bun:test";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { projectConversation } from "../conversation-presentation";
import { finals, message, objective, plan, user } from "./testing/conversation-presentation-fixture.ts";

describe('quiet conversation presentation', () => {


  it('extracts only the latest successful parent TodoWrite or update_plan', () => {
    const result = projectConversation([user, plan('t2'), plan('t3', 'functions.update_plan'),
      plan('t4', 'TodoWrite', { isError: true, toolInput: { todos: [] } }),
      plan('t5', 'TodoWrite', { toolExecuted: false, toolInput: { todos: [] } }),
      plan('t6', 'TodoWrite', { toolStatus: 'executing', toolInput: { todos: [] } }),
      plan('t7', 'TodoWrite', { toolResult: undefined, toolInput: { todos: [] } }),
      plan('t8', 'TodoWrite', { toolCheckpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'Not executed' }, toolInput: { todos: [] } }),
    ], { isProcessing: true })
    expect(result.progress?.steps).toEqual([
      { content: 'Préparer le rapport', status: 'completed' },
      { content: 'Vérifier le rendu', status: 'in_progress' },
      { content: 'Livrer le rapport', status: 'pending' },
    ])
  })

  it('does not adopt an empty safety-net completion or pending plan as a confirmed update', () => {
    for (const extra of [{ toolResult: '' }, { toolResult: '   ' }, { isPending: true }, { isStreaming: true }]) {
      const result = projectConversation([user, plan('t2'), plan('t3', 'TodoWrite', {
        ...extra, toolInput: { todos: [{ content: 'Faussement terminé', status: 'completed' }] },
      })], { isProcessing: true })
      expect(result.progress?.steps.map(step => step.content)).toEqual(['Préparer le rapport', 'Vérifier le rendu', 'Livrer le rapport'])
    }
    const legacySafetyNet = plan('t2', 'update_plan', { toolExecuted: undefined, toolResult: '' })
    expect(projectConversation([user, legacySafetyNet], { isProcessing: true }).progress?.steps).toEqual([])
  })

  it('does not turn all completed plan rows or a model success declaration into verified success', () => {
    const result = projectConversation([user, plan('t2', 'TodoWrite', {
      toolInput: { todos: [{ content: 'Travail annoncé terminé', status: 'completed' }] },
    }), message('a3', 'assistant', { content: 'Tout est fait.', objectiveOutcome: {
      state: 'complete_verified', criteria: [], remainingWork: [], blocker: null,
    } })], { isProcessing: false, activeObjective: objective() })
    expect(result.outcome?.state).toBe('unverified')
    expect(result.outcome?.steps?.[0]?.status).toBe('completed')
  })

  it('retains the latest confirmed empty plan and never treats planned completion as actual success', () => {
    const completed = plan('t2', 'TodoWrite', { toolInput: { todos: [{ content: 'Terminé', status: 'completed' }] } })
    expect(projectConversation([user, completed], { isProcessing: true }).progress).toMatchObject({ state: 'running', phase: 'finishing' })
    const cleared = projectConversation([user, completed,
      plan('t3', 'update_plan', { toolInput: { plan: [] } })], { isProcessing: true })
    expect(cleared.progress?.steps).toEqual([])
    expect(cleared.outcome).toBeUndefined()
  })

  it('does not reuse the prior request final, plan, recovery or successful objective for a new request', () => {
    const old = [user, plan('t2'), message('a3', 'assistant', { content: 'Ancien résultat.' })]
    const result = projectConversation([...old, message('u4', 'user', { content: 'Analyse la nouvelle demande.' }),
      message('a5', 'assistant', { isIntermediate: true }), message('e6', 'error')], {
      isProcessing: false, activeObjective: objective({ terminalState: 'complete_verified' }),
      pendingTurnRecovery: { userMessageId: 'u1', attempts: 3, lastCause: 'app_restart' },
    })
    expect(finals(result.turns)).toEqual(['Ancien résultat.'])
    expect(result.outcome).toMatchObject({ state: 'failed', objectiveText: 'Analyse la nouvelle demande.', hasFinalResponse: false })
    expect(result.outcome?.steps).toBeUndefined()
    expect(result.progress).toBeUndefined()
  })

  it('preserves ordinary chat history while suppressing only the current answer during processing', () => {
    const result = projectConversation([user, message('a2', 'assistant', { content: 'Première réponse.' }),
      message('u3', 'user'), message('a4', 'assistant', { content: 'Deuxième réponse.' }),
    ], { isProcessing: true })
    expect(finals(result.turns)).toEqual(['Première réponse.'])
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    expect(result.progress?.state).toBe('running')
  })

  it('leaves a normal historical answer alone without inventing an unverified warning', () => {
    const messages = [message('u1', 'user', { content: 'Combien font 2 + 2 ?' }),
      message('a2', 'assistant', { content: '4.' })]
    const result = projectConversation(messages, { isProcessing: false })
    expect(finals(result.turns)).toEqual(['4.'])
    expect(result.outcome).toBeUndefined()
    const withPlan = projectConversation([user, plan('t2'), message('a3', 'assistant')], { isProcessing: false })
    expect(withPlan.outcome).toMatchObject({ state: 'unverified', hasFinalResponse: true })
    expect(withPlan.outcome?.steps).toHaveLength(3)
  })

  it('shows an honest interrupted outcome without promoting the last comment', () => {
    const result = projectConversation([user, plan('t2'),
      message('a3', 'assistant', { isIntermediate: true, content: 'Je commence.' }),
      message('i4', 'info', { content: 'Response interrupted' }),
    ], { isProcessing: false, activeObjective: objective() })
    expect(result.outcome).toMatchObject({ state: 'interrupted', hasFinalResponse: false })
    expect(result.outcome?.steps?.map(step => step.status)).toEqual(['completed', 'interrupted', 'pending'])
  })

  it('stops the progress state when durable recovery is exhausted', () => {
    const result = projectConversation([user, message('a2', 'assistant', { isIntermediate: true })], {
      isProcessing: false, activeObjective: objective(),
      pendingTurnRecovery: { userMessageId: 'u1', attempts: 8, lastCause: 'objective_incomplete', exhaustedAt: 10 },
    })
    expect(result.progress).toBeUndefined()
    expect(result.outcome).toMatchObject({ state: 'failed', hasFinalResponse: false })
  })

  it('shows a terminal disk error and its recovery actions instead of a stale retry spinner', () => {
    const error = message('e4', 'error', { content: 'ENOSPC: no space left on device, write',
      errorCode: 'runtime_error', errorCanRetry: true,
      errorActions: [{ key: 'reconnect', label: 'Reconnecter', action: 'reconnect_runtime' },
        { key: 'retry', label: 'Réessayer', action: 'retry' }],
    })
    const result = projectConversation([user,
      message('u2', 'user', { hidden: true, content: '<automatic_turn_recovery>' }), error,
    ], { isProcessing: false, activeObjective: objective(),
      pendingTurnRecovery: { userMessageId: 'u1', attempts: 2, lastAttemptAt: 2, lastCause: 'objective_incomplete' },
    })
    expect(result.progress).toBeUndefined()
    expect(result.outcome).toMatchObject({ state: 'failed', hasFinalResponse: false })
    expect(result.turns).toEqual([
      { type: 'user', message: user, timestamp: user.timestamp },
      { type: 'system', message: error, timestamp: error.timestamp },
    ])
    expect(result.turns[1]).toMatchObject({ message: { errorActions: error.errorActions } })
  })

  it('does not let a stale recovery or pending plan hide an explicit interruption', () => {
    const result = projectConversation([user, message('p2', 'plan'),
      message('i4', 'info', { content: 'Response interrupted by user' }),
    ], { isProcessing: false, activeObjective: objective(),
      pendingTurnRecovery: { userMessageId: 'u1', attempts: 1, lastAttemptAt: 2, lastCause: 'objective_incomplete' },
    })
    expect(result.progress).toBeUndefined()
    expect(result.outcome?.state).toBe('interrupted')
  })

  it('preserves a real new retry or follow-up after a previous terminal error', () => {
    const error = message('e3', 'error', { content: 'Previous provider failure' })
    for (const isProcessing of [false, true]) {
      const result = projectConversation([user, error], { isProcessing, activeObjective: objective(),
        pendingTurnRecovery: { userMessageId: 'u1', attempts: 2, lastAttemptAt: 4, lastCause: 'objective_incomplete' },
      })
      expect(result.progress?.state).toBe('recovering')
      expect(result.turns.map(turn => turn.type)).toEqual(['user'])
    }
    const followUp = message('u4', 'user', { content: 'Poursuis.' })
    const next = projectConversation([user, error, followUp], { isProcessing: true,
      activeObjective: objective({ lastUserMessageId: followUp.id }),
    })
    expect(next.progress?.state).toBe('running')
    expect(next.turns.map(turn => turn.type)).toEqual(['user', 'user'])
  })

  it('removes an earlier failure after a later accepted final resolves the request', () => {
    for (const activeObjective of [undefined, objective({ terminalState: 'complete_verified' })]) {
      const result = projectConversation([user,
        message('e2', 'error', { content: 'Previous connection failure' }),
        message('a3', 'assistant', { content: 'Le résultat a été vérifié et livré.' }),
      ], { isProcessing: false, activeObjective })
      expect(result.progress).toBeUndefined()
      expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
      expect(result.outcome?.state).toBe(activeObjective ? 'succeeded' : undefined)
    }
  })

  it('keeps the completed human blocker report when its machine receipt is malformed', () => {
    const report = message('a3', 'assistant', { content: 'La publication est abandonnée faute d’enregistrement exploitable.',
      objectiveOutcomeError: 'malformed objective outcome receipt',
    })
    const result = projectConversation([user, report], { isProcessing: false,
      activeObjective: objective({ terminalState: 'exhausted' }),
    })
    expect(finals(result.turns)).toEqual([report.content])
    expect(result.outcome).toMatchObject({ state: 'failed', hasFinalResponse: true })
    expect(projectConversation([user, report], { isProcessing: false }).outcome?.state).toBe('unverified')
    const repairing = projectConversation([user, report], { isProcessing: true })
    expect(finals(repairing.turns)).toEqual([report.content])
    expect(repairing.outcome).toBeUndefined()
  })

  it('keeps a host-rejected final report readable without promoting its claimed success', () => {
    const report = message('a3', 'assistant', { content: 'Voici le texte révisé.', isIntermediate: true,
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [], blocker: null },
    })
    const result = projectConversation([user, report], { isProcessing: false,
      activeObjective: objective({ terminalState: 'exhausted' }),
    })
    expect(finals(result.turns)).toEqual([report.content])
    expect(result.outcome?.state).toBe('failed')
    const next = projectConversation([user, report, message('u4', 'user', { content: 'Change la date.' })], {
      isProcessing: false, activeObjective: objective({ lastUserMessageId: 'u4' }),
    })
    expect(finals(next.turns)).toEqual([report.content])
    expect(next.turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    expect(next.outcome?.hasFinalResponse).toBe(false)
  })

  it('keeps interactive authentication requests and submitted plans', () => {
    const auth = message('auth3', 'auth-request', { authStatus: 'pending', authRequestId: 'auth' })
    const submitted = message('plan2', 'plan', { content: '# Plan à approuver', planPath: '/tmp/plan.md' })
    const result = projectConversation([user, submitted, auth], { isProcessing: false, activeObjective: objective() })
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'auth-request'])
    expect(result.turns[2]).toMatchObject({ message: auth })
    expect(result.turns[1]).toMatchObject({ activities: [{ type: 'plan', content: submitted.content, messageId: submitted.id }] })
    expect(result.progress?.state).toBe('waiting')
    expect(finals(result.turns)).toEqual([])
  })

  it('keeps only the latest submitted plan in each request segment and across active clarifications', () => {
    const messages = [user, message('p2', 'plan', { content: 'Plan A' }),
      message('p3', 'plan', { content: 'Plan B' }),
      message('u4', 'user', { content: 'Ajoute la vérification visuelle.' }),
      message('p5', 'plan', { content: 'Plan C' }), message('p6', 'plan', { content: 'Plan D' })]
    const planTexts = (result: ReturnType<typeof projectConversation>) => result.turns.flatMap(turn =>
      turn.type === 'assistant' ? turn.activities.filter(activity => activity.type === 'plan').map(activity => activity.content) : [])
    expect(planTexts(projectConversation(messages, { isProcessing: false }))).toEqual(['Plan B', 'Plan D'])
    const scoped = projectConversation(messages, { isProcessing: false,
      activeObjective: objective({ lastUserMessageId: 'u4', continuationCount: 1 }),
    })
    expect(planTexts(scoped)).toEqual(['Plan D'])
    expect(scoped.turns.filter(turn => turn.type === 'user')).toHaveLength(2)
  })

  it('treats an unanswered submitted plan as awaiting approval, not an interruption', () => {
    const messages = [user, message('t2', 'tool', { toolName: 'SubmitPlan', toolStatus: 'completed', toolResult: 'Plan submitted' }),
      message('p3', 'plan', { content: 'Plan à approuver' })]
    const waiting = projectConversation(messages, { isProcessing: false, activeObjective: objective() })
    expect(waiting.progress?.state).toBe('waiting')
    expect(waiting.outcome).toBeUndefined()
    expect(waiting.turns.find(turn => turn.type === 'assistant')).toMatchObject({ activities: [{ type: 'plan' }] })
    for (const after of [message('u4', 'user'), message('t4', 'tool'), message('a4', 'assistant'), message('e4', 'error')]) {
      expect(projectConversation([...messages, after], { isProcessing: false }).progress).toBeUndefined()
    }
    for (const terminalState of ['complete_verified', 'exhausted'] as const) {
      const terminal = projectConversation(messages, { isProcessing: false, activeObjective: objective({ terminalState }) })
      expect(terminal.progress).toBeUndefined()
      expect(terminal.outcome).toBeDefined()
    }
  })

  it('keeps the actual final question visible while awaiting input for a host-confirmed blocker', () => {
    for (const terminalState of ['blocked_human', 'blocked_policy'] as const) {
      const question = message('a2', 'assistant', { content: 'Quel périmètre dois-je inclure ?' })
      const result = projectConversation([user, question], {
        isProcessing: false, awaitingInput: true, activeObjective: objective({ terminalState }),
      })
      expect(finals(result.turns)).toEqual([question.content])
      expect(result.progress?.state).toBe('waiting')
      expect(result.outcome).toBeUndefined()
      expect(finals(projectConversation([user, question], {
        isProcessing: true, awaitingInput: true, activeObjective: objective({ terminalState }),
      }).turns)).toEqual([])
    }
  })

  it('reports blocked or successful host outcomes even when no final response exists', () => {
    for (const [terminalState, state] of [['blocked_human', 'blocked'], ['blocked_policy', 'blocked'], ['complete_verified', 'succeeded']] as const) {
      const result = projectConversation([user], { isProcessing: false, activeObjective: objective({ terminalState,
        lastOutcome: { state: terminalState === 'complete_verified' ? 'complete_verified' : terminalState,
          criteria: [], remainingWork: ['Vérifier la livraison'], blocker: null },
      }) })
      expect(result.outcome).toMatchObject({ state, hasFinalResponse: false, remainingWork: ['Vérifier la livraison'] })
    }
  })

  it('presents a persisted exhausted continuation as interrupted with its preserved remaining work', () => {
    const activeObjective = JSON.parse(JSON.stringify(objective({
      terminalState: 'exhausted',
      interruptedTurnRecovery: {
        objectiveId: 'u1', userMessageId: 'u1',
        recovery: {
          userMessageId: 'u1', startedAt: 1, leaseExpiresAt: 100, attempts: 2,
          exhaustedAt: 3, lastCause: 'stream_ended', continuationOrigin: 'objective_continue',
          continuationWork: ['Vérifier le candidat installé'],
        },
      },
    }))) as ActiveSessionObjective
    const result = projectConversation([user, message('e3', 'error', { content: 'Transport unavailable' })], {
      isProcessing: false, activeObjective,
    })

    expect(result.outcome).toMatchObject({
      state: 'interrupted',
      remainingWork: ['Vérifier le candidat installé'],
      retryUserMessageId: 'u1',
    })
    expect(activeObjective.terminalState).toBe('exhausted')
    expect(activeObjective.lastOutcome).toBeUndefined()

    const unrelated = objective({ terminalState: 'exhausted',
      interruptedTurnRecovery: {
        objectiveId: 'u1', userMessageId: 'u1',
        recovery: {
          userMessageId: 'u1', startedAt: 1, leaseExpiresAt: 100, attempts: 2,
          exhaustedAt: 3, lastCause: 'premature_final',
          continuationWork: ['Untrusted prose-derived work'],
        },
      },
    })
    expect(projectConversation([user], { isProcessing: false, activeObjective: unrelated }).outcome)
      .toMatchObject({ state: 'failed', remainingWork: [] })
  })

  it('stops every plan spinner in an outcome without checking unfinished rows', () => {
    for (const terminalState of ['exhausted', 'blocked_human', 'complete_verified'] as const) {
      const result = projectConversation([user, plan('t2')], { isProcessing: false, activeObjective: objective({ terminalState }) })
      expect(result.outcome?.steps?.map(step => step.status)).toEqual(['completed', 'interrupted', 'pending'])
    }
    expect(projectConversation([user, plan('t2')], { isProcessing: true }).progress?.steps.map(step => step.status))
      .toEqual(['completed', 'in_progress', 'pending'])
  })

  it('does not mutate the input transcript, plan items or objective', () => {
    const messages = [user, plan('t2'), message('a3', 'assistant')]
    const activeObjective = objective({ terminalState: 'complete_verified' })
    const before = JSON.stringify({ messages, activeObjective })
    const result = projectConversation(messages, { isProcessing: false, activeObjective })
    result.outcome!.steps![0]!.status = 'pending'
    result.outcome!.remainingWork.push('Other')
    expect(JSON.stringify({ messages, activeObjective })).toBe(before)
  })
});
