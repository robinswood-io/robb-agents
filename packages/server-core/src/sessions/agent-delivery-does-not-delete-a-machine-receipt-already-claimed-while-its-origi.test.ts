import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Message } from "@craft-agent/core/types";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { SessionManager, createManagedSession } from "./SessionManager.ts";
import { transitionObjectiveContract } from "./objective-contract.ts";

describe('durable agent inbox — E05 E13', () => {
  it('does not delete a machine receipt already claimed while its original queue flush was in flight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-terminal-claimed-race-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'terminal-claimed-race', name: 'Terminal claimed race' },
      { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    const rootMessage: Message = { id: 'objective-root', role: 'user', content: 'Inspect the target.', timestamp: 1 };
    managed.messages.push(rootMessage);
    managed.activeObjective = transitionObjectiveContract({ messageId: rootMessage.id, text: rootMessage.content, nowMs: 1 });
    managed.isProcessing = true;
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
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
    const manager = withSessionOperationsForTest(new SessionManager());
    const managed = createManagedSession({ id: 'inbox', name: 'Inbox' }, { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true });
    managed.isProcessing = true;
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
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

  it('coalesces repeated queued progress deliveries from the same sender and preserves result capacity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-progress-coalesce-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const workspace = { id: 'ws', name: 'Workspace', rootPath: root, createdAt: 1 } as never;
    const managed = createManagedSession({ id: 'parent', name: 'Parent' }, workspace, { messagesLoaded: true });
    const sender = createManagedSession({
      id: 'worker-1',
      name: 'Worker 1',
      parentSessionId: 'parent',
      delegation: { rootSessionId: 'parent', rootObjectiveId: 'obj-1', parentObjectiveId: 'obj-1', depth: 1, role: 'worker' },
    }, workspace, { messagesLoaded: true });
    managed.isProcessing = true;
    managed.activeObjective = {
      ...transitionObjectiveContract({ messageId: 'obj-1', text: 'Fixture task.', nowMs: 1 }),
      objectiveId: 'obj-1',
    };
    const sessions = sessionRuntimeStateForTest(manager).sessions;
    sessions.set(managed.id, managed);
    sessions.set(sender.id, sender);
    try {
      for (let i = 1; i <= 5; i++) {
        await manager.sendMessage('parent', `Progress step ${i}`, undefined, undefined, {
          hidden: true,
          internalOrigin: {
            kind: 'agent-message',
            senderSessionId: 'worker-1',
            deliveryId: `progress-${i}`,
            agentMessageType: 'progress',
          },
        });
      }
      expect(managed.messageQueue).toHaveLength(1);
      expect(managed.messageQueue[0]?.message).toContain('Progress step 1');
      expect(managed.messageQueue[0]?.message).toContain('Progress step 5');
      expect(managed.messageQueue[0]?.options?.internalOrigin?.deliveryId).toBe('progress-5');
      await manager.sendMessage('parent', 'Final worker result', undefined, undefined, {
        hidden: true,
        internalOrigin: {
          kind: 'agent-message',
          senderSessionId: 'worker-1',
          deliveryId: 'result-1',
          agentMessageType: 'result',
        },
      });
      expect(managed.messageQueue).toHaveLength(2);
    } finally { await manager.flushAllSessions(); rmSync(root, { recursive: true, force: true }); }
  });
});
