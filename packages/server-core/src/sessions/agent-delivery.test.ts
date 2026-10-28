import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { messageToStored, storedToMessage, type Message } from "@craft-agent/core/types";
import { getSessionFilePath, getSessionAttachmentsPath } from "@craft-agent/shared/sessions/storage";
import { acknowledgeDurableDelivery, agentDeliveryId, recoveredInternalMessageOptions, persistAgentDeliveryAttachments, restoreAgentDeliveryAttachments } from "./agent-delivery.ts";
import { SessionManager, createManagedSession } from "./SessionManager.ts";
import { transitionObjectiveContract } from "./objective-contract.ts";

describe('durable agent inbox — E05 E13', () => {
  it('recovers exact attachment bytes and rejects tampering or a different version', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-attachment-'));
    try {
      const attachments = [{ type: 'text' as const, path: '/tmp/report.txt', name: 'report.txt', mimeType: 'text/plain', text: 'version one', size: 11 }];
      const digest = persistAgentDeliveryAttachments(root, 'target', attachments)!;
      expect(persistAgentDeliveryAttachments(root, 'target', attachments)).toBe(digest);
      expect(restoreAgentDeliveryAttachments(root, 'target', digest)).toEqual(attachments);
      const updated = [{ ...attachments[0]!, text: 'version two' }];
      expect(agentDeliveryId('source','goal','target','result',updated)).not.toBe(agentDeliveryId('source','goal','target','result',attachments));
      writeFileSync(join(getSessionAttachmentsPath(root, 'target'), `delivery-${digest}.json`), 'tampered');
      expect(() => restoreAgentDeliveryAttachments(root, 'target', digest)).toThrow('integrity');
      expect(() => restoreAgentDeliveryAttachments(root, 'target', '../escape')).toThrow('Invalid');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('acknowledges durable receipt while the recipient is still running, and surfaces pre-ack errors', async () => {
    let complete!: () => void;
    const running = new Promise<void>(resolve => { complete = resolve; });
    const result = await acknowledgeDurableDelivery(async ack => { ack('persisted'); await running; }, () => {});
    expect(result).toBe('persisted'); complete();
    await expect(acknowledgeDurableDelivery(async () => { throw new Error('disk failed'); }, () => {})).rejects.toThrow('disk failed');
    await expect(acknowledgeDurableDelivery(async () => {}, () => {})).rejects.toThrow('did not acknowledge');
  });

  it('separates objectives and retains hidden provenance through serialization', () => {
    const id = agentDeliveryId('source', 'goal1', 'target', 'result');
    expect(agentDeliveryId('source', 'goal1', 'target', 'result')).toBe(id);
    expect(agentDeliveryId('source', 'goal2', 'target', 'result')).not.toBe(id);
    const message: Message = { id: 'm', role: 'user', timestamp: 1, content: 'result', hidden: true, isQueued: true,
      internalOrigin: {
        kind: 'agent-message', senderSessionId: 'source', deliveryId: id,
        agentMessageType: 'result',
      }, agentDelivery: { id, status: 'queued', attempts: 0 } };
    const stored = messageToStored(message);
    const restored = storedToMessage(JSON.parse(JSON.stringify(stored)) as typeof stored);
    expect(recoveredInternalMessageOptions(restored)).toEqual({ hidden: true, internalOrigin: requiredTestValue(message.internalOrigin) });
    expect(restored.agentDelivery).toEqual(message.agentDelivery);
  });

  it('requeues the original message if a user turn wins the dispatch race', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-dispatch-race-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'race', name: 'Race test' }, { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    managed.messages.push({ id: 'original', role: 'user', content: 'result', timestamp: 1, isQueued: true, hidden: true });
    managed.isProcessing = true;
    try {
      await manager.sendMessage('race', 'result', undefined, undefined, { hidden: true, internalOrigin: { kind: 'agent-message' } }, 'original');
      expect(managed.messages.map(m => m.id)).toEqual(['original']);
      expect(managed.messageQueue.map(m => m.messageId)).toEqual(['original']);
    } finally { await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a fresh machine delivery if the target terminalizes during admission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-race-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'terminal-race', name: 'Terminal race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    const beforeMessages = structuredClone(managed.messages);
    const sending = manager.sendMessage(managed.id, 'Late formatting correction', undefined, undefined, {
      hidden: true,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'late-receipt' },
    });
    managed.activeObjective = { ...managed.activeObjective, terminalState: 'complete_verified', completedAt: 2 };
    try {
      await expect(sending).rejects.toThrow('objective is terminal (complete_verified)');
      expect(managed.messages).toEqual(beforeMessages);
      expect(managed.messageQueue).toEqual([]);
      expect(managed.pendingAgentDeliveryIds ?? []).toEqual([]);
      expect(managed.pendingQueuedMessageIds ?? []).toEqual([]);
      expect(managed.activeObjective.terminalState).toBe('complete_verified');
    } finally { await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rolls back an unclaimed machine receipt if an idle target terminalizes during its first flush', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-idle-terminal-flush-race-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'idle-terminal-flush-race', name: 'Idle terminal flush race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    const runtime = sessionManagerForTest(manager);
    const flushSession = runtime.flushSession.bind(manager);
    let terminalizedDuringFirstFlush = false;
    runtime.flushSession = async id => {
      await flushSession(id);
      if (!terminalizedDuringFirstFlush && managed.messages.some(message => message.agentDelivery?.id === 'idle-flush-receipt')) {
        terminalizedDuringFirstFlush = true;
        managed.activeObjective = { ...managed.activeObjective!, terminalState: 'complete_verified', completedAt: 2 };
        managed.isProcessing = false;
      }
    };
    let acknowledgements = 0;
    try {
      await expect(manager.sendMessage(managed.id, 'Late idle correction', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'idle-flush-receipt' },
      }, undefined, undefined, () => { acknowledgements++; })).rejects.toThrow('objective is terminal (complete_verified)');
      expect(terminalizedDuringFirstFlush).toBe(true);
      expect(acknowledgements).toBe(0);
      expect(managed.messages).toEqual([rootMessage]);
      expect(managed.messageQueue).toEqual([]);
      expect(managed.pendingAgentDeliveryIds ?? []).toEqual([]);
      expect(managed.pendingQueuedMessageIds ?? []).toEqual([]);
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => parseRecoveryJournalObservation(line));
      expect(requiredTestValue(disk[0]).pendingAgentDeliveryIds).toEqual([]);
      expect(requiredTestValue(disk[0]).pendingQueuedMessageIds).toEqual([]);
      expect(disk.some(entry => entry.agentDelivery?.id === 'idle-flush-receipt')).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rolls back an unclaimed machine receipt if the busy target terminalizes during its queue flush', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-flush-race-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'terminal-flush-race', name: 'Terminal flush race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    const runtime = sessionManagerForTest(manager);
    const flushSession = runtime.flushSession.bind(manager);
    let terminalizedDuringQueueFlush = false;
    runtime.flushSession = async id => {
      await flushSession(id);
      if (!terminalizedDuringQueueFlush && managed.messageQueue.some(item => item.messageId)) {
        terminalizedDuringQueueFlush = true;
        managed.activeObjective = { ...managed.activeObjective!, terminalState: 'complete_verified', completedAt: 2 };
        managed.isProcessing = false;
      }
    };
    let acknowledgements = 0;
    try {
      await expect(manager.sendMessage(managed.id, 'Late formatting correction', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'late-flush-receipt' },
      }, undefined, undefined, () => { acknowledgements++; })).rejects.toThrow('objective is terminal (complete_verified)');
      expect(terminalizedDuringQueueFlush).toBe(true);
      expect(acknowledgements).toBe(0);
      expect(managed.messages).toEqual([rootMessage]);
      expect(managed.messageQueue).toEqual([]);
      expect(managed.pendingAgentDeliveryIds ?? []).toEqual([]);
      expect(managed.pendingQueuedMessageIds ?? []).toEqual([]);
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => parseRecoveryJournalObservation(line));
      expect(requiredTestValue(disk[0]).pendingAgentDeliveryIds).toEqual([]);
      expect(requiredTestValue(disk[0]).pendingQueuedMessageIds).toEqual([]);
      expect(disk.some(entry => entry.agentDelivery?.id === 'late-flush-receipt')).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });

  it('cancels a dequeued but unclaimed machine receipt when the target terminalizes during its queue flush', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-dequeued-race-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'terminal-dequeued-race', name: 'Terminal dequeued race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    const runtime = sessionManagerForTest(manager);
    const flushSession = runtime.flushSession.bind(manager);
    let terminalizedAfterDequeue = false;
    runtime.flushSession = async id => {
      await flushSession(id);
      if (terminalizedAfterDequeue || !managed.messageQueue.some(item => item.messageId)) return;
      terminalizedAfterDequeue = true;
      managed.isProcessing = false;
      runtime.processNextQueuedMessage(managed.id);
      expect(managed.messageQueue).toEqual([]);
      expect(sessionRuntimeStateForTest(manager).queuedMessageDispatches.has(managed.id)).toBe(true);
      managed.activeObjective = { ...managed.activeObjective!, terminalState: 'complete_verified', completedAt: 2 };
    };
    let acknowledgements = 0;
    try {
      await expect(manager.sendMessage(managed.id, 'Dequeued formatting correction', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'dequeued-flush-receipt' },
      }, undefined, undefined, () => { acknowledgements++; })).rejects.toThrow('objective is terminal (complete_verified)');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(terminalizedAfterDequeue).toBe(true);
      expect(acknowledgements).toBe(0);
      expect(managed.isProcessing).toBe(false);
      expect(managed.messages).toEqual([rootMessage]);
      expect(managed.messageQueue).toEqual([]);
      expect(sessionRuntimeStateForTest(manager).queuedMessageDispatches.has(managed.id)).toBe(false);
      expect(sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.size).toBe(0);
      expect(sessionRuntimeStateForTest(manager).agentDeliveryAppendsInFlight.size).toBe(0);
      expect(sessionRuntimeStateForTest(manager).automaticAdmissionReservations.has(managed.id)).toBe(false);
      expect(managed.pendingAgentDeliveryIds ?? []).toEqual([]);
      expect(managed.pendingQueuedMessageIds ?? []).toEqual([]);
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => parseRecoveryJournalObservation(line));
      expect(requiredTestValue(disk[0]).pendingAgentDeliveryIds).toEqual([]);
      expect(requiredTestValue(disk[0]).pendingQueuedMessageIds).toEqual([]);
      expect(disk.some(entry => entry.agentDelivery?.id === 'dequeued-flush-receipt')).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves an atomically claimed dispatch while its durable receipt is still queued', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-claimed-transition-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'terminal-claimed-transition', name: 'Terminal claimed transition' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    
    const runtime = sessionManagerForTest(manager);
    const flushSession = runtime.flushSession.bind(manager);
    let claimedMessageId: string | undefined;
    runtime.flushSession = async id => {
      await flushSession(id);
      if (claimedMessageId !== undefined) return;
      const queued = managed.messageQueue.find(item => item.messageId);
      if (!queued?.messageId) return;
      claimedMessageId = queued.messageId;
      managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== claimedMessageId);
      const consumedToken = Symbol('claimed-agent-delivery');
      sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.set(claimedMessageId, {
        sessionId: managed.id,
        deliveryId: 'claimed-transition-receipt',
        dispatchToken: consumedToken,
        claimed: true,
        providerStarted: false, dispatchSettled: false,
      });
      // This is the real transition window: sendMessage owns the turn and has
      // consumed the dequeue token, but has not yet persisted receipt=processing.
      sessionRuntimeStateForTest(manager).queuedMessageDispatches.delete(managed.id);
      managed.processingGeneration++;
      managed.isProcessing = true;
      managed.activeObjective = { ...managed.activeObjective!, terminalState: 'complete_verified', completedAt: 2 };
    };
    let acknowledgements = 0;
    try {
      await expect(manager.sendMessage(managed.id, 'Claimed transitional correction', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'claimed-transition-receipt' },
      }, undefined, undefined, () => { acknowledgements++; })).rejects.toThrow('objective is terminal (complete_verified)');
      expect(acknowledgements).toBe(0);
      expect(claimedMessageId).toBeString();
      expect(managed.isProcessing).toBe(true);
      expect(sessionRuntimeStateForTest(manager).queuedMessageDispatches.has(managed.id)).toBe(false);
      expect(managed.messageQueue).toEqual([]);
      const receipt = requiredTestValue(managed.messages.find(message => message.id === claimedMessageId)?.agentDelivery);
      expect<unknown>(receipt).toEqual({attachmentsSha256: undefined,  id: 'claimed-transition-receipt', status: 'queued', attempts: 0 });
      expect(Object.hasOwn(receipt, 'attachmentsSha256')).toBe(false);
      expect(sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.get(claimedMessageId!)).toMatchObject({ claimed: true });
      expect(sessionRuntimeStateForTest(manager).agentDeliveryAppendsInFlight.has(claimedMessageId!)).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });

  it('cancels only the exact unclaimed receipt without disturbing a foreign active turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-foreign-turn-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'terminal-foreign-turn', name: 'Terminal foreign turn' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    const foreignMessage: Message = { id: 'foreign-turn', role: 'user', content: 'Already owned foreign turn.', timestamp: 2 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    
    const runtime = sessionManagerForTest(manager);
    const flushSession = runtime.flushSession.bind(manager);
    const abandonedToken = Symbol('abandoned-agent-delivery');
    const foreignToken = Symbol('foreign-active-turn');
    let abandonedMessageId: string | undefined;
    runtime.flushSession = async id => {
      await flushSession(id);
      if (abandonedMessageId !== undefined) return;
      const queued = managed.messageQueue.find(item => item.messageId);
      if (!queued?.messageId) return;
      abandonedMessageId = queued.messageId;
      managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== abandonedMessageId);
      sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.set(abandonedMessageId, {
        sessionId: managed.id,
        deliveryId: 'foreign-turn-receipt',
        dispatchToken: abandonedToken,
        claimed: false,
        providerStarted: false, dispatchSettled: false,
      });
      sessionRuntimeStateForTest(manager).queuedMessageDispatches.set(managed.id, foreignToken);
      sessionRuntimeStateForTest(manager).automaticAdmissionReservations.add(managed.id);
      managed.messages.push(foreignMessage);
      managed.processingGeneration++;
      managed.isProcessing = true;
      managed.activeObjective = { ...managed.activeObjective!, terminalState: 'complete_verified', completedAt: 2 };
    };
    let acknowledgements = 0;
    try {
      await expect(manager.sendMessage(managed.id, 'Abandoned formatting correction', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'foreign-turn-receipt' },
      }, undefined, undefined, () => { acknowledgements++; })).rejects.toThrow('objective is terminal (complete_verified)');
      expect(acknowledgements).toBe(0);
      expect(abandonedMessageId).toBeString();
      expect(managed.isProcessing).toBe(true);
      expect(sessionRuntimeStateForTest(manager).queuedMessageDispatches.get(managed.id)).toBe(foreignToken);
      expect(sessionRuntimeStateForTest(manager).automaticAdmissionReservations.has(managed.id)).toBe(true);
      expect(sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.has(abandonedMessageId!)).toBe(false);
      expect(sessionRuntimeStateForTest(manager).agentDeliveryAppendsInFlight.has(abandonedMessageId!)).toBe(false);
      expect(managed.messages).toEqual([rootMessage, foreignMessage]);
      expect(managed.messageQueue).toEqual([]);
      expect(managed.pendingAgentDeliveryIds ?? []).toEqual([]);
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => parseRecoveryJournalObservation(line));
      expect(disk.some(entry => entry.agentDelivery?.id === 'foreign-turn-receipt')).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });

  it('releases only the exact private dequeue when its callback loses ownership before claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-lost-dequeue-token-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'lost-dequeue-token', name: 'Lost dequeue token' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    
    const runtime = sessionManagerForTest(manager);
    const foreignToken = Symbol('newer-foreign-dispatch');
    try {
      await manager.sendMessage(managed.id, 'Queued receipt whose dequeue will be superseded', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'lost-token-receipt' },
      });
      const receiptMessage = managed.messages.find(message => message.agentDelivery?.id === 'lost-token-receipt')!;
      expect(receiptMessage.agentDelivery?.status).toBe('queued');
      expect(sessionRuntimeStateForTest(manager).agentDeliveryAppendsInFlight.size).toBe(0);
      managed.isProcessing = false;
      runtime.processNextQueuedMessage(managed.id);
      const exactDispatch = sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.get(receiptMessage.id)!;
      expect(exactDispatch).toMatchObject({ deliveryId: 'lost-token-receipt', claimed: false, providerStarted: false, dispatchSettled: false });
      expect(sessionRuntimeStateForTest(manager).queuedMessageDispatches.get(managed.id)).toBe(exactDispatch.dispatchToken);
      sessionRuntimeStateForTest(manager).queuedMessageDispatches.set(managed.id, foreignToken);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.has(receiptMessage.id)).toBe(false);
      expect(sessionRuntimeStateForTest(manager).queuedMessageDispatches.get(managed.id)).toBe(foreignToken);
      expect(receiptMessage.agentDelivery?.status).toBe('queued');
    } finally {
      sessionRuntimeStateForTest(manager).queuedMessageDispatches.delete(managed.id);
      await manager.flushAllSessions();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases the exact private dequeue when its callback rejects before receipt processing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-dequeue-callback-failure-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'dequeue-callback-failure', name: 'Dequeue callback failure' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    const runtime = sessionManagerForTest(manager);
    const sendMessage = runtime.sendMessage.bind(manager);
    try {
      await manager.sendMessage(managed.id, 'Queued receipt whose callback will fail', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'callback-failure-receipt' },
      });
      const receiptMessage = managed.messages.find(message => message.agentDelivery?.id === 'callback-failure-receipt')!;
      expect(sessionRuntimeStateForTest(manager).agentDeliveryAppendsInFlight.size).toBe(0);
      runtime.sendMessage = async () => { throw new Error('synthetic failure before receipt processing'); };
      managed.isProcessing = false;
      runtime.processNextQueuedMessage(managed.id);
      expect(sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.has(receiptMessage.id)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sessionRuntimeStateForTest(manager).queuedAgentDeliveryDispatches.has(receiptMessage.id)).toBe(false);
      expect(sessionRuntimeStateForTest(manager).queuedMessageDispatches.has(managed.id)).toBe(false);
      expect(receiptMessage.agentDelivery?.status).toBe('queued');
    } finally {
      runtime.sendMessage = sendMessage;
      await manager.flushAllSessions();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
