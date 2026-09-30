import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core'
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions'
import { projectConversation } from '../conversation-presentation'

function message(id: string, role: Message['role'], extra: Partial<Message> = {}): Message {
  return { id, role, content: id, timestamp: Number(id.replace(/\D/g, '')) || 1, ...extra }
}

function objective(extra: Partial<ActiveSessionObjective> = {}): ActiveSessionObjective {
  return {
    schemaVersion: 1, userMessageId: 'u1', objectiveId: 'u1', lastUserMessageId: 'u1',
    originalText: 'Préparer et vérifier le rapport.', startedAt: 1,
    budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
    orchestrationMode: 'mission', risk: 'standard', terminalState: 'active', completionCriteria: [],
    ...extra,
  }
}

function plan(id: string, toolName = 'TodoWrite', extra: Partial<Message> = {}): Message {
  const rows = [
    { content: 'Préparer le rapport', status: 'completed' },
    { content: 'Vérifier le rendu', status: 'in_progress', activeForm: 'Vérification du rendu' },
    { content: 'Livrer le rapport', status: 'pending' },
  ]
  return message(id, 'tool', {
    toolName, toolStatus: 'completed', toolExecuted: true, toolResult: 'Plan updated',
    toolInput: toolName.includes('update_plan') ? { plan: rows.map(row => ({ step: row.content, status: row.status })) } : { todos: rows },
    ...extra,
  })
}

const user = message('u1', 'user', { content: 'Préparer et vérifier le rapport.' })
const finals = (turns: ReturnType<typeof projectConversation>['turns']) => turns.flatMap(turn =>
  turn.type === 'assistant' && turn.response ? [turn.response.text] : [])

