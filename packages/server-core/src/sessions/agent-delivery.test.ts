import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { messageToStored, storedToMessage, type Message } from '@craft-agent/core/types';
import { getSessionFilePath, getSessionAttachmentsPath } from '@craft-agent/shared/sessions/storage';
import { acknowledgeDurableDelivery, agentDeliveryId, recoveredInternalMessageOptions, persistAgentDeliveryAttachments, restoreAgentDeliveryAttachments } from './agent-delivery.ts';
import { SessionManager, createManagedSession } from './SessionManager.ts';
import { transitionObjectiveContract } from './objective-contract.ts';

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
    const restored = storedToMessage(JSON.parse(JSON.stringify(messageToStored(message))));
    expect(recoveredInternalMessageOptions(restored)).toEqual({ hidden: true, internalOrigin: message.internalOrigin });
    expect(restored.agentDelivery).toEqual(message.agentDelivery);
  });
  it('requeues the original message if a user turn wins the dispatch race', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-dispatch-race-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'race', name: 'Race test' }, { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
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
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'terminal-race', name: 'Terminal race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
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
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'idle-terminal-flush-race', name: 'Idle terminal flush race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    const runtime = manager as unknown as { flushSession(id: string): Promise<void> };
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
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(disk[0].pendingAgentDeliveryIds).toEqual([]);
      expect(disk[0].pendingQueuedMessageIds).toEqual([]);
      expect(disk.some(entry => entry.agentDelivery?.id === 'idle-flush-receipt')).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });
  it('rolls back an unclaimed machine receipt if the busy target terminalizes during its queue flush', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-flush-race-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'terminal-flush-race', name: 'Terminal flush race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    const runtime = manager as unknown as {
      flushSession(id: string): Promise<void>;
      persistSession(session: typeof managed): void;
    };
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
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(disk[0].pendingAgentDeliveryIds).toEqual([]);
      expect(disk[0].pendingQueuedMessageIds).toEqual([]);
      expect(disk.some(entry => entry.agentDelivery?.id === 'late-flush-receipt')).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });
  it('cancels a dequeued but unclaimed machine receipt when the target terminalizes during its queue flush', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-dequeued-race-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'terminal-dequeued-race', name: 'Terminal dequeued race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    const runtime = manager as unknown as {
      flushSession(id: string): Promise<void>;
      processNextQueuedMessage(id: string): void;
      queuedMessageDispatches: Map<string, symbol>;
      queuedAgentDeliveryDispatches: Map<string, unknown>;
      agentDeliveryAppendsInFlight: Set<string>;
      automaticAdmissionReservations: Set<string>;
    };
    const flushSession = runtime.flushSession.bind(manager);
    let terminalizedAfterDequeue = false;
    runtime.flushSession = async id => {
      await flushSession(id);
      if (terminalizedAfterDequeue || !managed.messageQueue.some(item => item.messageId)) return;
      terminalizedAfterDequeue = true;
      managed.isProcessing = false;
      runtime.processNextQueuedMessage(managed.id);
      expect(managed.messageQueue).toEqual([]);
      expect(runtime.queuedMessageDispatches.has(managed.id)).toBe(true);
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
      expect(runtime.queuedMessageDispatches.has(managed.id)).toBe(false);
      expect(runtime.queuedAgentDeliveryDispatches.size).toBe(0);
      expect(runtime.agentDeliveryAppendsInFlight.size).toBe(0);
      expect(runtime.automaticAdmissionReservations.has(managed.id)).toBe(false);
      expect(managed.pendingAgentDeliveryIds ?? []).toEqual([]);
      expect(managed.pendingQueuedMessageIds ?? []).toEqual([]);
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(disk[0].pendingAgentDeliveryIds).toEqual([]);
      expect(disk[0].pendingQueuedMessageIds).toEqual([]);
      expect(disk.some(entry => entry.agentDelivery?.id === 'dequeued-flush-receipt')).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });
  it('preserves an atomically claimed dispatch while its durable receipt is still queued', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-claimed-transition-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'terminal-claimed-transition', name: 'Terminal claimed transition' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    type DispatchState = { sessionId: string; deliveryId: string; dispatchToken: symbol; claimed: boolean; dispatchSettled: boolean };
    const runtime = manager as unknown as {
      flushSession(id: string): Promise<void>;
      queuedMessageDispatches: Map<string, symbol>;
      queuedAgentDeliveryDispatches: Map<string, DispatchState>;
      agentDeliveryAppendsInFlight: Set<string>;
    };
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
      runtime.queuedAgentDeliveryDispatches.set(claimedMessageId, {
        sessionId: managed.id,
        deliveryId: 'claimed-transition-receipt',
        dispatchToken: consumedToken,
        claimed: true,
        dispatchSettled: false,
      });
      // This is the real transition window: sendMessage owns the turn and has
      // consumed the dequeue token, but has not yet persisted receipt=processing.
      runtime.queuedMessageDispatches.delete(managed.id);
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
      expect(runtime.queuedMessageDispatches.has(managed.id)).toBe(false);
      expect(managed.messageQueue).toEqual([]);
      expect(managed.messages.find(message => message.id === claimedMessageId)?.agentDelivery).toEqual({
        id: 'claimed-transition-receipt', status: 'queued', attempts: 0, attachmentsSha256: undefined,
      });
      expect(runtime.queuedAgentDeliveryDispatches.get(claimedMessageId!)).toMatchObject({ claimed: true });
      expect(runtime.agentDeliveryAppendsInFlight.has(claimedMessageId!)).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });
  it('cancels only the exact unclaimed receipt without disturbing a foreign active turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-foreign-turn-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'terminal-foreign-turn', name: 'Terminal foreign turn' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    const foreignMessage: Message = { id: 'foreign-turn', role: 'user', content: 'Already owned foreign turn.', timestamp: 2 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    type DispatchState = { sessionId: string; deliveryId: string; dispatchToken: symbol; claimed: boolean; dispatchSettled: boolean };
    const runtime = manager as unknown as {
      flushSession(id: string): Promise<void>;
      queuedMessageDispatches: Map<string, symbol>;
      queuedAgentDeliveryDispatches: Map<string, DispatchState>;
      agentDeliveryAppendsInFlight: Set<string>;
      automaticAdmissionReservations: Set<string>;
    };
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
      runtime.queuedAgentDeliveryDispatches.set(abandonedMessageId, {
        sessionId: managed.id,
        deliveryId: 'foreign-turn-receipt',
        dispatchToken: abandonedToken,
        claimed: false,
        dispatchSettled: false,
      });
      runtime.queuedMessageDispatches.set(managed.id, foreignToken);
      runtime.automaticAdmissionReservations.add(managed.id);
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
      expect(runtime.queuedMessageDispatches.get(managed.id)).toBe(foreignToken);
      expect(runtime.automaticAdmissionReservations.has(managed.id)).toBe(true);
      expect(runtime.queuedAgentDeliveryDispatches.has(abandonedMessageId!)).toBe(false);
      expect(runtime.agentDeliveryAppendsInFlight.has(abandonedMessageId!)).toBe(false);
      expect(managed.messages).toEqual([rootMessage, foreignMessage]);
      expect(managed.messageQueue).toEqual([]);
      expect(managed.pendingAgentDeliveryIds ?? []).toEqual([]);
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(disk.some(entry => entry.agentDelivery?.id === 'foreign-turn-receipt')).toBe(false);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });
  it('releases only the exact private dequeue when its callback loses ownership before claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-lost-dequeue-token-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'lost-dequeue-token', name: 'Lost dequeue token' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    type DispatchState = { sessionId: string; deliveryId: string; dispatchToken: symbol; claimed: boolean; dispatchSettled: boolean };
    const runtime = manager as unknown as {
      processNextQueuedMessage(id: string): void;
      queuedMessageDispatches: Map<string, symbol>;
      queuedAgentDeliveryDispatches: Map<string, DispatchState>;
      agentDeliveryAppendsInFlight: Set<string>;
    };
    const foreignToken = Symbol('newer-foreign-dispatch');
    try {
      await manager.sendMessage(managed.id, 'Queued receipt whose dequeue will be superseded', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'lost-token-receipt' },
      });
      const receiptMessage = managed.messages.find(message => message.agentDelivery?.id === 'lost-token-receipt')!;
      expect(receiptMessage.agentDelivery?.status).toBe('queued');
      expect(runtime.agentDeliveryAppendsInFlight.size).toBe(0);
      managed.isProcessing = false;
      runtime.processNextQueuedMessage(managed.id);
      const exactDispatch = runtime.queuedAgentDeliveryDispatches.get(receiptMessage.id)!;
      expect(exactDispatch).toMatchObject({ deliveryId: 'lost-token-receipt', claimed: false, dispatchSettled: false });
      expect(runtime.queuedMessageDispatches.get(managed.id)).toBe(exactDispatch.dispatchToken);
      runtime.queuedMessageDispatches.set(managed.id, foreignToken);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runtime.queuedAgentDeliveryDispatches.has(receiptMessage.id)).toBe(false);
      expect(runtime.queuedMessageDispatches.get(managed.id)).toBe(foreignToken);
      expect(receiptMessage.agentDelivery?.status).toBe('queued');
    } finally {
      runtime.queuedMessageDispatches.delete(managed.id);
      await manager.flushAllSessions();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('releases the exact private dequeue when its callback rejects before receipt processing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-dequeue-callback-failure-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'dequeue-callback-failure', name: 'Dequeue callback failure' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    const runtime = manager as unknown as {
      sendMessage: SessionManager['sendMessage'];
      processNextQueuedMessage(id: string): void;
      queuedMessageDispatches: Map<string, symbol>;
      queuedAgentDeliveryDispatches: Map<string, unknown>;
      agentDeliveryAppendsInFlight: Set<string>;
    };
    const sendMessage = runtime.sendMessage.bind(manager);
    try {
      await manager.sendMessage(managed.id, 'Queued receipt whose callback will fail', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'callback-failure-receipt' },
      });
      const receiptMessage = managed.messages.find(message => message.agentDelivery?.id === 'callback-failure-receipt')!;
      expect(runtime.agentDeliveryAppendsInFlight.size).toBe(0);
      runtime.sendMessage = async () => { throw new Error('synthetic failure before receipt processing'); };
      managed.isProcessing = false;
      runtime.processNextQueuedMessage(managed.id);
      expect(runtime.queuedAgentDeliveryDispatches.has(receiptMessage.id)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runtime.queuedAgentDeliveryDispatches.has(receiptMessage.id)).toBe(false);
      expect(runtime.queuedMessageDispatches.has(managed.id)).toBe(false);
      expect(receiptMessage.agentDelivery?.status).toBe('queued');
    } finally {
      runtime.sendMessage = sendMessage;
      await manager.flushAllSessions();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not delete a machine receipt already claimed while its original queue flush was in flight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-claimed-race-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'terminal-claimed-race', name: 'Terminal claimed race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    const runtime = manager as unknown as {
      flushSession(id: string): Promise<void>;
      persistSession(session: typeof managed): void;
    };
    const flushSession = runtime.flushSession.bind(manager);
    let claimedMessageId: string | undefined;
    runtime.flushSession = async id => {
      await flushSession(id);
      if (claimedMessageId !== undefined || !managed.messageQueue.length) return;
      claimedMessageId = managed.messageQueue.shift()!.messageId;
      const claimed = managed.messages.find(message => message.id === claimedMessageId)!;
      claimed.agentDelivery!.status = 'processing';
      claimed.agentDelivery!.attempts = 1;
      managed.activeObjective = { ...managed.activeObjective!, terminalState: 'complete_verified', completedAt: 2 };
      runtime.persistSession(managed);
      await flushSession(id);
    };
    let acknowledgements = 0;
    try {
      await expect(manager.sendMessage(managed.id, 'Claimed formatting correction', undefined, undefined, {
        hidden: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'parent', deliveryId: 'claimed-flush-receipt' },
      }, undefined, undefined, () => { acknowledgements++; })).rejects.toThrow('objective is terminal (complete_verified)');
      expect(acknowledgements).toBe(0);
      expect(claimedMessageId).toBeString();
      expect(managed.messageQueue).toEqual([]);
      expect(managed.messages.find(message => message.id === claimedMessageId)?.agentDelivery).toMatchObject({
        id: 'claimed-flush-receipt', status: 'processing', attempts: 1,
      });
      const disk = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(disk.some(entry => entry.id === claimedMessageId
        && entry.agentDelivery?.status === 'processing')).toBe(true);
    } finally { runtime.flushSession = flushSession; await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });
  it('deduplicates retries on disk, keeps terminal handoffs separate, and indexes pending deliveries for restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-inbox-'));
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'inbox', name: 'Inbox' }, { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    managed.isProcessing = true;
    (manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed);
    const options = { hidden: true, internalOrigin: { kind: 'agent-message' as const, senderSessionId: 'source', deliveryId: 'receipt1' } };
    const ids: string[] = [];
    const send = () => manager.sendMessage('inbox', 'Terminal result', undefined, undefined, options, undefined, undefined, id => {
      const disk = readFileSync(getSessionFilePath(root, 'inbox'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(disk[0].pendingAgentDeliveryIds).toContain(id);
      expect(disk.find(m => m.id === id).internalOrigin).toEqual(options.internalOrigin);
      ids.push(id);
    });
    try {
      await send(); await send();
      expect(ids[0]).toBe(ids[1]); expect(managed.messageQueue.length).toBe(1);
      await manager.sendMessage('inbox', 'Second result', undefined, undefined, { ...options, internalOrigin: { ...options.internalOrigin, deliveryId: 'receipt2' } });
      expect(managed.messageQueue.length).toBe(2);
      // Crash at the queue-to-processing seam: dequeue must not clear disk state.
      managed.isProcessing = false;
      const runtime = manager as unknown as { processNextQueuedMessage(id: string): void; sendMessage: (...args: unknown[]) => Promise<void> };
      runtime.sendMessage = async () => {};
      runtime.processNextQueuedMessage('inbox');
      runtime.processNextQueuedMessage('inbox');
      expect(managed.messageQueue.length).toBe(1); // Only one dispatch may be pending in the next tick.
      expect(managed.messages.find(m => m.id === ids[0])?.isQueued).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });
});
