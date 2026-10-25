import { permissionMetadataFixture } from "./testing/permission-metadata.ts";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from "@craft-agent/core";
import { type Managed, deferred, harness, ids, roots } from "./testing/retry-turn-fixture.ts";

afterEach(() => {
  ids.splice(0).forEach(clearObjectiveEvidenceGate)
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

describe('explicit retry of an existing turn', () => {
  it('serializes duplicate clicks through durable acceptance and starts exactly one existing turn', async () => {
    const h = harness()
    const flush = deferred()
    h.internals.flushSession = () => flush.promise
    let accepted = 0
    const first = h.manager.retryTurn(h.managed.id, 'latest-user').then(result => { accepted++; return result })
    const second = h.manager.retryTurn(h.managed.id, 'latest-user').then(result => { accepted++; return result })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(accepted).toBe(0)
    flush.resolve()
    try {
      expect(await first).toEqual({ status: 'started' })
      expect(await second).toEqual({ status: 'already_running' })
      expect(h.managed.processingGeneration).toBe(1)
      expect(h.managed.messages.filter(message => message.role === 'user')).toHaveLength(2)
    } finally { await h.finish() }
  })

  it('delivers read-only proof recovery on retry while retaining the completed write, corrupt read, and exhausted budget', async () => {
    const h = harness()
    h.managed.messages.splice(2, 0, {
      id: 'corrupt-read', role: 'tool', content: 'Stored observation', timestamp: 2,
      toolName: 'Read', toolUseId: 'read-1', toolStatus: 'completed', toolExecuted: true,
      toolResult: '{"ok":tru',
    })
    h.managed.activeObjective!.terminalState = 'exhausted'
    h.managed.pendingTurnRecovery!.lastCause = 'objective_incomplete'
    h.managed.pendingTurnRecovery!.validationGaps = ['The target Read receipt is corrupt and cannot prove $.ok equals true.']
    const originalEvidence = structuredClone(h.managed.messages.filter(message => message.role === 'tool'))
    const budget = structuredClone(h.managed.pendingTurnRecovery!)
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.lastSentMessage).toContain('strictly read-only observation')
      expect(h.managed.lastSentMessage).toContain('fresh tool receipt faithfully')
      expect(h.managed.lastSentMessage).toContain('Do not repeat an external mutation')
      expect(h.managed.lastSentMessage).toContain(budget.validationGaps![0]!)
      expect(h.managed.messages.filter(message => message.role === 'tool')).toEqual(originalEvidence)
      expect(h.managed.pendingTurnRecovery).toMatchObject({
        attempts: budget.attempts, stagnantAttempts: budget.stagnantAttempts,
        exhaustedAt: budget.exhaustedAt, leaseExpiresAt: budget.leaseExpiresAt,
      })
    } finally { await h.finish() }
  })

  it('rejects stale, hidden, queued and internal anchors without changing the objective', async () => {
    const h = harness()
    for (const options of [{ id: 'root-user' }, { id: 'hidden', hidden: true }, { id: 'queued', isQueued: true }, { id: 'internal', internalOrigin: { kind: 'agent-message' as const } }]) {
      if (options.id !== 'root-user') h.managed.messages.push({ role: 'user', content: 'Not a new human request', timestamp: 6, ...options })
      await expect(h.manager.retryTurn(h.managed.id, options.id)).rejects.toThrow('latest accepted user message')
    }
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(h.managed.isProcessing).toBe(false)
  })

  it('retries an authenticated initial delegation on its existing ID while preserving answers, evidence and exhausted budgets', async () => {
    const h = harness()
    h.managed.parentSessionId = 'delegating-parent'
    h.managed.messages = h.managed.messages.filter(message => message.id !== 'latest-user')
    h.managed.messages[0]!.internalOrigin = { kind: 'spawned-session', senderSessionId: 'delegating-parent' }
    h.managed.messages.push(
      { id: 'answer', role: 'user', content: 'The saved clarification.', timestamp: 6, hidden: true,
        internalOrigin: { kind: 'user-input' } },
      { id: 'stop', role: 'info', content: 'Response interrupted', timestamp: 7 },
    )
    h.managed.activeObjective!.lastUserMessageId = 'root-user'
    h.managed.pendingTurnRecovery!.validationExhausted = true
    h.managed.pendingTurnRecovery!.lastCause = 'objective_incomplete'
    const before = structuredClone(h.managed.messages)
    const objective = structuredClone(h.managed.activeObjective!)
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'root-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.messages).toEqual(before.map(message => message.id === 'root-user' ? { ...message, isQueued: false } : message))
      expect(h.managed.activeObjective).toEqual({ ...objective, terminalState: 'active', completedAt: undefined })
      expect(h.managed.pendingTurnRecovery).toMatchObject({ userMessageId: 'root-user', attempts: 5,
        stagnantAttempts: 2, exhaustedAt: 5, validationExhausted: true, validationGaps: ['relevant-checks-passed'] })
      expect(h.managed.lastSentMessage).toContain('original_user_message_id="root-user"')
      expect(h.managed.lastSentMessage).toContain('Do not repeat an external mutation')
      expect(h.events.filter(event => event.type === 'user_message')).toMatchObject([
        { message: { id: 'root-user', internalOrigin: { kind: 'spawned-session', senderSessionId: 'delegating-parent' } }, status: 'processing' },
      ])
    } finally { await h.finish() }
  })

  it('retries an exhausted automation snapshot only through its authenticated root', async () => {
    const h = harness()
    h.managed.messages = h.managed.messages.filter(message => message.id !== 'latest-user')
    h.managed.messages[0]!.internalOrigin = { kind: 'automation' }
    h.managed.triggeredBy = { automationName: 'Daily verification', timestamp: 1 }
    h.managed.activeObjective!.lastUserMessageId = 'root-user'
    const recovery = {
      ...h.managed.pendingTurnRecovery!,
      userMessageId: 'root-user',
      continuationOrigin: 'objective_continue' as const,
      continuationWork: ['Verify the saved automation result'],
    }
    h.managed.pendingTurnRecovery = undefined
    h.managed.activeObjective!.terminalState = 'exhausted'
    h.managed.activeObjective!.interruptedTurnRecovery = {
      objectiveId: 'root-user', userMessageId: 'root-user', recovery,
    }
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'root-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.pendingTurnRecovery).toMatchObject({
        userMessageId: 'root-user',
        attempts: recovery.attempts,
        continuationOrigin: 'objective_continue',
        continuationWork: ['Verify the saved automation result'],
      })
      expect(h.managed.lastSentMessage).toContain('Verify the saved automation result')
    } finally { await h.finish() }
  })

  it('refuses automation retry anchors without the complete host-owned root provenance', async () => {
    for (const variant of [
      'missing-trigger', 'has-parent', 'wrong-objective', 'wrong-root', 'hidden', 'queued', 'pending',
      'agent-delivery', 'wrong-origin', 'duplicate-root',
    ]) {
      const h = harness()
      h.managed.messages = h.managed.messages.filter(message => message.id !== 'latest-user')
      const root = h.managed.messages[0]!
      root.internalOrigin = { kind: 'automation' }
      h.managed.triggeredBy = { automationName: 'Daily verification', timestamp: 1 }
      h.managed.activeObjective!.lastUserMessageId = 'root-user'
      if (variant === 'missing-trigger') h.managed.triggeredBy = undefined
      if (variant === 'has-parent') h.managed.parentSessionId = 'unexpected-parent'
      if (variant === 'wrong-objective') h.managed.activeObjective!.objectiveId = 'another-objective'
      if (variant === 'wrong-root') h.managed.activeObjective!.userMessageId = 'another-root'
      if (variant === 'hidden') root.hidden = true
      if (variant === 'queued') root.isQueued = true
      if (variant === 'pending') root.isPending = true
      if (variant === 'agent-delivery') root.agentDelivery = { id: 'delivery', status: 'queued', attempts: 0 }
      if (variant === 'wrong-origin') root.internalOrigin = { kind: 'agent-message' }
      if (variant === 'duplicate-root') h.managed.messages.push({ ...root })
      const before = structuredClone({
        messages: h.managed.messages,
        objective: h.managed.activeObjective,
        recovery: h.managed.pendingTurnRecovery,
      })
      await expect(h.manager.retryTurn(h.managed.id, 'root-user')).rejects.toThrow('latest accepted user message')
      expect({
        messages: h.managed.messages,
        objective: h.managed.activeObjective,
        recovery: h.managed.pendingTurnRecovery,
      }).toEqual(before)
      expect(h.managed.isProcessing).toBe(false)
    }
  })

  it('authenticates a stopped snapshot by its visible anchor while preserving a hidden answer recovery', async () => {
    const h = harness()
    const questions = [{ id: 'scope', question: 'Which scope?' }]
    const answers = [{ questionId: 'scope', optionIds: [], text: 'The durable user-input answer.' }]
    const hiddenAnswer = {
      id: 'saved-answer', role: 'user' as const,
      content: USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({ requestId: 'saved-question', questions, answers }),
      timestamp: 6,
      hidden: true, internalOrigin: { kind: 'user-input' as const },
    }
    h.managed.messages.push(hiddenAnswer)
    h.managed.userInputRequests = [{
      id: 'saved-question', sessionId: h.managed.id, originWorkspaceId: h.managed.workspace.id,
      questions, status: 'answered', createdAt: 5, answeredAt: 6,
      objectiveUserMessageId: 'root-user', responseMessageId: hiddenAnswer.id,
      answers,
    }]
    const recovery = {
      ...h.managed.pendingTurnRecovery!,
      userMessageId: hiddenAnswer.id,
      attempts: 3,
      stagnantAttempts: 1,
      continuationWork: ['Apply the saved answer and verify the target'],
      continuationOrigin: 'objective_continue' as const,
    }
    h.managed.pendingTurnRecovery = undefined
    h.managed.activeObjective!.terminalState = 'blocked_policy'
    h.managed.activeObjective!.interruptedTurnRecovery = {
      objectiveId: 'root-user',
      userMessageId: 'latest-user',
      recovery: structuredClone(recovery),
    }
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.messages).toContainEqual(hiddenAnswer)
      expect(h.managed.pendingTurnRecovery).toMatchObject({
        userMessageId: 'latest-user',
        attempts: recovery.attempts,
        stagnantAttempts: recovery.stagnantAttempts,
        continuationWork: recovery.continuationWork,
        continuationOrigin: recovery.continuationOrigin,
      })
      expect(h.managed.lastSentMessage).toContain('Apply the saved answer and verify the target')
    } finally { await h.finish() }
  })

  it('rejects a structurally bound snapshot whose inner recovery belongs to an older objective', async () => {
    const h = harness()
    h.managed.pendingTurnRecovery = undefined
    h.managed.activeObjective!.terminalState = 'blocked_policy'
    h.managed.activeObjective!.interruptedTurnRecovery = {
      objectiveId: 'root-user',
      userMessageId: 'latest-user',
      recovery: {
        userMessageId: 'old-objective-A', startedAt: 1, attempts: 9, stagnantAttempts: 2,
        lastCause: 'objective_continue', continuationRequired: true,
        continuationOrigin: 'objective_continue', continuationWork: ['Old objective A work'],
      },
    }
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.pendingTurnRecovery).toMatchObject({
        userMessageId: 'latest-user', attempts: 0, budgetHistoryUnavailable: true,
        lastCause: 'user_retry',
      })
      const pending = h.managed.pendingTurnRecovery as Managed['pendingTurnRecovery']
      expect(pending?.continuationWork).toBeUndefined()
      expect(pending?.continuationOrigin).toBeUndefined()
    } finally { await h.finish() }
  })

  it('refuses delegated anchors with wrong parent, objective, origin, visibility or admission state', async () => {
    for (const variant of ['no-parent', 'wrong-parent', 'self-parent', 'wrong-objective', 'wrong-root', 'missing-objective',
      'hidden', 'queued', 'pending', 'agent-message', 'user-input', 'not-initial']) {
      const h = harness()
      h.managed.parentSessionId = 'delegating-parent'
      h.managed.messages = h.managed.messages.filter(message => message.id !== 'latest-user')
      const anchor = h.managed.messages[0]!
      anchor.internalOrigin = { kind: 'spawned-session', senderSessionId: 'delegating-parent' }
      if (variant === 'no-parent') h.managed.parentSessionId = undefined
      if (variant === 'wrong-parent') anchor.internalOrigin.senderSessionId = 'another-parent'
      if (variant === 'self-parent') { h.managed.parentSessionId = h.managed.id; anchor.internalOrigin.senderSessionId = h.managed.id }
      if (variant === 'wrong-objective') h.managed.activeObjective!.objectiveId = 'another-objective'
      if (variant === 'wrong-root') h.managed.activeObjective!.userMessageId = 'another-root'
      if (variant === 'missing-objective') h.managed.activeObjective = undefined
      if (variant === 'hidden') anchor.hidden = true
      if (variant === 'queued') anchor.isQueued = true
      if (variant === 'pending') anchor.isPending = true
      if (variant === 'agent-message' || variant === 'user-input') anchor.internalOrigin = { kind: variant }
      if (variant === 'not-initial') h.managed.messages.unshift({ id: 'older-internal-root', role: 'user', content: 'Earlier delegation',
        timestamp: 0, hidden: true, internalOrigin: { kind: 'spawned-session', senderSessionId: 'delegating-parent' } })
      const before = structuredClone({ messages: h.managed.messages, objective: h.managed.activeObjective, recovery: h.managed.pendingTurnRecovery })
      await expect(h.manager.retryTurn(h.managed.id, 'root-user')).rejects.toThrow('latest accepted user message')
      expect({ messages: h.managed.messages, objective: h.managed.activeObjective, recovery: h.managed.pendingTurnRecovery }).toEqual(before)
      expect(h.managed.isProcessing).toBe(false)
    }
  })

  it('prefers the latest accepted human request over the initial delegation and still refuses outstanding decisions', async () => {
    const h = harness()
    h.managed.parentSessionId = 'delegating-parent'
    h.managed.messages[0]!.internalOrigin = { kind: 'spawned-session', senderSessionId: 'delegating-parent' }
    await expect(h.manager.retryTurn(h.managed.id, 'root-user')).rejects.toThrow('latest accepted user message')
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.pendingTurnRecovery?.userMessageId).toBe('latest-user')
    } finally { await h.finish() }
    for (const kind of ['question', 'auth', 'approval', 'queue']) {
      const child = harness()
      child.managed.parentSessionId = 'delegating-parent'
      child.managed.messages = child.managed.messages.filter(message => message.id !== 'latest-user')
      child.managed.messages[0]!.internalOrigin = { kind: 'spawned-session', senderSessionId: 'delegating-parent' }
      if (kind === 'question') child.managed.userInputRequests = [{ id: 'q', sessionId: child.managed.id,
        originWorkspaceId: child.managed.workspace.id, status: 'pending', createdAt: 1 }] as never
      if (kind === 'auth') child.managed.pendingAuthRequestId = 'auth'
      if (kind === 'approval') sessionRuntimeStateForTest(child.internals).pendingPermissionRequests.set('permission', permissionMetadataFixture(child.managed.id))
      if (kind === 'queue') child.managed.messageQueue.push({ message: 'waiting' })
      await expect(child.manager.retryTurn(child.managed.id, 'root-user')).rejects.toThrow()
      expect(child.managed.isProcessing).toBe(false)
      expect(child.events).toHaveLength(0)
    }
  })

  it.each(['question', 'auth', 'approval', 'queue'])('does not bypass a pending %s', async kind => {
    const h = harness()
    if (kind === 'question') h.managed.userInputRequests = [{ id: 'q', sessionId: h.managed.id, originWorkspaceId: h.managed.workspace.id, status: 'pending', createdAt: 1 }] as never
    if (kind === 'auth') h.managed.pendingAuthRequestId = 'auth'
    if (kind === 'approval') sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.set('permission', permissionMetadataFixture(h.managed.id))
    if (kind === 'queue') h.managed.messageQueue.push({ message: 'waiting' })
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).rejects.toThrow()
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(h.managed.messages).toHaveLength(5)
  })

  it('reports an already active session without queuing or duplicating its user message', async () => {
    const h = harness()
    h.managed.isProcessing = true
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'already_running' })
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.managed.messages).toHaveLength(5)
  })

  it('rejects a missing saved attachment before reopening anything', async () => {
    const h = harness()
    h.managed.messages[2]!.attachments = [{ id: 'missing', type: 'text', name: 'missing.txt', mimeType: 'text/plain', size: 1, storedPath: join(h.rootPath, 'missing.txt') }]
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).rejects.toThrow('saved attachment is unavailable')
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(h.managed.isProcessing).toBe(false)
  })

  it('rolls back the reopen and releases the reservation when durable acceptance fails', async () => {
    const h = harness()
    const objective = h.managed.activeObjective
    const recovery = h.managed.pendingTurnRecovery
    let flushes = 0
    h.internals.flushSession = async () => { if (++flushes > 1) throw new Error('durable write failed') }
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).rejects.toThrow('durable write failed')
    expect(h.managed.activeObjective).toBe(objective)
    expect(h.managed.pendingTurnRecovery).toBe(recovery)
    expect(h.managed.sessionStatus).toBe('done')
    expect(h.managed.isProcessing).toBe(false)
    expect(h.events.some(event => event.type === 'user_message')).toBe(false)
    expect(h.events.at(-1)).toMatchObject({ type: 'session_status_changed', sessionStatus: 'done' })
    expect(h.events.filter(event => event.type === 'session_status_changed').map(event => event.sessionStatus)).toEqual(['in-progress', 'done'])
    expect(h.managed.messages[2]!.isQueued).toBeUndefined()
  })

  it('rechecks the user anchor after asynchronous preparation so a newer send cannot queue an old request', async () => {
    const h = harness()
    let calls = 0
    h.internals.ensureMessagesLoaded = async () => {
      if (++calls === 2) h.managed.messages.push({ id: 'new-human', role: 'user', content: 'New request', timestamp: 6 })
    }
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).rejects.toThrow('latest accepted user message')
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
  })

  it('does not replay an untracked legacy manual retry after restart when automatic recovery is exhausted', async () => {
    const h = harness()
    h.managed.sessionStatus = 'todo'
    h.managed.activeObjective!.terminalState = 'active'
    h.managed.pendingTurnRecovery = { ...h.managed.pendingTurnRecovery!, userMessageId: 'latest-user', lastCause: 'user_retry', userRetryFromMessageCount: 5 }
    const retries: string[] = []
    h.manager.retryTurn = async () => { throw new Error('Restart must not mint a new explicit Retry allowance') }
    sessionManagerForTest(h.manager).retryTurnInternal = async (_id, anchor, _context, grantNewAllowance = false) => {
      expect(grantNewAllowance).toBe(false)
      retries.push(anchor); return { status: 'started' }
    }
    await h.internals.resumePendingTurnAfterRestart(h.managed.id)
    // The legacy boundary proves which transcript rows belong to the old
    // attempt, but not whether its provider call started before the crash.
    // Without a durable dispatch identity, replaying it directly could repeat
    // external work; the exhausted automatic budget must stop visibly instead.
    expect(retries).toEqual([])
    expect(h.managed.activeObjective!.userMessageId).toBe('root-user')
    expect(h.managed.activeObjective!.terminalState as string).toBe('exhausted')
    expect(h.managed.pendingTurnRecovery!.attempts).toBe(5)
    expect(h.managed.pendingTurnRecovery!.lastCause).toBe('app_restart')
    expect(h.managed.pendingTurnRecovery!.recoveryDispatch).toBeUndefined()
    expect(h.managed.messageQueue).toEqual([])
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'error',
      error: expect.stringContaining('retry limit was reached'),
    }))
  })

  it('does not replay a manual attempt that has already produced a new terminal error', async () => {
    const h = harness()
    h.managed.sessionStatus = 'todo'
    h.managed.activeObjective!.terminalState = 'active'
    h.managed.pendingTurnRecovery = { ...h.managed.pendingTurnRecovery!, userMessageId: 'latest-user', lastCause: 'user_retry', userRetryFromMessageCount: 5 }
    h.managed.messages.push({ id: 'new-error', role: 'error', content: 'New attempt failed', timestamp: 6 })
    h.manager.retryTurn = async () => { throw new Error('Must not replay terminal attempt') }
    await h.internals.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
  })

  it('never accepts the previous final when the retry stream ends without a new response', async () => {
    const h = harness()
    h.internals.getOrCreateAgent = async () => ({
      getModel: () => 'test/retry-model', getSessionId: () => null, setAllSources: () => {},
      async *chat() { yield { type: 'complete' } },
    })
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
    await h.finish()
    expect(h.managed.activeObjective?.terminalState).not.toBe('complete_verified')
    // The explicit user retry may now own a prospective reserve. An empty
    // stream can consume one bounded pass, but never adopt the old final.
    for (let pass = 0; pass < 8; pass++) {
      const next = h.managed.messageQueue.shift()
      if (!next) break
      expect(next.options?.automaticRecovery?.cause).toBe('stream_ended')
      await h.manager.sendMessage(h.managed.id, next.message, next.attachments, next.storedAttachments, next.options, next.messageId)
    }
    expect(h.managed.activeObjective?.terminalState).not.toBe('complete_verified')
    expect(h.events.some(event => event.type === 'error')).toBe(true)
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.managed.messages.filter(message => message.role === 'user' && !message.hidden)).toHaveLength(2)
  })
});