describe('quiet conversation presentation', () => {
  it('keeps a completed deliverable visible through receipt demotion, automatic checks and the final summary', () => {
    const deliverable = Array.from({ length: 300 }, (_, index) => `${index + 1} : REPRISE-OK`).join('\n')
    const produced = message('a3', 'assistant', { content: deliverable, isIntermediate: true,
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [], blocker: null } })
    const messages = [user, message('i2', 'info', { content: 'Response interrupted' }), produced,
      message('u4', 'user', { hidden: true, content: '<automatic_turn_recovery>' }),
      message('a5', 'assistant', { content: 'Les lignes sont produites ; je vérifie leur conformité.', isIntermediate: true }),
      message('t6', 'tool', { toolName: 'mcp__session__call_llm', toolStatus: 'executing' }),
    ]
    const options = { isProcessing: true, activeObjective: objective(),
      pendingTurnRecovery: { userMessageId: 'u1', attempts: 1, lastCause: 'objective_incomplete' } }
    const checking = projectConversation(messages, options)
    expect(finals(checking.turns)).toEqual([deliverable])
    expect(checking.progress).toBeDefined()
    expect(checking.outcome).toBeUndefined()
    expect(checking.turns.filter(turn => turn.type === 'user')).toHaveLength(1)
    expect(finals(checking.turns)[0]!.split('\n')).toHaveLength(300)
    const verified = projectConversation([...messages, message('a7', 'assistant', { content: 'Les 300 lignes sont vérifiées.' })], {
      isProcessing: false, activeObjective: objective({ terminalState: 'complete_verified' }),
    })
    expect(finals(verified.turns)).toEqual([deliverable, 'Les 300 lignes sont vérifiées.'])
    expect(verified.outcome?.state).toBe('succeeded')
  })

  it('deduplicates repeated produced text and keeps it before a newer clarification', () => {
    const produced = message('a2', 'assistant', { content: 'Le livrable complet.', isIntermediate: true,
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [] } })
    const copy = { ...produced, id: 'a3', timestamp: 3 }
    expect(finals(projectConversation([user, produced, copy], { isProcessing: true, activeObjective: objective() }).turns))
      .toEqual([produced.content])
    expect(finals(projectConversation([user, produced, { ...copy, isIntermediate: false }], {
      isProcessing: false, activeObjective: objective({ terminalState: 'complete_verified' }),
    }).turns)).toEqual([produced.content])
    const clarified = projectConversation([user, produced, message('u4', 'user', { content: 'Change le format.' })], {
      isProcessing: true, activeObjective: objective({ lastUserMessageId: 'u4' }),
    })
    expect(finals(clarified.turns)).toEqual([produced.content])
    expect(clarified.turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    expect(clarified.outcome).toBeUndefined()
  })

  it('keeps a historical deliverable and summary before a new request without reusing its successful outcome', () => {
    const produced = message('a2', 'assistant', { content: 'Le livrable complet.', isIntermediate: true,
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [] } })
    const summary = message('a3', 'assistant', { content: 'Livrable vérifié.' })
    const next = message('u4', 'user', { content: 'Une nouvelle demande.' })
    const messages = [user, produced, summary, next]
    for (const activeObjective of [objective({ terminalState: 'complete_verified' }),
      objective({ userMessageId: 'u4', objectiveId: 'u4', lastUserMessageId: 'u4', originalText: next.content, startedAt: 4 })]) {
      const result = projectConversation(messages, { isProcessing: true, activeObjective })
      expect(finals(result.turns)).toEqual([produced.content, summary.content])
      expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'assistant', 'user'])
      expect(result.turns.at(-1)).toMatchObject({ type: 'user', message: { id: 'u4' } })
      expect(result.progress?.state).toBe('running')
      expect(result.outcome).toBeUndefined()
    }
    const failed = projectConversation([...messages, message('e5', 'error')], { isProcessing: false,
      activeObjective: objective({ userMessageId: 'u4', objectiveId: 'u4', lastUserMessageId: 'u4',
        originalText: next.content, startedAt: 4, terminalState: 'exhausted' }),
    })
    expect(finals(failed.turns)).toEqual([produced.content, summary.content])
    expect(failed.outcome).toMatchObject({ state: 'failed', hasFinalResponse: false,
      objectiveText: next.content, retryUserMessageId: 'u4' })
  })

  it('deduplicates produced copies within each request without erasing identical answers to different requests', () => {
    const produced = message('a2', 'assistant', { content: 'Même livrable.', isIntermediate: true,
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [] } })
    const result = projectConversation([user, produced, { ...produced, id: 'a3', timestamp: 3 },
      message('u4', 'user', { content: 'Redonne le même texte.' }),
      { ...produced, id: 'a5', timestamp: 5 }, { ...produced, id: 'a6', timestamp: 6 },
    ], { isProcessing: true, activeObjective: objective({ userMessageId: 'u4', objectiveId: 'u4', lastUserMessageId: 'u4' }) })
    expect(finals(result.turns)).toEqual([produced.content, produced.content])
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(result.outcome).toBeUndefined()
  })

  it('does not treat partial streams, ongoing declarations or private worker reports as produced deliverables', () => {
    const produced = message('a2', 'assistant', { content: 'Résultat à masquer.', isIntermediate: true,
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [] } })
    for (const patch of [{ isStreaming: true }, { isPending: true }, { parentToolUseId: 'child' }, { hidden: true },
      { internalOrigin: { kind: 'agent-message' as const, senderSessionId: 'child' } },
      { objectiveOutcome: { state: 'continue' as const, criteria: [], remainingWork: ['Finir'] } },
    ]) {
      expect(finals(projectConversation([user, { ...produced, ...patch }], { isProcessing: true, activeObjective: objective() }).turns))
        .toEqual([])
    }
  })

  it('shows the latest typed validation causes without validating the claimed result or changing the retry anchor', () => {
    const result = projectConversation([user, message('a2', 'assistant', { content: 'Rapport rédigé.', isIntermediate: true,
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [] } }),
      message('e3', 'error', { errorCode: 'objective_validation_failed', errorDetails: [
        'criterion lacks observed evidence: relevant-checks-passed',
        'missing criterion: no-safe-work-remaining',
      ] }),
    ], { isProcessing: false, activeObjective: objective({ terminalState: 'exhausted' }),
      pendingTurnRecovery: { userMessageId: 'u1', lastCause: 'objective_incomplete', validationGaps: ['OLD GAP'] } })
    expect(result.outcome).toMatchObject({ state: 'failed', hasFinalResponse: true, retryUserMessageId: 'u1', validationGaps: [
      'criterion lacks observed evidence: relevant-checks-passed', 'missing criterion: no-safe-work-remaining',
    ] })
    expect(finals(result.turns)).toEqual(['Rapport rédigé.'])
  })

  it('supports current legacy recovery gaps and rejects snapshots from another request or an earlier clarification', () => {
    const recovery = { userMessageId: 'u1', lastCause: 'objective_incomplete', validationGaps: ['missing structured objective outcome receipt'], exhaustedAt: 4 }
    const options = { isProcessing: false, activeObjective: objective({ terminalState: 'exhausted' }), pendingTurnRecovery: recovery }
    expect(projectConversation([user], options).outcome?.validationGaps).toEqual(recovery.validationGaps)
    expect(projectConversation([user, message('e4', 'error', {
      content: 'Automatic continuation stopped because the completion contract still could not be validated within the retry limit. Completed work was preserved.',
    })], options).outcome?.validationGaps).toEqual(recovery.validationGaps)
    expect(projectConversation([user, message('u3', 'user')], options).outcome?.validationGaps).toBeUndefined()
    const clarified = { ...options, activeObjective: objective({ lastUserMessageId: 'u3', terminalState: 'exhausted' }) }
    expect(projectConversation([user, message('u3', 'user')], clarified).outcome?.validationGaps).toBeUndefined()
    expect(projectConversation([user, message('u3', 'user')], { ...clarified, pendingTurnRecovery: { ...recovery, lastAttemptAt: 4 } }).outcome?.validationGaps)
      .toEqual(recovery.validationGaps)
    expect(projectConversation([user], { ...options, pendingTurnRecovery: { ...recovery, userMessageId: 'another-request' } }).outcome?.validationGaps).toBeUndefined()
  })

  it('does not retain validation diagnostics after a later success, unrelated error, or new attempt', () => {
    const error = message('e2', 'error', { errorCode: 'objective_validation_failed', errorDetails: ['old gap'] })
    const recovery = { userMessageId: 'u1', lastCause: 'objective_incomplete', validationGaps: ['old gap'], exhaustedAt: 2 }
    const options = { isProcessing: false, activeObjective: objective({ terminalState: 'exhausted' }), pendingTurnRecovery: recovery }
    const success = projectConversation([user, error, message('a3', 'assistant')], { ...options, activeObjective: objective({ terminalState: 'complete_verified' }) })
    expect(success.outcome?.state).toBe('succeeded')
    expect(success.outcome?.validationGaps).toBeUndefined()
    expect(projectConversation([user, error, message('e3', 'error', { errorCode: 'network_error' })], options).outcome?.validationGaps).toBeUndefined()
    expect(projectConversation([user, error, message('e3', 'error', { content: 'Unrelated connection failure' })], options).outcome?.validationGaps).toBeUndefined()
    expect(projectConversation([user, error], { ...options, isProcessing: true }).outcome).toBeUndefined()
    expect(projectConversation([user, { ...error, internalOrigin: { kind: 'agent-message', senderSessionId: 'child' } }], { isProcessing: false }).outcome?.validationGaps).toBeUndefined()
  })

  it('bounds, deduplicates and renders validation reasons as safe plain text', () => {
    const details = ['criterion lacks observed evidence: review', 'criterion lacks observed evidence: review',
      '  ', `Token: ${['sk-test', 'secret1234567890'].join('')} <img src=x onerror=bad>`, 'x'.repeat(800),
      ...Array.from({ length: 30 }, (_, index) => `gap ${index}`),
    ]
    const result = projectConversation([user, message('e2', 'error', { errorCode: 'objective_validation_failed', errorDetails: details })], { isProcessing: false })
    expect(result.outcome?.validationGaps?.length).toBeLessThanOrEqual(16)
    expect(result.outcome?.validationGaps?.every(gap => gap.length <= 500)).toBe(true)
    expect(result.outcome?.validationGaps?.filter(gap => gap.includes('review'))).toHaveLength(1)
    expect(JSON.stringify(result.outcome?.validationGaps)).not.toContain('sk-testsecret')
    expect(JSON.stringify(result.outcome?.validationGaps)).not.toContain('<img')
  })

  it('keeps an idle parent report readable beside a stale recovery marker without declaring success', () => {
    const options = { isProcessing: false, activeObjective: objective(),
      pendingTurnRecovery: { userMessageId: 'u1', attempts: 1, lastCause: 'objective_incomplete', lastAttemptAt: 1 } }
    const response = message('a2', 'assistant', { content: 'Rapport disponible, validation à terminer.' })
    const result = projectConversation([user, response], options)
    expect(finals(result.turns)).toEqual([response.content])
    expect(result.progress?.state).toBe('recovering')
    expect(result.outcome).toBeUndefined()
    // A real later recovery dispatch still makes the earlier answer provisional.
    const resumed = projectConversation([user, response,
      message('u3', 'user', { hidden: true, content: '<automatic_turn_recovery>' })], options)
    expect(finals(resumed.turns)).toEqual([])
  })

  it('keeps a completed report readable during receipt repair, child activity and later history', () => {
    const options = { isProcessing: false, hasActiveDescendants: true, activeObjective: objective() }
    const report = message('a2', 'assistant', { content: 'Le document est prêt à relire.', isIntermediate: true,
      objectiveOutcomeError: 'malformed objective outcome receipt' })
    const result = projectConversation([user, report], options)
    expect(finals(result.turns)).toEqual([report.content])
    expect(result.outcome).toBeUndefined()
    expect(result.progress).toBeDefined()
    const resumed = projectConversation([user, report, message('t3', 'tool', { toolName: 'Read' })], options)
    expect(finals(resumed.turns)).toEqual([report.content])
    expect(resumed.outcome).toBeUndefined()
    const active = projectConversation([user, report,
      message('u3', 'user', { hidden: true, content: '<automatic_turn_recovery>' }),
      message('a4', 'assistant', { isIntermediate: true, content: 'Je vérifie le format.' }),
    ], { ...options, isProcessing: true })
    expect(finals(active.turns)).toEqual([report.content])
    expect(active.outcome).toBeUndefined()
    const history = projectConversation([user, report, message('u4', 'user', { content: 'Nouvelle demande.' })], {
      isProcessing: true, activeObjective: objective({ userMessageId: 'u4', lastUserMessageId: 'u4' }),
    })
    expect(history.turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    expect(history.outcome).toBeUndefined()
    for (const patch of [{ isStreaming: true }, { isPending: true }, { hidden: true }, { parentToolUseId: 'child' }]) {
      expect(finals(projectConversation([user, { ...report, ...patch }], { isProcessing: true }).turns)).toEqual([])
    }
  })

  it('passes only confirmed plan activity to the progress view', () => {
    const result = projectConversation([user, plan('t2')], { isProcessing: true })
    expect(result.progress?.activity).toMatchObject({ source: 'plan', completedSteps: 1, totalSteps: 3 })
  })

  it('offers an anchored retry after an interruption even if the objective was marked complete', () => {
    const result = projectConversation([user, message('a2', 'assistant', { content: 'Bilan enregistré.' }),
      message('i3', 'info', { content: 'Response interrupted' }),
    ], { isProcessing: false, activeObjective: objective({ terminalState: 'complete_verified' }) })
    expect(result.outcome).toMatchObject({ state: 'interrupted', retryUserMessageId: 'u1' })
    expect(result.turns.filter(turn => turn.type === 'user')).toHaveLength(1)
  })

  it('retries the latest accepted clarification and ignores hidden nudges and queued follow-ups', () => {
    const result = projectConversation([user,
      message('u2', 'user', { content: 'Conserver le travail déjà fait.' }),
      message('u3', 'user', { hidden: true, content: '<automatic_turn_recovery>' }),
      message('e4', 'error', { content: 'Stopped' }),
      message('u5', 'user', { isQueued: true, content: 'Demande encore en attente.' }),
    ], { isProcessing: false, activeObjective: objective({ lastUserMessageId: 'u2', terminalState: 'exhausted' }) })
    expect(result.outcome).toMatchObject({ state: 'failed', retryUserMessageId: 'u2' })
  })

  it('offers retry for an interrupted legacy conversation without requiring a new message', () => {
    const result = projectConversation([user, message('i2', 'info', { content: 'Réponse interrompue' })], { isProcessing: false })
    expect(result.outcome).toMatchObject({ state: 'interrupted', retryUserMessageId: 'u1' })
  })

  it('removes the retry once a later verified response resolves the interruption', () => {
    const result = projectConversation([user, message('i2', 'info', { content: 'Response interrupted' }),
      message('a3', 'assistant', { content: 'Travail terminé et vérifié.' }),
    ], { isProcessing: false, activeObjective: objective({ terminalState: 'complete_verified' }) })
    expect(result.outcome?.state).toBe('succeeded')
    expect(result.outcome?.retryUserMessageId).toBeUndefined()
  })

  it('lets a new error override an earlier completed flag without demoting a later verified final', () => {
    const options = { isProcessing: false, activeObjective: objective({ terminalState: 'complete_verified' }),
      pendingTurnRecovery: { userMessageId: 'u1', attempts: 5, exhaustedAt: 4 } }
    const messages = [user, message('a2', 'assistant', { content: 'Bilan enregistré.' }), message('e3', 'error')]
    expect(projectConversation(messages, options).outcome)
      .toMatchObject({ state: 'failed', retryUserMessageId: 'u1' })
    const resolved = projectConversation([...messages, message('a4', 'assistant', { content: 'Résultat vérifié.' })], options)
    expect(resolved.outcome?.state).toBe('succeeded')
    expect(resolved.outcome?.retryUserMessageId).toBeUndefined()
  })

  it('never exposes an old error as a retry of a new request or retries while working', () => {
    const messages = [user, message('e2', 'error'), message('u3', 'user', { content: 'Nouvelle demande' })]
    expect(projectConversation(messages, { isProcessing: false }).outcome?.retryUserMessageId).toBeUndefined()
    const running = projectConversation([user, message('e2', 'error')], { isProcessing: true })
    expect(running.progress).toBeDefined()
    expect(running.outcome).toBeUndefined()
  })

  it('does not invent a retry anchor when only queued or internal requests are loaded', () => {
    for (const candidate of [message('u1', 'user', { isQueued: true }), message('u1', 'user', { hidden: true }), message('u1', 'user', { isPending: true })]) {
      const result = projectConversation([candidate, message('e2', 'error')], { isProcessing: false })
      expect(result.outcome?.retryUserMessageId).toBeUndefined()
    }
  })

  it('offers retry for the exact initial delegation of an interrupted child without exposing internal messages', () => {
    const delegated = message('u1', 'user', { internalOrigin: { kind: 'spawned-session', senderSessionId: 'parent' } })
    const options = { isProcessing: false, sessionId: 'child', parentSessionId: 'parent', activeObjective: objective() }
    const messages = [delegated, message('i2', 'info', { content: 'Response interrupted' })]
    const result = projectConversation(messages, options)
    expect(result.outcome).toMatchObject({ state: 'interrupted', retryUserMessageId: 'u1' })
    expect(result.turns.some(turn => turn.type === 'user')).toBe(false)
    expect(projectConversation(messages, { ...options, isProcessing: true }).outcome).toBeUndefined()
    const completed = projectConversation([delegated, message('a3', 'assistant')], {
      ...options, activeObjective: objective({ terminalState: 'complete_verified' }),
    })
    expect(completed.outcome?.state).toBe('succeeded')
    expect(completed.outcome?.retryUserMessageId).toBeUndefined()
  })

  it('rejects untrusted, incomplete and noninitial delegation retry anchors', () => {
    const delegated = message('u1', 'user', { internalOrigin: { kind: 'spawned-session', senderSessionId: 'parent' } })
    const options = { isProcessing: false, sessionId: 'child', parentSessionId: 'parent', activeObjective: objective({ terminalState: 'exhausted' }) }
    for (const patch of [
      { hidden: true }, { isQueued: true }, { isPending: true },
      { internalOrigin: { kind: 'spawned-session' as const, senderSessionId: 'other-parent' } },
      { internalOrigin: { kind: 'agent-message' as const, senderSessionId: 'parent' } },
      { internalOrigin: { kind: 'user-input' as const, senderSessionId: 'parent' } },
    ]) {
      expect(projectConversation([{ ...delegated, ...patch }], options).outcome?.retryUserMessageId).toBeUndefined()
    }
    for (const patch of [
      { sessionId: undefined }, { parentSessionId: undefined }, { parentSessionId: '' }, { parentSessionId: 'child' },
      { activeObjective: undefined },
      { activeObjective: objective({ userMessageId: 'another-objective' }) },
      { activeObjective: { ...objective(), objectiveId: undefined } },
      { activeObjective: objective({ objectiveId: 'another-objective' }) },
    ]) {
      expect(projectConversation([delegated, message('e3', 'error')], { ...options, ...patch }).outcome?.retryUserMessageId).toBeUndefined()
    }
    const priorInternal = message('u0', 'user', { timestamp: 0, internalOrigin: { kind: 'agent-message', senderSessionId: 'parent' } })
    expect(projectConversation([priorInternal, delegated], options).outcome?.retryUserMessageId).toBeUndefined()
  })

  it('prefers the latest accepted human clarification over an initial delegation', () => {
    const delegated = message('u1', 'user', { internalOrigin: { kind: 'spawned-session', senderSessionId: 'parent' } })
    const messages = [delegated, message('u2', 'user'), message('i3', 'info', { content: 'Response interrupted' }),
      message('u4', 'user', { internalOrigin: { kind: 'agent-message', senderSessionId: 'parent' } }),
      message('u5', 'user', { isPending: true })]
    const result = projectConversation(messages, { isProcessing: false, sessionId: 'child', parentSessionId: 'parent',
      activeObjective: objective({ lastUserMessageId: 'u2' }) })
    expect(result.outcome).toMatchObject({ state: 'interrupted', retryUserMessageId: 'u2' })
    expect(result.turns.filter(turn => turn.type === 'user').map(turn => turn.message.id)).toEqual(['u2', 'u5'])
  })

  const legacyUserId = 'msg-1788800000000-abc123'
  const legacyContract = `<host_objective_contract objective_user_message_id="${legacyUserId}" orchestration="mission" risk="standard">\nCompletion criteria: requested-outcome-delivered, relevant-checks-passed, no-safe-work-remaining.\nContinue through every safe in-scope step. A progress report, proposed next action, or partially created deliverable is not a terminal result.\nBefore ending, evaluate the objective as exactly one of: complete_verified, blocked_human, blocked_policy, continue.\n</host_objective_contract>`

  it('hides only recognized legacy runtime suffixes without changing messages or metadata', () => {
    const human = 'Vérifie le rapport.\n\n```txt\nConserver ce code.\n```'
    const content = `${human}\n\n${legacyContract}\n\n[ingenierie-son activated]\n\n${legacyContract}\n\n[documents activated]`
    const input = message(legacyUserId, 'user', { content,
      annotations: [{ id: 'note', schemaVersion: 1, createdAt: 1, body: [{ type: 'note', text: 'Conserver cette note' }],
        target: { source: { sessionId: 'session', messageId: legacyUserId }, selectors: [{ type: 'text-quote', exact: 'Vérifie le rapport.' }] } }],
      attachments: [{ id: 'attachment', type: 'text', name: 'rapport.txt', mimeType: 'text/plain', size: 4, storedPath: '/tmp/rapport.txt' }],
    })
    const result = projectConversation([input], { isProcessing: false, activeObjective: objective({
      userMessageId: legacyUserId, lastUserMessageId: legacyUserId,
      originalText: content, terminalState: 'exhausted',
    }) })
    const turn = result.turns[0]!
    expect(turn.type).toBe('user')
    if (turn.type !== 'user') throw new Error('Expected user turn')
    expect(turn.message).toEqual({ ...input, content: human })
    expect(turn.message.annotations).toBe(input.annotations)
    expect(turn.message.attachments).toBe(input.attachments)
    expect(input.content).toBe(content)
    expect(result.outcome?.objectiveText).toBe(human)
  })

  it('removes a known terminal host envelope without requiring an activation suffix', () => {
    const input = message(legacyUserId, 'user', { content: `Merci de continuer.\n\n${legacyContract}` })
    const result = projectConversation([input], { isProcessing: false })
    expect(result.turns[0]).toMatchObject({ type: 'user', message: { id: legacyUserId, content: 'Merci de continuer.' } })
  })

  it('preserves quoted code, unrecognized contracts, human follow-ups and standalone activation text', () => {
    const contents = [
      `Explique ce code :\n\n\`\`\`xml\n${legacyContract}\n\`\`\``,
      `Explique ce code :\n\n~~~xml\n${legacyContract}\n\n[documents activated]`,
      `Citation :\n\n> ${legacyContract.replace(/\n/g, '\n> ')}`,
      `Citation : \`${legacyContract}\``,
      `Explique ce bloc.\n\n${legacyContract.replace('risk="standard"', 'risk="other"')}`,
      `Explique ce bloc.\n\n${legacyContract.replace(' orchestration="mission"', ' extra="value" orchestration="mission"')}`,
      `Explique ce bloc.\n\n${legacyContract.replace(legacyUserId, 'msg-1788800000000-unknown')}`,
      `Explique ce bloc.\n\n${legacyContract.replace('Before ending, evaluate', 'Unrecognized body, evaluate')}`,
      `Explique ce bloc.\n\n${legacyContract}\n\nConserve aussi cette phrase humaine.`,
      'Conserve [documents activated]',
    ]
    for (const content of contents) {
      const input = message(legacyUserId, 'user', { content })
      const result = projectConversation([input], { isProcessing: false, activeObjective: objective({
        userMessageId: legacyUserId, lastUserMessageId: legacyUserId, originalText: content, terminalState: 'exhausted',
      }) })
      expect(result.turns[0]).toMatchObject({ type: 'user', message: { content } })
      expect(result.outcome?.objectiveText).toBe(content)
    }
  })

  it('shows human requests and only the latest real final, hiding routine activity', () => {
    const messages = [user, message('a2', 'assistant', { isIntermediate: true }),
      message('t3', 'tool'), message('w4', 'warning'), message('i5', 'info'),
      message('a6', 'assistant', { content: 'Provisional final' }), message('a7', 'assistant', { content: 'Final report' })]
    const result = projectConversation(messages, { isProcessing: false, activeObjective: objective({ terminalState: 'complete_verified' }) })
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    expect(finals(result.turns)).toEqual(['Final report'])
    expect(result.outcome).toMatchObject({ state: 'succeeded', hasFinalResponse: true, objectiveText: user.content })
    expect(result.turns.filter(turn => turn.type === 'assistant').every(turn => turn.activities.length === 0)).toBe(true)
  })

  it('never promotes commentary or partial streaming text into a final after quota failure', () => {
    const result = projectConversation([user,
      message('a2', 'assistant', { content: 'Je lance les vérifications.', isIntermediate: true }),
      message('a3', 'assistant', { content: 'Texte partiel', isStreaming: true, isPending: true }),
      message('e4', 'error', { errorCode: 'rate_limit', content: 'Quota exceeded; raw provider log' }),
    ], { isProcessing: false, activeObjective: objective({ terminalState: 'exhausted' }) })
    expect(finals(result.turns)).toEqual([])
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'system'])
    expect(result.outcome).toMatchObject({ state: 'failed', hasFinalResponse: false })
  })

  it('removes a provisional final before a terminal error but preserves a later real failure report', () => {
    const messages = [user, message('a2', 'assistant', { content: 'Tout est prêt.' }),
      message('e3', 'error', { content: 'Quota exceeded' })]
    const options = { isProcessing: false, activeObjective: objective({ terminalState: 'exhausted' }) }
    const failed = projectConversation(messages, options)
    expect(finals(failed.turns)).toEqual([])
    expect(failed.outcome).toMatchObject({ state: 'failed', hasFinalResponse: false })
    const explained = projectConversation([...messages,
      message('a4', 'assistant', { content: 'Le rapport reste incomplet : la vérification a échoué.' }),
    ], options)
    expect(finals(explained.turns)).toEqual(['Le rapport reste incomplet : la vérification a échoué.'])
    expect(explained.outcome).toMatchObject({ state: 'failed', hasFinalResponse: true })
  })

  it('replaces provisional finals across objective clarifications and durable recovery with one progress state', () => {
    const messages = [user, plan('t2'), message('a3', 'assistant'),
      message('u4', 'user', { content: 'Le document reste illisible.' }),
      message('a5', 'assistant', { content: 'Encore une réponse provisoire.' }),
      message('u6', 'user', { hidden: true, content: '<automatic_turn_recovery>' }),
    ]
    const options = { isProcessing: false, activeObjective: objective({ lastUserMessageId: 'u4', continuationCount: 1 }),
      pendingTurnRecovery: { userMessageId: 'u4', attempts: 2, lastCause: 'objective_incomplete' } }
    const result = projectConversation(messages, options)
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'user'])
    expect(result.progress).toMatchObject({ state: 'recovering', phase: 'checking' })
    expect(result.progress?.steps.map(step => step.status)).toEqual(['completed', 'in_progress', 'pending'])
    expect(result.outcome).toBeUndefined()
    const done = projectConversation([...messages, message('a7', 'assistant', { content: 'Rapport rendu et livré.' })], {
      isProcessing: false, activeObjective: objective({ lastUserMessageId: 'u4', terminalState: 'complete_verified' }),
    })
    expect(finals(done.turns)).toEqual(['Rapport rendu et livré.'])
    expect(done.outcome?.steps?.[2]?.status).toBe('pending')
  })

  it('hides internal deliveries, child results and their finals without creating human segments', () => {
    const result = projectConversation([user,
      message('u2', 'user', { internalOrigin: { kind: 'agent-message', senderSessionId: 'child' } }),
      message('a3', 'assistant', { content: 'Child summary', parentToolUseId: 'task' }),
      plan('t4', 'TodoWrite', { parentToolUseId: 'task' }),
      message('a5', 'assistant', { content: 'Parent final' }),
      message('t6', 'tool', { toolName: 'mcp__session__send_agent_message', toolStatus: 'completed', toolResult: 'delivered' }),
    ], { isProcessing: false })
    expect(finals(result.turns)).toEqual(['Parent final'])
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    expect(result.outcome?.steps).toBeUndefined()
    expect(result.outcome).toBeUndefined()
  })

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
})


