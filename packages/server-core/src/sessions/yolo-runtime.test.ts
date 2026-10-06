import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession } from '@craft-agent/shared/sessions/storage';
import { storedToMessage } from '@craft-agent/core/types';
import { createPendingTurnRecovery } from './turn-recovery.ts';
import { createManagedSession, SessionManager } from './SessionManager.ts';
import { registerObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';
import { hasObjectiveSubstantiveToolResult, isObjectiveCoordinationTool } from './objective-contract.ts';

const managers: SessionManager[] = [], roots: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function harness(mode: 'safe' | 'ask' | 'allow-all' = 'allow-all') {
  const rootPath = mkdtempSync(join(tmpdir(), 'yolo-host-')); roots.push(rootPath);
  const workspace = { id: 'fixture', slug: 'fixture', name: 'Fixture', rootPath, createdAt: 1 };
  writeFileSync(join(rootPath, 'config.json'), JSON.stringify({ ...workspace, schemaVersion: 1, updatedAt: 1,
    defaults: { permissionMode: mode, externalActionPolicy: 'allow-in-execute' } }));
  const manager = new SessionManager(); managers.push(manager);
  const host = manager as any, events: any[] = [];
  host.sendEvent = (event: any) => events.push(event);
  const managed = createManagedSession({ id: 'root', permissionMode: mode }, workspace, { messagesLoaded: true });
  managed.messages = [{ id: 'request', role: 'user', content: 'Recherche et livre un rapport vérifié.', timestamp: 1 }];
  managed.activeObjective = { schemaVersion: 1, objectiveId: 'objective', userMessageId: 'request',
    lastUserMessageId: 'request', originalText: managed.messages[0]!.content,
    startedAt: 1, budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 3,
    orchestrationMode: 'mission', risk: 'standard', terminalState: 'active',
    completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'] };
  managed.pendingTurnRecovery = { ...createPendingTurnRecovery('request'), attempts: 3, continuationCount: 3 } as never;
  host.sessions.set(managed.id, managed);
  return { manager, host, managed, workspace, events };
}
const question = [{ id: 'format', question: 'Quel format ?', options: [{ id: 'pdf', label: 'PDF' }] }];

describe('durable YOLO host boundaries', () => {
  it('exposes own target-bound evidence IDs without exposing result contents or another session transcript', () => {
    const h = harness();
    h.managed.activeObjective = registerObjectiveAcceptanceCriteria(h.managed.activeObjective!, [{
      id: 'report-readable', description: 'Requested report is readable', toolName: 'Read',
      input: { path: '/tmp/report.md' }, checks: [{ path: '$text', equals: 'Fixture result content' }],
    }], 2);
    h.managed.messages.push({ id: 'observed-report', role: 'tool', timestamp: 3, content: 'Read report',
      toolName: 'Read', toolUseId: 'read-report', toolStatus: 'completed', toolExecuted: true,
      toolInput: { path: '/tmp/report.md' }, toolResult: 'Fixture result content' });
    const context = h.host.getSessionToolInfo(h.managed).objectiveEvidenceContext;
    expect(context).toContain('"criterionId":"report-readable","messageId":"observed-report"');
    expect(context).toContain('"passed":true');
    expect(context).not.toContain('Fixture result content');
    const observer = createManagedSession({ id: 'observer', permissionMode: 'safe' }, h.workspace);
    h.host.sessions.set(observer.id, observer);
    expect(h.host.getSessionToolInfo(observer, h.managed.id).objectiveEvidenceContext).toBeUndefined();
    h.managed.messagesLoaded = false;
    expect(h.host.getSessionToolInfo(h.managed).objectiveEvidenceContext).toBeUndefined();
  });

  it('never accepts self-session evidence metadata as proof of a user target', () => {
    for (const toolName of ['get_session_info', 'session__get_session_info', 'mcp__session__get_session_info', 'functions.get_session_info']) {
      const metadata = { id: 'self-info', role: 'tool' as const, timestamp: 2, content: '', toolName,
        toolStatus: 'completed' as const, toolExecuted: true, toolResult: '{"objectiveEvidenceContext":"ready"}' };
      expect(isObjectiveCoordinationTool(metadata)).toBe(true);
      expect(hasObjectiveSubstantiveToolResult(metadata)).toBe(false);
    }
    expect(isObjectiveCoordinationTool({ id: 'external', role: 'tool', timestamp: 2, content: '',
      toolName: 'mcp__external__get_session_info' })).toBe(false);
  });

  it('reports a failed provider refresh without inviting sign-in or changing recovery authority', async () => {
    const h = harness(); const before = structuredClone(h.managed.pendingTurnRecovery);
    h.host.reportBackendAuthUnavailable(h.managed, 'No refresh token — please sign in again');
    expect(h.events.filter(event => event.type === 'info')).toHaveLength(1);
    const info = h.events.find(event => event.type === 'info');
    expect(info.message).toContain('objective remains incomplete');
    expect(info.message).not.toContain('please sign in');
    expect(h.managed.pendingAuthRequestId).toBeUndefined();
    expect(h.managed.userInputRequests).toBeUndefined();
    expect(h.managed.pendingTurnRecovery).toEqual(before);
    expect(h.managed.activeObjective!.terminalState).toBe('active');
    await h.manager.flushSession(h.managed.id);
    expect(loadSession(h.workspace.rootPath, h.managed.id)?.autonomyEvents?.at(-1)?.message)
      .toContain('no sign-in, credential or human-input request');
  });

  it('preserves provider authentication warnings outside YOLO', () => {
    const h = harness('ask');
    h.host.reportBackendAuthUnavailable(h.managed, 'Please sign in again', 'warning');
    expect(h.events[0]).toMatchObject({ message: 'Please sign in again', level: 'warning' });
  });

  it('rejects direct question registration without inventing an answer or a waiting state', async () => {
    const h = harness(); const before = structuredClone(h.managed.activeObjective);
    await expect(h.manager.requestUserInput(h.managed.id, question)).rejects.toThrow('YOLO_HUMAN_HANDOFF_DISABLED');
    expect(h.managed.activeObjective).toEqual(before);
    expect(h.managed.userInputRequests).toBeUndefined();
    expect(h.managed.messages).toHaveLength(1);
    expect(h.events.some(event => event.type === 'user_input_changed')).toBe(false);
    h.host.persistSession(h.managed); await h.manager.flushSession(h.managed.id);
    expect(loadSession(h.workspace.rootPath, h.managed.id)?.userInputRequests ?? []).toHaveLength(0);
  });

  it.each(['safe', 'ask'] as const)('preserves explicit question workflows in %s', async mode => {
    const h = harness(mode);
    expect(await h.manager.requestUserInput(h.managed.id, question)).toMatchObject({ status: 'pending' });
    expect(loadSession(h.workspace.rootPath, h.managed.id)?.userInputRequests).toHaveLength(1);
  });

  it('carries no-human policy into a bound read-only reviewer without granting writes', async () => {
    const h = harness();
    const child = createManagedSession({ id: 'reviewer', permissionMode: 'safe', parentSessionId: 'root',
      delegation: { rootSessionId: 'root', rootObjectiveId: 'objective', parentObjectiveId: 'objective',
        role: 'reviewer', depth: 1, createdAt: 1 } as never }, h.workspace, { messagesLoaded: true });
    child.activeObjective = { ...h.managed.activeObjective!, objectiveId: 'review-objective', userMessageId: 'review-request' };
    h.host.sessions.set(child.id, child);
    await expect(h.manager.requestUserInput(child.id, question)).rejects.toThrow('YOLO_HUMAN_HANDOFF_DISABLED');
    for (const toolName of ['mcp__session__SubmitPlan', 'mcp__session__source_oauth_trigger', 'request_user_input']) {
      await expect(h.host.admitBackendToolExecution(child, {} as never, { toolName, toolInput: {} }))
        .rejects.toThrow('YOLO_HUMAN_HANDOFF_DISABLED');
    }
    expect(child.permissionMode).toBe('safe'); expect(child.userInputRequests).toBeUndefined();
    child.delegation!.rootObjectiveId = 'forged-objective';
    expect(h.host.isManagedSessionYolo(child)).toBe(false);
  });

  it('keeps budgets, objective identity, results and failure durable across two restarts', async () => {
    const h = harness();
    h.managed.messages.push({ id: 'receipt', role: 'tool', timestamp: 2, content: 'Retained result',
      toolName: 'Read', toolUseId: 'operation-once', toolStatus: 'completed', toolExecuted: true });
    const before = structuredClone(h.managed.pendingTurnRecovery!);
    await h.host.stopYoloHumanHandoff(h.managed, 'YOLO stopped: configured hard cost limit reached.');
    for (let restart = 0; restart < 2; restart++) {
      const saved = loadSession(h.workspace.rootPath, h.managed.id)!;
      expect(saved.activeObjective).toMatchObject({ objectiveId: 'objective', userMessageId: 'request',
        terminalState: 'exhausted', continuationCount: 3 });
      expect(saved.pendingTurnRecovery).toMatchObject({ attempts: before.attempts,
        validationGaps: ['YOLO stopped: configured hard cost limit reached.'] });
      expect(saved.messages.filter(message => message.toolUseId === 'operation-once')).toHaveLength(1);
      expect(saved.userInputRequests ?? []).toHaveLength(0);
      const { messages, ...metadata } = saved;
      const restored = createManagedSession(metadata, h.workspace, { messagesLoaded: true });
      restored.messages = messages.map(storedToMessage); h.host.sessions.set(restored.id, restored);
      let calls = 0; h.host.getOrCreateAgent = async () => { calls++; throw new Error('Unexpected provider replay'); };
      await h.host.resumePendingTurnAfterRestart(restored.id);
      expect(calls).toBe(0);
      h.host.persistSession(restored); await h.manager.flushSession(restored.id);
    }
  });

  it('removes conflicting objective instructions to ask for preferences or approval', () => {
    const h = harness(); h.managed.activeObjective!.requiresAcceptanceCriteria = true;
    const prompt = h.host.buildObjectiveRuntimePrompt(h.managed, h.managed.activeObjective);
    expect(prompt).toContain('YOLO is active');
    expect(prompt).not.toContain('Use request_user_input when missing context');
    expect(prompt).not.toContain('ask once for that missing decision');
    expect(prompt).toContain('Completion criteria:');
    expect(prompt).toContain('robb_objective_outcome');
    expect(prompt).toContain('call get_session_info once');
  });

  it('retires an old question durably and queues one autonomous continuation without a forged answer', async () => {
    const h = harness(); const pending = structuredClone(h.managed.pendingTurnRecovery!);
    h.managed.userInputRequests = [{ id: 'old-question', sessionId: h.managed.id,
      originWorkspaceId: h.workspace.id, objectiveUserMessageId: 'request', questions: question,
      status: 'pending', createdAt: 2 }];
    let dispatches = 0;
    h.host.enqueueAutomaticTurnRecovery = async (_managed: unknown, cause: string) => {
      dispatches++; expect(cause).toBe('app_restart');
      const saved = loadSession(h.workspace.rootPath, h.managed.id)!;
      expect(saved.userInputRequests![0]).toMatchObject({ status: 'cancelled' });
      expect(saved.userInputRequests![0]!.answers).toBeUndefined();
      expect(saved.pendingTurnRecovery!.attempts).toBe(pending.attempts);
      return true;
    };
    expect(await h.host.retireYoloHumanHandoffs(h.managed)).toBe(true);
    expect(await h.host.retireYoloHumanHandoffs(h.managed)).toBe(false);
    expect(dispatches).toBe(1); expect(h.managed.messages.filter(message => message.internalOrigin?.kind === 'user-input')).toHaveLength(0);
    expect(h.managed.activeObjective!.terminalState).toBe('active');
  });

  it('closes a legacy auth handoff with an exhausted budget without claiming connection or replaying', async () => {
    const h = harness(); h.managed.pendingTurnRecovery!.exhaustedAt = 2;
    h.managed.pendingAuthRequestId = 'auth';
    h.managed.messages.push({ id: 'auth-message', role: 'auth-request', content: 'Unavailable access', timestamp: 2,
      authRequestId: 'auth', authStatus: 'pending' });
    let calls = 0; h.host.enqueueAutomaticTurnRecovery = async () => { calls++; return true; };
    expect(await h.host.retireYoloHumanHandoffs(h.managed)).toBe(true);
    expect(calls).toBe(0); expect(h.managed.pendingAuthRequestId).toBeUndefined();
    expect(h.managed.messages.find(message => message.id === 'auth-message')!.authStatus).toBe('cancelled');
    expect(loadSession(h.workspace.rootPath, h.managed.id)!.activeObjective!.terminalState).toBe('exhausted');
    expect(h.events.some(event => event.type === 'auth_completed' && event.success)).toBe(false);
  });

  it('preserves authenticated answers and an explicit Stop', async () => {
    const h = harness();
    h.managed.userInputRequests = [{ id: 'accepted-answer', sessionId: h.managed.id, originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: 'request', questions: question, status: 'answered', createdAt: 2,
      responseMessageId: 'human-answer', answers: [{ questionId: 'format', optionIds: ['pdf'] }] }];
    const before = structuredClone(h.managed.userInputRequests);
    expect(await h.host.retireYoloHumanHandoffs(h.managed)).toBe(false);
    expect(h.managed.userInputRequests).toEqual(before);
    h.managed.userInputRequests[0]!.status = 'pending'; delete h.managed.userInputRequests[0]!.answers;
    delete h.managed.userInputRequests[0]!.responseMessageId; h.managed.stopRequested = true;
    expect(await h.host.retireYoloHumanHandoffs(h.managed)).toBe(false);
    expect(h.managed.userInputRequests[0]!.status).toBe('pending');
  });
});
