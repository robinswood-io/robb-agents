import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Regression test for the High-severity finding in eb81086e:
//
//   sendMessage's `{ accepted, messageId }` ack contract was returning before
//   the user message hit disk because `persistSession` only enqueues with a
//   500ms debounce. A crash inside the debounce window after ack would lose
//   the message.
//
// The fix added `await this.flushSession(managed.id)` between persistSession
// and onAck. This test locks that ordering by reading the session file from
// inside the onAck callback and asserting the user message is already there.

describe('sendMessage durability', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-durability-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    // A failed provider setup can still leave admitted persistence work in the
    // shared queue. Drain it before removing the exact root whose identity the
    // queue is required to revalidate on every write.
    await sm.cleanup()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'durability test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function readPersistedMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    // First line is the header, remaining lines are messages.
    return lines.slice(1).map(l => JSON.parse(l)).map(m => m.id as string)
  }

  it('user message is on disk before onAck fires (normal branch)', async () => {
    const sessionId = 'durability-normal'
    buildSession(sessionId)

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    // sendMessage continues past the ack into agent-init, which would throw
    // because we haven't called `setSessionPlatform()` in this minimal test
    // harness. That's fine — we only care about the persist+flush+ack ordering
    // that happens before agent-init. Catch the post-ack rejection.
    await sm
      .sendMessage(
        sessionId,
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (messageId) => {
          ackedMessageId = messageId
          onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
        },
      )
      .catch(() => { /* expected post-ack agent-init failure */ })

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('user message is on disk before onAck fires (mid-stream / queued branch)', async () => {
    const sessionId = 'durability-midstream'
    const managed = buildSession(sessionId)
    // Force the mid-stream branch. Agent is null, so redirect() falls back to
    // false and the queue path runs.
    managed.isProcessing = true

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    await sm.sendMessage(
      sessionId,
      'queued message',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (messageId) => {
        ackedMessageId = messageId
        onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
      },
    )

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('queues a skill-bearing mid-stream message despite an agent claiming steer success', async () => {
    const sessionId = 'full-payload-midstream'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    const redirect = mock((_message: string) => true)
    managed.agent = { redirect, dispose: async () => {} } as never

    let ackedMessageId: string | undefined
    await sm.sendMessage(sessionId, 'Use the review skill.', undefined, undefined,
      { skillSlugs: ['review'] }, undefined, undefined, id => { ackedMessageId = id })

    expect(redirect).not.toHaveBeenCalled()
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({
      message: 'Use the review skill.',
      messageId: ackedMessageId,
      options: { skillSlugs: ['review'] },
    })
    expect(managed.messages.find(message => message.id === ackedMessageId)?.isQueued).toBe(true)
    expect(ackedMessageId && readPersistedMessageIds(sessionId).includes(ackedMessageId)).toBe(true)
    expect(managed.wasInterrupted).not.toBe(true)
  })

  it('places a delegated terminal delivery behind older deliveries and before automatic continuation', async () => {
    const sessionId = 'terminal-agent-before-recovery'
    const managed = buildSession(sessionId)
    managed.activeObjective = {
      schemaVersion: 1,
      objectiveId: 'objective-root', userMessageId: 'objective-root', lastUserMessageId: 'objective-root',
      startedAt: 1, budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
      orchestrationMode: 'mission', risk: 'standard', requiresExecutionEvidence: false,
      completionCriteria: [], terminalState: 'active',
    }
    managed.pendingTurnRecovery = { userMessageId: 'objective-root', startedAt: 1, attempts: 1 }
    managed.isProcessing = true
    const reviewer = createManagedSession({
      id: 'current-reviewer', parentSessionId: sessionId,
      delegation: {
        rootSessionId: sessionId, rootObjectiveId: 'objective-root', parentObjectiveId: 'objective-root',
        depth: 1, role: 'reviewer',
      },
    }, managed.workspace, { messagesLoaded: true })
    reviewer.isProcessing = true
    ;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions.set(reviewer.id, reviewer)
    managed.messageQueue.push({
      message: '<automatic_turn_recovery>continue</automatic_turn_recovery>',
      options: {
        hidden: true,
        automaticRecovery: {
          originalUserMessageId: 'objective-root',
          cause: 'premature_final',
        },
      },
    }, {
      message: 'Older accepted agent delivery.',
      options: {
        hidden: true,
        internalOrigin: {
          kind: 'agent-message', senderSessionId: 'older-agent', deliveryId: 'older-delivery',
        },
      },
    })

    await sm.sendMessage(sessionId, 'Reviewer terminal verdict: FAIL with concrete findings.', undefined, undefined, {
      hidden: true,
      internalOrigin: {
        kind: 'agent-message',
        senderSessionId: 'current-reviewer',
        deliveryId: 'reviewer-terminal-delivery',
      },
    })

    expect(managed.messageQueue.map(item => item.message)).toEqual([
      'Older accepted agent delivery.',
      'Reviewer terminal verdict: FAIL with concrete findings.',
      '<automatic_turn_recovery>continue</automatic_turn_recovery>',
    ])
    const delivery = managed.messages.find(message => message.agentDelivery?.id === 'reviewer-terminal-delivery')
    expect(delivery).toMatchObject({
      isQueued: true,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'current-reviewer' },
      agentDelivery: { status: 'queued', attempts: 0 },
    })
  })

  it('does not let an unrelated agent delivery overtake an automatic continuation', async () => {
    const managed = buildSession('unrelated-agent-fifo')
    managed.isProcessing = true
    managed.messageQueue.push({
      message: '<automatic_turn_recovery>continue</automatic_turn_recovery>',
      options: {
        hidden: true,
        automaticRecovery: { originalUserMessageId: 'objective-root', cause: 'premature_final' },
      },
    })

    await sm.sendMessage(managed.id, 'Unrelated agent update.', undefined, undefined, {
      hidden: true,
      internalOrigin: {
        kind: 'agent-message', senderSessionId: 'unrelated-agent', deliveryId: 'unrelated-delivery',
      },
    })

    expect(managed.messageQueue.map(item => item.message)).toEqual([
      '<automatic_turn_recovery>continue</automatic_turn_recovery>',
      'Unrelated agent update.',
    ])
  })

  it('lets sibling delegated deliveries use their bounded result slots when the inbox limit is one', async () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'ws_test', name: 'Test Workspace', slug: 'test-workspace', defaults: {},
      costControl: { coordination: { maxQueuedMessages: 1 } },
      createdAt: 1, updatedAt: 1,
    }))
    const managed = buildSession('single-slot-delegated-delivery')
    managed.activeObjective = {
      schemaVersion: 1,
      objectiveId: 'objective-root', userMessageId: 'objective-root', lastUserMessageId: 'objective-root',
      startedAt: 1, budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
      orchestrationMode: 'mission', risk: 'standard', requiresExecutionEvidence: false,
      completionCriteria: [], terminalState: 'active',
    }
    managed.pendingTurnRecovery = {
      userMessageId: 'objective-root', startedAt: 1, attempts: 1,
      lastCause: 'premature_final',
      recoveryDispatch: {
        schemaVersion: 1, id: 'allocated-recovery', attempt: 1,
        cause: 'premature_final', origin: 'automatic', allocatedAt: 2, phase: 'allocated',
      },
    }
    managed.isProcessing = true
    const reviewer = createManagedSession({
      id: 'single-slot-reviewer', parentSessionId: managed.id,
      delegation: {
        rootSessionId: managed.id, rootObjectiveId: 'objective-root', parentObjectiveId: 'objective-root',
        depth: 1, role: 'reviewer',
      },
    }, managed.workspace, { messagesLoaded: true })
    reviewer.isProcessing = true
    ;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions.set(reviewer.id, reviewer)
    const siblingReviewer = createManagedSession({
      id: 'single-slot-sibling-reviewer', parentSessionId: managed.id,
      delegation: {
        rootSessionId: managed.id, rootObjectiveId: 'objective-root', parentObjectiveId: 'objective-root',
        depth: 1, role: 'reviewer',
      },
    }, managed.workspace, { messagesLoaded: true })
    siblingReviewer.isProcessing = true
    ;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions.set(siblingReviewer.id, siblingReviewer)
    managed.messageQueue.push({
      message: '<automatic_turn_recovery>continue</automatic_turn_recovery>',
      options: {
        hidden: true,
        automaticRecovery: {
          originalUserMessageId: 'objective-root', cause: 'premature_final',
          dispatchId: 'allocated-recovery', dispatchAttempt: 1,
          dispatchOrigin: 'automatic', dispatchAllocatedAt: 2,
        },
      },
    })

    await sm.sendMessage(managed.id, 'Reviewer terminal verdict.', undefined, undefined, {
      hidden: true,
      internalOrigin: {
        kind: 'agent-message', senderSessionId: reviewer.id, deliveryId: 'single-slot-delivery',
      },
    })
    await sm.sendMessage(managed.id, 'Sibling reviewer terminal verdict.', undefined, undefined, {
      hidden: true,
      internalOrigin: {
        kind: 'agent-message', senderSessionId: siblingReviewer.id, deliveryId: 'single-slot-sibling-delivery',
      },
    })

    expect(managed.messageQueue).toHaveLength(3)
    expect(managed.messageQueue[0]?.options?.internalOrigin?.deliveryId).toBe('single-slot-delivery')
    expect(managed.messageQueue[1]?.options?.internalOrigin?.deliveryId).toBe('single-slot-sibling-delivery')
    expect(managed.messageQueue[2]?.options?.automaticRecovery?.dispatchId).toBe('allocated-recovery')
    expect(managed.pendingTurnRecovery.recoveryDispatch?.id).toBe('allocated-recovery')
    expect(managed.pendingTurnRecovery.attempts).toBe(1)
  })

  it('rejects a changed offline anchor before appending any user message', async () => {
    const sessionId = 'offline-anchor-changed'
    const managed = buildSession(sessionId)
    const originalCount = managed.messages.length

    const send = sm.sendMessage(sessionId, 'must not append', undefined, undefined, {
      expectedSessionAnchor: {
        messageCount: originalCount + 1,
        lastFinalMessageId: managed.lastFinalMessageId ?? null,
        lastMessageAt: managed.lastMessageAt,
      },
    })
    await expect(send).rejects.toMatchObject({ code: 'SESSION_CONTEXT_CHANGED' })
    expect(managed.messages).toHaveLength(originalCount)
    expect(readPersistedMessageIds(sessionId)).toEqual([])
  })

  it('does not clear a pending plan when an offline anchor is rejected', async () => {
    const sessionId = 'offline-anchor-plan'
    const managed = buildSession(sessionId)
    ;(sm as unknown as { persistSession: (session: unknown) => void }).persistSession(managed)
    await sm.flushSession(sessionId)
    await sm.setPendingPlanExecution(sessionId, '/tmp/plan.md', 'draft')
    expect(sm.getPendingPlanExecution(sessionId)).not.toBeNull()

    const send = sm.sendMessage(sessionId, 'must not mutate plan state', undefined, undefined, {
      expectedSessionAnchor: {
        messageCount: managed.messages.length + 1,
        lastFinalMessageId: managed.lastFinalMessageId ?? null,
        lastMessageAt: managed.lastMessageAt,
      },
    })
    await expect(send).rejects.toMatchObject({ code: 'SESSION_CONTEXT_CHANGED' })
    expect(sm.getPendingPlanExecution(sessionId)).toMatchObject({
      planPath: '/tmp/plan.md',
      draftInputSnapshot: 'draft',
    })
  })

  it('rejects an offline outbox send if the session became busy after review', async () => {
    const sessionId = 'offline-anchor-busy'
    const managed = buildSession(sessionId)
    const originalCount = managed.messages.length
    managed.isProcessing = true

    const send = sm.sendMessage(sessionId, 'must remain local', undefined, undefined, {
      expectedSessionAnchor: {
        messageCount: originalCount,
        lastFinalMessageId: managed.lastFinalMessageId ?? null,
        lastMessageAt: managed.lastMessageAt,
      },
    })
    await expect(send).rejects.toMatchObject({ code: 'SESSION_CONTEXT_CHANGED' })
    expect(managed.messages).toHaveLength(originalCount)
    expect(readPersistedMessageIds(sessionId)).toEqual([])
  })
})