describe('resolved connection requests', () => {
  it('removes completed connection details from the ordinary conversation', () => {
    const result = projectConversation([user,
      message('auth2', 'auth-request', { authStatus: 'completed', content: 'Connected account details' }),
      message('a3', 'assistant', { content: 'Voici votre réponse.' }),
    ], { isProcessing: false })
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    expect(result.outcome).toBeUndefined()
  })
  it('summarizes a failed connection without exposing its technical error', () => {
    const result = projectConversation([user,
      message('auth2', 'auth-request', { authStatus: 'failed', content: 'OAuth stack trace' }),
    ], { isProcessing: false })
    expect(result.turns.map(turn => turn.type)).toEqual(['user'])
    expect(result.outcome).toMatchObject({ state: 'failed', hasFinalResponse: false })
  })
})

it('keeps the live MCP checklist through composing, failed updates and transcript reload', () => {
  const messages = [user, plan('t2', 'mcp__session__update_plan'),
    message('s3', 'status', { content: 'Le modèle élabore la réponse' })]
  const first = projectConversation(messages, { isProcessing: true })
  expect(first.progress?.steps.map(step => step.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(first.progress?.activity?.title).toBe('Vérifier le rendu')
  const next = plan('t4', 'mcp__session__update_plan', { toolInput: { plan: [
    { step: 'Préparer le rapport', status: 'completed' },
    { step: 'Vérifier le rendu', status: 'completed' },
    { step: 'Livrer le rapport', status: 'in_progress' },
  ], explanation: 'Le rendu est vérifié. Je prépare la livraison.' } })
  messages.push(next, plan('t5', 'mcp__session__update_plan', { isError: true, toolInput: { plan: [] } }))
  const reloaded = projectConversation(JSON.parse(JSON.stringify(messages)), { isProcessing: true })
  expect(reloaded.progress?.steps.map(step => step.status)).toEqual(['completed', 'completed', 'in_progress'])
  expect(reloaded.progress?.activity?.title).toBe('Le rendu est vérifié. Je prépare la livraison.')
  expect(reloaded.outcome).toBeUndefined()
})
