import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Message } from '@craft-agent/core/types'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createPendingTurnRecovery } from './turn-recovery.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('transient network recovery', () => {
  it('retries through the bounded durable path before surfacing the typed error', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'network-turn-recovery-'))
    roots.push(workspaceRoot)

    const workspace = {
      id: 'ws-network-recovery',
      name: 'Network recovery',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const userMessage: Message = {
      id: 'user-network-turn',
      role: 'user',
      content: 'Continue the work',
      timestamp: 1,
    }
    const managed = createManagedSession(
      { id: 'session-network-recovery' },
      workspace as never,
      {
        messagesLoaded: true,
        messages: [userMessage],
        isProcessing: true,
        processingGeneration: 1,
        pendingTurnRecovery: createPendingTurnRecovery(userMessage.id, 1),
      },
    )
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

    const event: AgentEvent = {
      type: 'typed_error',
      error: {
        code: 'network_error',
        title: 'Connection Error',
        message: 'Could not reach the AI service.',
        actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
        canRetry: true,
      },
    }
    const processEvent = (
      manager as unknown as {
        processEvent: (session: typeof managed, agentEvent: AgentEvent, generation: number) => Promise<void>
      }
    ).processEvent.bind(manager)

    await processEvent(managed, event, 1)

    expect(managed.pendingTurnRecovery?.attempts).toBe(1)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.options?.automaticRecovery).toEqual({
      originalUserMessageId: userMessage.id,
      cause: 'runtime_error',
    })
    expect(managed.pendingRuntimeProviderFallback).toMatchObject({
      generation: 1,
      error: expect.any(Error),
    })
    expect(managed.messages.some(message => message.role === 'error')).toBe(false)

    // Simulate each configured recovery being dequeued and failing the same
    // way. The bounded policy may allow more than one retry, but must exhaust.
    for (let attempt = 0; attempt < 10 && !managed.pendingTurnRecovery?.exhaustedAt; attempt++) {
      managed.messageQueue = []
      await processEvent(managed, event, 1)
    }
    expect(typeof managed.pendingTurnRecovery?.exhaustedAt).toBe('number')
    expect(managed.messages.at(-1)).toMatchObject({
      role: 'error',
      errorCode: 'network_error',
      errorTitle: 'Connection Error',
    })
  })

  it('queues recovery and defers fallback for a retryable plain provider error', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'plain-provider-recovery-'))
    roots.push(workspaceRoot)

    const workspace = {
      id: 'ws-plain-provider-recovery',
      name: 'Plain provider recovery',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const userMessage: Message = {
      id: 'user-provider-turn',
      role: 'user',
      content: 'Complete the delegated analysis',
      timestamp: 1,
    }
    const managed = createManagedSession(
      { id: 'session-provider-recovery' },
      workspace as never,
      {
        messagesLoaded: true,
        messages: [userMessage],
        isProcessing: true,
        processingGeneration: 3,
        pendingTurnRecovery: createPendingTurnRecovery(userMessage.id, 1),
      },
    )
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)
    const processEvent = (
      manager as unknown as {
        processEvent: (session: typeof managed, agentEvent: AgentEvent, generation: number) => Promise<void>
      }
    ).processEvent.bind(manager)

    await processEvent(managed, {
      type: 'error',
      message: 'Codex error: The usage limit has been reached',
    }, 3)

    expect(managed.pendingTurnRecovery?.attempts).toBe(1)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.pendingRuntimeProviderFallback).toMatchObject({
      generation: 3,
      error: expect.any(Error),
    })
    expect(managed.messages.some(message => message.role === 'error')).toBe(false)
  })
})
