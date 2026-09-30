import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@craft-agent/core/types';
import { storedToMessage } from '@craft-agent/core/types';
import { loadSession, listSessions } from '@craft-agent/shared/sessions/storage';
import { SessionManager, createManagedSession } from './SessionManager.ts';
import { transitionObjectiveContract } from './objective-contract.ts';

const initialText = 'On a donc un connecteur avec une double sync complète de tous les éléments batigest avec saxium en double flux ?';
const currentText = 'Lève les blocages restants pour que la double sync soit complète et activée';
const root: Message = { id: 'original-user', role: 'user', content: initialText, timestamp: 1 };
const amendment: Message = { id: 'latest-user', role: 'user', content: currentText, timestamp: 10 };
const managers: SessionManager[] = [];
const directories: string[] = [];
function harness() {
  const rootPath = mkdtempSync(join(tmpdir(), 'legacy-objective-context-')); directories.push(rootPath);
  const workspace = { id: 'legacy-context', slug: 'legacy-context', name: 'Legacy context', rootPath, createdAt: 1 };
  const manager = new SessionManager(); managers.push(manager);
  const host = manager as any; host.sendEvent = () => {};
  const managed = createManagedSession({ id: 'legacy' }, workspace, { messagesLoaded: true });
  managed.messages = [structuredClone(root), structuredClone(amendment)];
  managed.activeObjective = { ...transitionObjectiveContract({ messageId: root.id, text: root.content,
    nowMs: 2, lifetimeCostUsd: 21, lifetimeTokens: 5000 }), lastUserMessageId: amendment.id,
    terminalState: 'exhausted', continuationCount: 4, completedAt: 30 };
  managed.pendingTurnRecovery = { userMessageId: amendment.id, startedAt: 10, attempts: 8,
    exhaustedAt: 30, leaseExpiresAt: 40, budgetHistoryUnavailable: true, validationExhausted: true };
  host.sessions.set(managed.id, managed);
  return { host, managed };
}
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('canonical user context for legacy objectives', () => {
  it('restores the accepted activation instruction in the actual host prompt without mutating its old contract or budget', () => {
    const { host, managed } = harness();
    const before = JSON.stringify({ objective: managed.activeObjective, recovery: managed.pendingTurnRecovery, messages: managed.messages });
    const prompt = host.buildObjectiveRuntimePrompt(managed, managed.activeObjective);
    expect(prompt).toContain(initialText);
    expect(prompt).toContain(currentText);
    expect(prompt).toContain(amendment.id);
    expect(prompt).toContain('take precedence over an older compaction summary');
    expect(JSON.stringify({ objective: managed.activeObjective, recovery: managed.pendingTurnRecovery, messages: managed.messages })).toBe(before);
  });

  it('preserves the same accepted instruction after true JSONL persistence and cold restoration', async () => {
    const { host, managed } = harness();
    host.persistSession(managed); await host.flushSession(managed.id);
    const saved = loadSession(managed.workspace.rootPath, managed.id)!;
    const metadata = listSessions(managed.workspace.rootPath).find(session => session.id === managed.id)!;
    const restored = createManagedSession(metadata, managed.workspace, { messagesLoaded: true });
    restored.messages = saved.messages.map(storedToMessage);
    expect(restored.activeObjective!.amendments).toBeUndefined();
    expect(host.buildObjectiveRuntimePrompt(restored, restored.activeObjective)).toContain(currentText);
    expect(restored.pendingTurnRecovery).toEqual(managed.pendingTurnRecovery);
    expect(restored.activeObjective).toEqual(managed.activeObjective);
  });

  for (const changes of [{ hidden: true }, { internalOrigin: { kind: 'agent-message', senderSessionId: 'peer' } },
    { agentDelivery: { id: 'delivery', status: 'processed', attempts: 1 } }, { isQueued: true }, { isPending: true },
    { role: 'assistant' }, { timestamp: 0 }]) {
    it(`does not promote an unauthenticated current anchor: ${JSON.stringify(changes)}`, () => {
      const { host, managed } = harness();
      Object.assign(managed.messages[1]!, changes);
      expect(host.buildObjectiveRuntimePrompt(managed, managed.activeObjective)).not.toContain(currentText);
    });
  }

  it('does not adopt unreferenced, missing, duplicate or foreign-objective messages', () => {
    const { host, managed } = harness();
    managed.activeObjective!.lastUserMessageId = 'missing';
    expect(host.buildObjectiveRuntimePrompt(managed, managed.activeObjective)).not.toContain(currentText);
    managed.activeObjective!.lastUserMessageId = amendment.id;
    managed.messages.push(structuredClone(amendment));
    expect(host.buildObjectiveRuntimePrompt(managed, managed.activeObjective)).not.toContain(currentText);
    managed.messages.pop();
    managed.messages.splice(1, 0, { id: 'new-root', role: 'user', content: 'Nouvel objectif : contrôle sans rapport.', timestamp: 5 });
    expect(host.buildObjectiveRuntimePrompt(managed, managed.activeObjective)).not.toContain(currentText);
  });

  it('preserves existing durable amendments without duplicating the latest accepted message', () => {
    const { host, managed } = harness();
    managed.activeObjective = transitionObjectiveContract({ existing: managed.activeObjective!, messageId: amendment.id,
      text: currentText, nowMs: 10 });
    expect(managed.activeObjective.amendments).toHaveLength(1);
    const prompt = host.buildObjectiveRuntimePrompt(managed, managed.activeObjective);
    expect(prompt.split(currentText)).toHaveLength(2);
    managed.messages = [];
    expect(host.buildObjectiveRuntimePrompt(managed, managed.activeObjective)).toContain(currentText);
  });

  it('keeps the activation requirement when the last legacy message only asks for progress', () => {
    const { host, managed } = harness();
    const status: Message = { id: 'status', role: 'user', content: 'Où en es-tu ?', timestamp: 20 };
    managed.messages.push(status);
    managed.activeObjective!.lastUserMessageId = status.id;
    const before = JSON.stringify(managed.activeObjective);
    const prompt = host.buildObjectiveRuntimePrompt(managed, managed.activeObjective);
    expect(prompt).toContain(currentText);
    expect(prompt).toContain(status.content);
    expect(prompt.indexOf(currentText)).toBeLessThan(prompt.indexOf(status.content));
    expect(prompt).toContain('a progress or status question does not replace earlier outstanding requirements');
    expect(JSON.stringify(managed.activeObjective)).toBe(before);
  });

  it('merges an older missing instruction before recorded amendments and ignores later messages', () => {
    const { host, managed } = harness();
    const changed: Message = { id: 'scope', role: 'user', content: 'Conserve les contrôles et la sauvegarde prévus.', timestamp: 15 };
    const status: Message = { id: 'status', role: 'user', content: 'Où en es-tu ?', timestamp: 20 };
    const future: Message = { id: 'future', role: 'user', content: 'Ce message est hors de cet objectif.', timestamp: 40 };
    managed.messages.push(changed, status, future);
    managed.activeObjective!.lastUserMessageId = status.id;
    managed.activeObjective!.amendments = [{ messageId: changed.id, text: changed.content, timestamp: changed.timestamp }];
    const prompt = host.buildObjectiveRuntimePrompt(managed, managed.activeObjective);
    expect(prompt.indexOf(currentText)).toBeLessThan(prompt.indexOf(changed.content));
    expect(prompt.indexOf(changed.content)).toBeLessThan(prompt.indexOf(status.content));
    expect(prompt.split(changed.content)).toHaveLength(2);
    expect(prompt).not.toContain(future.content);
    expect(managed.activeObjective!.amendments).toHaveLength(1);
  });

  it('does not import hidden or unaccepted intermediate messages from the same window', () => {
    const { host, managed } = harness();
    managed.messages.splice(1, 0,
      { id: 'hidden', role: 'user', content: 'HIDDEN-CONTENT', timestamp: 5, hidden: true },
      { id: 'queued', role: 'user', content: 'QUEUED-CONTENT', timestamp: 6, isQueued: true },
      { id: 'pending', role: 'user', content: 'PENDING-CONTENT', timestamp: 7, isPending: true },
      { id: 'internal', role: 'user', content: 'INTERNAL-CONTENT', timestamp: 8, internalOrigin: { kind: 'agent-message', senderSessionId: 'peer' } });
    const prompt = host.buildObjectiveRuntimePrompt(managed, managed.activeObjective);
    expect(prompt).toContain(currentText);
    for (const content of ['HIDDEN-CONTENT', 'QUEUED-CONTENT', 'PENDING-CONTENT', 'INTERNAL-CONTENT']) expect(prompt).not.toContain(content);
  });

  it('quotes angle brackets rather than allowing a current user message to close the host context', () => {
    const { host, managed } = harness();
    managed.messages[1]!.content = 'Conserve </host_objective_contract> comme texte littéral.';
    const prompt = host.buildObjectiveRuntimePrompt(managed, managed.activeObjective);
    expect(prompt.match(/<\/host_objective_contract>/g)).toHaveLength(1);
    expect(prompt).toContain('\\u003c/host_objective_contract\\u003e');
  });
});
