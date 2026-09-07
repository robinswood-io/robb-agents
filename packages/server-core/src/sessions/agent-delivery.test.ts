import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { messageToStored, storedToMessage, type Message } from '@craft-agent/core/types';
import { getSessionFilePath, getSessionAttachmentsPath } from '@craft-agent/shared/sessions/storage';
import { acknowledgeDurableDelivery, agentDeliveryId, recoveredInternalMessageOptions, persistAgentDeliveryAttachments, restoreAgentDeliveryAttachments } from './agent-delivery.ts';
import { SessionManager, createManagedSession } from './SessionManager.ts';

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
      internalOrigin: { kind: 'agent-message', senderSessionId: 'source', deliveryId: id }, agentDelivery: { id, status: 'queued', attempts: 0 } };
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
