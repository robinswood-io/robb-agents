import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { cleanupRestartRecovery, type Managed, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('rejects a human continuation admitted while the Stop durability flush is in progress', async () => {
    const h = harness(); const managed = h.make('stop-flush-human-race')
    managed.isProcessing = true
    managed.processingGeneration = 1
    managed.agent = {
      forceAbort: () => {},
      isProcessing: () => true,
      dispose: async () => {},
    } as never
    await h.save(managed)

    const originalFlush = h.manager.flushSession.bind(h.manager)
    const stopFlushEntered = deferred(); const releaseStopFlush = deferred()
    let heldStopFlush = false
    h.manager.flushSession = async id => {
      if (!heldStopFlush && managed.stopRequested && managed.messageQueue.length === 0) {
        heldStopFlush = true
        // The Stop snapshot without the continuation is already durable. Keep
        // cancelProcessing suspended so a concurrent send exercises admission
        // during the exact post-sweep/pre-return window.
        await originalFlush(id)
        stopFlushEntered.resolve()
        await releaseStopFlush.promise
        return
      }
      await originalFlush(id)
    }

    const stopping = h.manager.cancelProcessing(managed.id)
    await stopFlushEntered.promise
    let acknowledged = false
    const rejected = h.manager.sendMessage(
      managed.id,
      'This continuation must not survive Stop.',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      () => { acknowledged = true },
    )
    await expect(rejected).rejects.toThrow('cancelled by Stop')
    expect(acknowledged).toBe(false)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.some(message => message.content === 'This continuation must not survive Stop.')).toBe(false)
    const duringStopRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(duringStopRows.some(row => row.content === 'This continuation must not survive Stop.')).toBe(false)

    releaseStopFlush.resolve()
    await stopping
    let resumed = 0
    h.runtime.processNextQueuedMessage = () => { resumed++ }
    await h.runtime.onProcessingStopped(managed.id, 'interrupted', managed.processingGeneration)
    await tick(); await tick()
    expect(resumed).toBe(0)
    expect(managed.messageQueue).toEqual([])
  })

  it('rejects a pre-Stop human send when hydration resumes after Stop has reset its flag', async () => {
    const h = harness(); const managed = h.make('stop-epoch-human-race')
    await h.save(managed)
    const originalEnsureMessagesLoaded = h.runtime.ensureMessagesLoaded.bind(h.runtime)
    const hydrationEntered = deferred(); const releaseHydration = deferred()
    let hydrationCalls = 0
    h.runtime.ensureMessagesLoaded = async (target: Managed) => {
      hydrationCalls++
      if (hydrationCalls === 1) {
        hydrationEntered.resolve()
        await releaseHydration.promise
      }
      await originalEnsureMessagesLoaded(target)
    }

    let acknowledged = false
    const sending = h.manager.sendMessage(
      managed.id,
      'This stale pre-Stop continuation must not be appended.',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      () => { acknowledged = true },
    )
    await hydrationEntered.promise
    await h.manager.cancelProcessing(managed.id)
    expect(managed.stopRequested).toBe(false)
    releaseHydration.resolve()
    await expect(sending).rejects.toThrow('cancelled by Stop')

    expect(acknowledged).toBe(false)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.some(message => message.content === 'This stale pre-Stop continuation must not be appended.')).toBe(false)
    const rows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(rows.some(row => row.content === 'This stale pre-Stop continuation must not be appended.')).toBe(false)
  })

  it('rolls back a fresh human turn when Stop wins its first durability acknowledgement', async () => {
    const h = harness(); const managed = h.make('stop-first-ack-human-race')
    managed.messages = []
    managed.activeObjective = undefined
    managed.pendingTurnRecovery = undefined
    await h.save(managed)

    const content = 'This first turn must not be acknowledged after Stop.'
    const originalFlush = h.manager.flushSession.bind(h.manager)
    const firstFlushEntered = deferred(); const releaseFirstFlush = deferred()
    let heldFirstFlush = false
    h.manager.flushSession = async id => {
      if (!heldFirstFlush && managed.isProcessing
        && managed.messages.some(message => message.content === content)) {
        heldFirstFlush = true
        await originalFlush(id)
        firstFlushEntered.resolve()
        await releaseFirstFlush.promise
        return
      }
      await originalFlush(id)
    }

    let acknowledged = false
    const sending = h.manager.sendMessage(
      managed.id, content, undefined, undefined, undefined, undefined, false,
      () => { acknowledged = true },
    )
    await firstFlushEntered.promise
    await h.manager.cancelProcessing(managed.id)
    releaseFirstFlush.resolve()

    await expect(sending).rejects.toThrow('cancelled by Stop')
    expect(acknowledged).toBe(false)
    expect(managed.isProcessing).toBe(false)
    expect(managed.stopRequested).toBe(false)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.some(message => message.content === content)).toBe(false)
    const rows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(rows.some(row => row.content === content)).toBe(false)
  })

  it('rolls back an unacknowledged fresh agent delivery when Stop wins its queue flush', async () => {
    const h = harness(); const managed = h.make('stop-agent-delivery-ack-race')
    const child = h.make('stop-agent-delivery-child', managed.id)
    const objectiveId = managed.activeObjective!.objectiveId ?? managed.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: managed.id, rootObjectiveId: objectiveId, parentObjectiveId: objectiveId,
      depth: 1, role: 'worker', finishedAt: 2,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 2 }
    managed.isProcessing = true
    managed.processingGeneration = 1
    managed.agent = {
      forceAbort: () => {}, isProcessing: () => true, dispose: async () => {},
    } as never
    await h.save(managed)

    const deliveryId = 'stop-agent-delivery-race-receipt'
    const content = 'Terminal child result must remain unacknowledged after Stop.'
    const originalFlush = h.manager.flushSession.bind(h.manager)
    const deliveryFlushEntered = deferred(); const releaseDeliveryFlush = deferred()
    let heldDeliveryFlush = false
    h.manager.flushSession = async id => {
      if (!heldDeliveryFlush && managed.messages.some(message => message.agentDelivery?.id === deliveryId)) {
        heldDeliveryFlush = true
        await originalFlush(id)
        deliveryFlushEntered.resolve()
        await releaseDeliveryFlush.promise
        return
      }
      await originalFlush(id)
    }

    let acknowledged = false
    const sending = h.manager.sendMessage(
      managed.id, content, undefined, undefined,
      { hidden: true, internalOrigin: {
        kind: 'agent-message', senderSessionId: child.id, deliveryId, agentMessageType: 'result',
      } },
      undefined, undefined, () => { acknowledged = true },
    )
    await deliveryFlushEntered.promise
    await h.manager.cancelProcessing(managed.id)
    releaseDeliveryFlush.resolve()

    await expect(sending).rejects.toThrow('agent delivery was cancelled by Stop')
    expect(acknowledged).toBe(false)
    expect(managed.messageQueue.some(item => item.options?.internalOrigin?.deliveryId === deliveryId)).toBe(false)
    expect(managed.messages.some(message => message.agentDelivery?.id === deliveryId)).toBe(false)
    const rows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(rows.some(row => row.agentDelivery?.id === deliveryId)).toBe(false)

    let resumed = 0
    h.runtime.processNextQueuedMessage = () => { resumed++ }
    await h.runtime.onProcessingStopped(managed.id, 'interrupted', 1)
    await tick(); await tick()
    expect(resumed).toBe(0)
    expect(managed.messageQueue).toEqual([])
  })

  it('Stop invalidates a scheduled internal nudge without a message ID', async () => {
    const h = harness(); const managed = h.make('nudge-stop')
    managed.messageQueue.push({ message: 'Background result is ready' })
    let calls = 0
    h.manager.sendMessage = async () => { calls++ }
    h.runtime.processNextQueuedMessage(managed.id)
    await h.manager.cancelProcessing(managed.id)
    await tick(); await tick()
    expect(calls).toBe(0)
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.pendingTurnRecovery).toBeUndefined()
  })
});
