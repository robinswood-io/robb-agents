import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as config from "@craft-agent/shared/config";
import { setPermissionMode } from "@craft-agent/shared/agent";
import { listSessions } from "@craft-agent/shared/sessions/storage";
import { SessionManager } from "./SessionManager";
import { buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, deferred, harness, managers, spies, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('exposes a restored permission wait in the initial root/child DTO before message hydration', async () => {
    const h = harness(); const child = h.make('dto-child', 'dto-root'); h.make('dto-root')
    child.pendingTurnRecovery!.waitingForPermission = { requestId: 'permission', requestedAt: 2, toolName: 'Bash' }
    await h.save(child)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const manager = new SessionManager(); managers.push(manager)
    const runtime = sessionManagerForTest(manager)
    runtime.resumePendingTurnsAfterRestart = async () => {}
    runtime.loadSessionsFromDisk()
    const dto = manager.getSessions().find(session => session.id === child.id)!
    expect(dto.pendingTurnRecovery?.waitingForPermission).toEqual({ requestId: 'permission', requestedAt: 2, toolName: 'Bash', recoveryRequired: true })
    expect(dto.parentSessionId).toBe('dto-root')
    expect(requiredTestValue(sessionRuntimeStateForTest(manager).sessions.get(child.id)).messagesLoaded).toBe(false)
  })

  it('retains an expired permission block across restart without starting a provider', async () => {
    const h = harness(); const managed = h.make('expired-permission')
    managed.sessionStatus = 'blocked'
    managed.activeObjective!.terminalState = 'blocked_human'
    managed.activeObjective!.completedAt = 3
    managed.pendingTurnRecovery!.waitingForPermission = {
      requestId: 'expired-approval',
      requestedAt: 2,
      toolName: 'gmail_send',
      toolUseId: 'gmail-call',
      recoveryRequired: true,
    }
    await h.save(managed)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const manager = new SessionManager(); managers.push(manager)
    const runtime = sessionManagerForTest(manager); let starts = 0
    runtime.getOrCreateAgent = async () => { starts++; throw new Error('Expired permission must require explicit Retry') }
    runtime.loadSessionsFromDisk()
    await tick(); await tick()

    const restored = requiredTestValue(sessionRuntimeStateForTest(manager).sessions.get(managed.id))
    expect(starts).toBe(0)
    expect(requiredTestValue(restored.activeObjective).terminalState).toBe('blocked_human')
    expect(requiredTestValue(restored.pendingTurnRecovery).waitingForPermission).toEqual({
      requestId: 'expired-approval', requestedAt: 2, toolName: 'gmail_send',
      toolUseId: 'gmail-call', recoveryRequired: true,
    })
  })

  it('restores an indexed child auth handoff without a turn marker into the initial DTO, without starting a provider', async () => {
    const h = harness(); const root = h.make('auth-root'); root.pendingTurnRecovery = undefined
    const child = h.make('auth-child', root.id); child.pendingTurnRecovery = undefined
    child.pendingAuthRequestId = 'auth-form'
    child.messages.push({ id: 'auth-message', role: 'auth-request', content: 'Credentials required', timestamp: 2,
      authRequestId: 'auth-form', authRequestType: 'credential', authSourceSlug: 'source', authSourceName: 'Source', authStatus: 'pending', authCredentialMode: 'bearer' })
    const resolved = h.make('resolved-auth', root.id); resolved.pendingTurnRecovery = undefined
    resolved.pendingAuthRequestId = 'old-auth'
    resolved.messages.push({ ...child.messages[1]!, id: 'resolved-message', authRequestId: 'old-auth', authStatus: 'completed' })
    await h.save(root); await h.save(child); await h.save(resolved)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const manager = new SessionManager(); managers.push(manager)
    const runtime = sessionManagerForTest(manager); let starts = 0
    runtime.getOrCreateAgent = async () => { starts++; throw new Error('No provider should start') }
    runtime.loadSessionsFromDisk()
    const dto = manager.getSessions().find(session => session.id === child.id)!
    expect(dto.pendingAuthRequestMessage).toMatchObject({ authRequestId: 'auth-form', authStatus: 'pending' })
    expect(dto.parentSessionId).toBe(root.id)
    expect(dto.pendingTurnRecovery).toBeUndefined()
    expect(manager.getSessions().find(session => session.id === resolved.id)?.pendingAuthRequestMessage).toBeUndefined()
    await tick(); await tick()
    expect(starts).toBe(0)
    expect(requiredTestValue(sessionRuntimeStateForTest(manager).sessions.get(child.id)).pendingAuthRequest).toMatchObject({ requestId: 'auth-form', sourceSlug: 'source', type: 'credential' })
  })

  it('lets a durable human continuation supersede a restored auth handoff and advance the objective', async () => {
    const h = harness(); const managed = h.make('auth-human-continuation')
    managed.sessionStatus = 'in-progress'
    managed.permissionMode = 'allow-all'
    managed.activeObjective!.lastUserMessageId = `${managed.id}-user`
    managed.pendingTurnRecovery = undefined
    managed.pendingAuthRequestId = 'stale-auth'
    managed.messages.push({
      id: 'auth-message', role: 'auth-request', content: 'Credentials required', timestamp: 2,
      authRequestId: 'stale-auth', authRequestType: 'credential', authSourceSlug: 'source',
      authSourceName: 'Source', authStatus: 'pending', authCredentialMode: 'bearer',
    }, {
      id: 'queued-human', role: 'user', content: 'Continue avec les éléments déjà disponibles.',
      timestamp: 3, isQueued: true,
    })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    setPermissionMode(restored.id, 'allow-all', { changedBy: 'restore' })
    const preparing = deferred(); const releaseAgent = deferred()
    let preparations = 0; let dispatch: Promise<void> | undefined
    let persistedModeAtPreparation: string | undefined
    cold.runtime.getOrCreateAgent = async () => {
      preparations++
      persistedModeAtPreparation = listSessions(h.rootPath).find(meta => meta.id === managed.id)?.permissionMode
      preparing.resolve(); await releaseAgent.promise
      throw new Error('Synthetic provider boundary')
    }
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    try {
      await cold.runtime.ensureMessagesLoaded(restored)
      await preparing.promise

      expect(preparations).toBe(1)
      expect(restored.permissionMode).toBe('ask')
      expect(persistedModeAtPreparation).toBe('ask')
      expect(restored.pendingAuthRequestId).toBeUndefined()
      expect(restored.pendingAuthRequest).toBeUndefined()
      expect(restored.messages.find((message: { id: string; authStatus?: string }) => message.id === 'auth-message')?.authStatus).toBe('cancelled')
      expect(restored.messages.find((message: { id: string; isQueued?: boolean }) => message.id === 'queued-human')?.isQueued).toBe(false)
      expect(restored.messageQueue).toEqual([])
      expect(restored.activeObjective).toMatchObject({
        userMessageId: `${managed.id}-user`,
        lastUserMessageId: 'queued-human',
        terminalState: 'active',
      })
      expect(restored.pendingTurnRecovery).toMatchObject({ userMessageId: 'queued-human', attempts: 0 })
      expect(h.events).toContainEqual(expect.objectContaining({
        type: 'auth_completed', sessionId: managed.id, requestId: 'stale-auth',
        success: false, cancelled: true,
      }))
      expect(h.events).toContainEqual(expect.objectContaining({
        type: 'permission_mode_changed', sessionId: managed.id, permissionMode: 'ask',
        previousPermissionMode: 'allow-all', changedBy: 'system',
      }))
      expect(listSessions(h.rootPath).find(meta => meta.id === managed.id)).toMatchObject({
        permissionMode: 'ask',
        pendingQueuedMessageIds: [],
        activeObjective: { lastUserMessageId: 'queued-human', terminalState: 'active' },
      })
    } finally {
      releaseAgent.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it('lets a cold human continuation overtake its bound automatic recovery before cancelling stale auth', async () => {
    const h = harness(); const managed = h.make('auth-recovery-human-continuation')
    managed.sessionStatus = 'in-progress'
    managed.permissionMode = 'allow-all'
    managed.activeObjective!.lastUserMessageId = `${managed.id}-user`
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 1,
      stagnantAttempts: 0,
      recoveryDispatch: {
        schemaVersion: 1,
        id: 'bound-cold-recovery',
        attempt: 2,
        cause: 'runtime_error',
        origin: 'automatic',
        allocatedAt: 2,
        phase: 'allocated',
      },
    }
    const recoveryPrompt = buildAutomaticTurnRecoveryPrompt(
      managed.pendingTurnRecovery,
      'runtime_error',
      undefined,
      2,
    )
    managed.isProcessing = true
    managed.processingGeneration = 1
    await h.manager.sendMessage(managed.id, recoveryPrompt, undefined, undefined, {
      hidden: true,
      automaticRecovery: {
        originalUserMessageId: managed.pendingTurnRecovery.userMessageId,
        cause: 'runtime_error',
        dispatchId: 'bound-cold-recovery',
        dispatchAttempt: 2,
        dispatchOrigin: 'automatic',
        dispatchAllocatedAt: 2,
      },
    })
    expect(managed.messageQueue[0]?.messageId).toBe('bound-cold-recovery')
    expect(managed.messages.find(message => message.id === 'bound-cold-recovery')).toMatchObject({
      role: 'user', hidden: true, isQueued: true,
    })
    managed.isProcessing = false
    managed.pendingAuthRequestId = 'stale-auth-behind-recovery'
    managed.messages.push({
      id: 'auth-behind-recovery', role: 'auth-request', content: 'Credentials required', timestamp: 3,
      authRequestId: 'stale-auth-behind-recovery', authRequestType: 'credential', authSourceSlug: 'source',
      authSourceName: 'Source', authStatus: 'pending', authCredentialMode: 'bearer',
    }, {
      id: 'queued-human-behind-recovery', role: 'user', content: 'Continue avec les preuves déjà acquises.',
      timestamp: 4, isQueued: true,
    })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    setPermissionMode(restored.id, 'allow-all', { changedBy: 'restore' })
    const preparing = deferred(); const releaseAgent = deferred()
    let preparations = 0; let dispatch: Promise<void> | undefined
    let persistedModeAtPreparation: string | undefined
    cold.runtime.getOrCreateAgent = async () => {
      preparations++
      persistedModeAtPreparation = listSessions(h.rootPath).find(meta => meta.id === managed.id)?.permissionMode
      preparing.resolve(); await releaseAgent.promise
      throw new Error('Synthetic provider boundary')
    }
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    try {
      await cold.runtime.ensureMessagesLoaded(restored)
      await preparing.promise

      expect(preparations).toBe(1)
      expect(restored.permissionMode).toBe('ask')
      expect(persistedModeAtPreparation).toBe('ask')
      expect(restored.pendingAuthRequestId).toBeUndefined()
      expect(restored.pendingAuthRequest).toBeUndefined()
      expect(restored.messages.some((message: { id: string }) => message.id === 'bound-cold-recovery')).toBe(false)
      expect(restored.messages.find((message: { id: string; authStatus?: string }) => message.id === 'auth-behind-recovery')?.authStatus).toBe('cancelled')
      expect(restored.messages.find((message: { id: string; isQueued?: boolean }) => message.id === 'queued-human-behind-recovery')?.isQueued).toBe(false)
      expect(restored.messageQueue).toEqual([])
      expect(restored.activeObjective).toMatchObject({
        userMessageId: `${managed.id}-user`,
        lastUserMessageId: 'queued-human-behind-recovery',
        terminalState: 'active',
      })
      expect(restored.pendingTurnRecovery).toMatchObject({
        userMessageId: 'queued-human-behind-recovery',
        attempts: 1,
      })
      expect(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).toBeUndefined()
      expect(h.events).toContainEqual(expect.objectContaining({
        type: 'auth_completed', sessionId: managed.id, requestId: 'stale-auth-behind-recovery',
        success: false, cancelled: true,
      }))
      expect(listSessions(h.rootPath).find(meta => meta.id === managed.id)).toMatchObject({
        permissionMode: 'ask',
        pendingQueuedMessageIds: [],
        activeObjective: { lastUserMessageId: 'queued-human-behind-recovery', terminalState: 'active' },
      })
    } finally {
      releaseAgent.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it.each(['user-input', 'agent-delivery'] as const)(
    'removes only a cold bound recovery before %s and keeps the auth handoff intact', async blockerKind => {
      const h = harness(); const managed = h.make(`auth-recovery-${blockerKind}`)
      managed.sessionStatus = 'in-progress'
      managed.permissionMode = 'allow-all'
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        attempts: 1,
        stagnantAttempts: 0,
        recoveryDispatch: {
          schemaVersion: 1,
          id: `bound-recovery-${blockerKind}`,
          attempt: 2,
          cause: 'runtime_error',
          origin: 'automatic',
          allocatedAt: 2,
          phase: 'allocated',
        },
      }
      const recoveryPrompt = buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery,
        'runtime_error',
        undefined,
        2,
      )
      managed.isProcessing = true
      managed.processingGeneration = 1
      await h.manager.sendMessage(managed.id, recoveryPrompt, undefined, undefined, {
        hidden: true,
        automaticRecovery: {
          originalUserMessageId: managed.pendingTurnRecovery.userMessageId,
          cause: 'runtime_error',
          dispatchId: `bound-recovery-${blockerKind}`,
          dispatchAttempt: 2,
          dispatchOrigin: 'automatic',
          dispatchAllocatedAt: 2,
        },
      })
      managed.isProcessing = false
      managed.pendingAuthRequestId = `preserved-auth-${blockerKind}`
      managed.messages.push({
        id: `auth-${blockerKind}`, role: 'auth-request', content: 'Credentials required', timestamp: 3,
        authRequestId: `preserved-auth-${blockerKind}`, authRequestType: 'credential', authSourceSlug: 'source',
        authSourceName: 'Source', authStatus: 'pending', authCredentialMode: 'bearer',
      })
      const blocker = blockerKind === 'user-input'
        ? {
            id: 'preserved-user-input', role: 'user' as const, content: 'Use the saved scope.', timestamp: 4,
            hidden: true, isQueued: true, internalOrigin: { kind: 'user-input' as const },
          }
        : {
            id: 'preserved-agent-delivery', role: 'user' as const, content: 'Saved child result.', timestamp: 4,
            hidden: true, isQueued: true,
            internalOrigin: { kind: 'agent-message' as const, senderSessionId: 'child', deliveryId: 'delivery' },
            agentDelivery: { id: 'delivery', status: 'queued' as const, attempts: 0 },
          }
      managed.messages.push(blocker, {
        id: 'queued-human-after-blocker', role: 'user', content: 'Continue ensuite avec le résultat préservé.',
        timestamp: 5, isQueued: true,
      })
      if (blockerKind === 'user-input') {
        managed.userInputRequests = [{
          id: 'answered-question', sessionId: managed.id, originWorkspaceId: managed.workspace.id,
          questions: [{ id: 'scope', question: 'Which scope?', options: [{ id: 'saved', label: 'Saved' }] }],
          status: 'answered', createdAt: 2, answeredAt: 4,
          objectiveUserMessageId: managed.activeObjective!.userMessageId,
          responseMessageId: blocker.id, answers: [{ questionId: 'scope', optionIds: ['saved'] }],
        }]
      }
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      setPermissionMode(restored.id, 'allow-all', { changedBy: 'restore' })
      let providerStarts = 0
      cold.runtime.getOrCreateAgent = async () => {
        providerStarts++
        throw new Error('A protected FIFO entry must remain ahead of the human continuation')
      }
      await cold.runtime.ensureMessagesLoaded(restored)
      await tick(); await tick()

      const blockerId = blocker.id as string
      expect(providerStarts).toBe(0)
      expect(restored.messageQueue.map((item: { messageId?: string }) => item.messageId)).toEqual([
        blockerId,
        'queued-human-after-blocker',
      ])
      expect(restored.messages.some((message: { id: string }) => message.id === `bound-recovery-${blockerKind}`)).toBe(false)
      expect(restored.messages.find((message: { id: string }) => message.id === blockerId)).toMatchObject(blocker)
      expect(restored.pendingAuthRequestId).toBe(`preserved-auth-${blockerKind}`)
      expect(restored.pendingAuthRequest).toMatchObject({
        requestId: `preserved-auth-${blockerKind}`, type: 'credential', sourceSlug: 'source',
      })
      expect(restored.messages.find((message: { id: string; authStatus?: string }) => message.id === `auth-${blockerKind}`)?.authStatus).toBe('pending')
      expect(restored.permissionMode).toBe('allow-all')
      expect(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).toBeUndefined()
      expect(h.events.some(event => event.type === 'auth_completed' && event.sessionId === managed.id)).toBe(false)
      await cold.manager.flushSession(restored.id)
      expect(listSessions(h.rootPath).find(meta => meta.id === managed.id)).toMatchObject({
        permissionMode: 'allow-all',
        pendingQueuedMessageIds: [blockerId, 'queued-human-after-blocker'],
      })
    },
  )
});
