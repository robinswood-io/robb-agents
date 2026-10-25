import { describe, expect, it } from "bun:test";
import { projectConversation } from "../conversation-presentation";
import { finals, message, objective, plan, user } from "./testing/conversation-presentation-fixture.ts";

describe('quiet conversation presentation', () => {
  const legacyUserId = 'msg-1788800000000-abc123'

  const legacyContract = `<host_objective_contract objective_user_message_id="${legacyUserId}" orchestration="mission" risk="standard">\nCompletion criteria: requested-outcome-delivered, relevant-checks-passed, no-safe-work-remaining.\nContinue through every safe in-scope step. A progress report, proposed next action, or partially created deliverable is not a terminal result.\nBefore ending, evaluate the objective as exactly one of: complete_verified, blocked_human, blocked_policy, continue.\n</host_objective_contract>`

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
});
