import { describe, expect, it } from 'bun:test';
import { MissionSpecSchema, type MissionSpec } from '@craft-agent/shared/missions';
import type { CreateSessionOptions, Session } from '@craft-agent/shared/protocol';
import type { SessionCompletionEvent } from '../sessions/SessionManager.ts';
import type { MissionExecutionInput } from './MissionRuntime.ts';
import {
  SessionMissionExecutor,
  buildMissionSessionPrompt,
  type SessionMissionHost,
} from './SessionMissionExecutor.ts';

function fixture(): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'session-runtime-demo',
    title: 'Session runtime demo',
    objective: 'Produire un livrable vérifié',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission complète' }],
    originSessionId: 'origin-session',
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Planifier.' },
      { id: 'worker', role: 'worker', specialty: 'code', systemPrompt: 'Exécuter et tester.', skills: ['testing'] },
      { id: 'reviewer', role: 'reviewer', specialty: 'qualité', systemPrompt: 'Contrôler.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'global', systemPrompt: 'Superviser.' },
    ],
    policy: {},
    workItems: [
      {
        id: 'objective-one', kind: 'objective', title: 'Objectif',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objectif conforme' }],
      },
      {
        id: 'task-a', kind: 'task', title: 'Travail A', prompt: 'Faire A',
        parentId: 'objective-one', objectiveId: 'objective-one',
        acceptanceCriteria: [{ id: 'task-ok', description: 'Travail conforme' }],
        requiredEvidence: [{ id: 'test-a', description: 'Test A', kind: 'test' }],
      },
    ],
  });
}

function input(effect: 'read' | 'workspace-write' | 'external-mutation' = 'read'): MissionExecutionInput {
  const mission = fixture();
  const item = { ...mission.workItems.find((candidate) => candidate.id === 'task-a')!, effect };
  return {
    mission,
    item,
    profile: mission.agentProfiles.find((profile) => profile.id === 'worker')!,
    dispatchId: 'dispatch-1',
    upstream: [],
  };
}

const VALID_OUTPUT = JSON.stringify({
  summary: 'Travail terminé',
  outputRefs: ['artifact://a'],
  evidence: [{ requirementId: 'test-a', uri: 'test://a', kind: 'test' }],
});

class FakeHost implements SessionMissionHost {
  readonly sessions: Session[] = [];
  readonly sent: Array<{ sessionId: string; message: string }> = [];
  readonly listeners = new Set<(event: SessionCompletionEvent) => void>();
  output = VALID_OUTPUT;
  completionProof?: SessionCompletionEvent['executionProof'];
  completionTokenUsage?: SessionCompletionEvent['tokenUsage'];

  getSessions(): Session[] { return this.sessions; }
  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }
  async createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session> {
    const session = {
      id: `session-${this.sessions.length + 1}`,
      workspaceId,
      workspaceName: 'Test',
      lastMessageAt: Date.now(),
      messages: [],
      isProcessing: false,
      ...options,
    } as Session;
    this.sessions.push(session);
    return session;
  }
  async sendMessage(
    sessionId: string,
    message: string,
    _attachments?: never,
    _storedAttachments?: never,
    _options?: never,
    _existingMessageId?: string,
    _isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
  ): Promise<void> {
    const session = this.sessions.find((candidate) => candidate.id === sessionId)!;
    this.sent.push({ sessionId, message });
    session.messages.push({ id: 'user-1', role: 'user', content: message, timestamp: Date.now() });
    session.isProcessing = true;
    onAck?.('user-1');
    queueMicrotask(() => {
      session.messages.push({ id: 'assistant-1', role: 'assistant', content: this.output, timestamp: Date.now() });
      session.isProcessing = false;
      const event: SessionCompletionEvent = {
        sessionId,
        workspaceId: session.workspaceId,
        reason: 'complete',
        finalMessageId: 'assistant-1',
        finalText: this.output,
        ...(this.completionTokenUsage ? { tokenUsage: this.completionTokenUsage } : {}),
        ...(this.completionProof ? { executionProof: this.completionProof } : {}),
      };
      for (const listener of this.listeners) listener(event);
    });
  }
  onSessionComplete(listener: (event: SessionCompletionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getSessionFinalText(sessionId: string): string | undefined {
    const messages = this.sessions.find((session) => session.id === sessionId)?.messages ?? [];
    return [...messages].reverse().find((message) => message.role === 'assistant')?.content;
  }
}

describe('SessionMissionExecutor', () => {
  it('creates a specialist session with durable mission metadata and parses its submission', async () => {
    const host = new FakeHost();
    host.completionTokenUsage = {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      contextTokens: 100,
      costUsd: 0.003,
    };
    const executor = new SessionMissionExecutor({ host, workspaceId: 'workspace-1', workspaceRoot: '/tmp' });
    const assignment = input();
    const binding = await executor.prepare(assignment);
    const lifecycle: string[] = [];
    const result = await executor.execute(assignment, binding, {
      bindExternalExecution: (sessionId) => lifecycle.push(`bound:${sessionId}`),
      recordTurnAccepted: (sessionId, messageId) => lifecycle.push(`accepted:${sessionId}:${messageId}`),
    });

    expect(result.status).toBe('submission');
    expect(result.telemetry).toMatchObject({
      tokenUsage: { totalTokens: 125, costUsd: 0.003 },
    });
    expect(host.sessions).toHaveLength(1);
    expect(host.sessions[0]).toMatchObject({
      parentSessionId: 'origin-session',
      missionId: 'session-runtime-demo',
      missionWorkItemId: 'task-a',
      missionDispatchId: 'dispatch-1',
      missionRole: 'worker',
    });
    expect(host.sent[0]?.message).toContain('<mission-dispatch id="dispatch-1"');
    expect(host.sent[0]?.message).toContain('[skill:testing]');
    expect(lifecycle).toEqual(['bound:session-1', 'accepted:session-1:user-1']);
  });

  it('recovers a completed dispatch from its persisted marker without sending twice', async () => {
    const host = new FakeHost();
    const assignment = input();
    const prompt = buildMissionSessionPrompt(assignment);
    host.sessions.push({
      id: 'existing-session', workspaceId: 'workspace-1', workspaceName: 'Test',
      lastMessageAt: Date.now(), isProcessing: false,
      missionId: assignment.mission.id, missionWorkItemId: assignment.item.id,
      missionDispatchId: assignment.dispatchId, missionRole: 'worker',
      messages: [
        { id: 'user-1', role: 'user', content: prompt, timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: VALID_OUTPUT, timestamp: 2 },
      ],
    });
    const executor = new SessionMissionExecutor({ host, workspaceId: 'workspace-1', workspaceRoot: '/tmp' });
    const lifecycle: string[] = [];
    const result = await executor.execute(assignment, await executor.prepare(assignment), {
      bindExternalExecution: (sessionId) => lifecycle.push(`bound:${sessionId}`),
      recordTurnAccepted: (sessionId, messageId) => lifecycle.push(`accepted:${sessionId}:${messageId}`),
    });

    expect(result.status).toBe('submission');
    expect(host.sent).toHaveLength(0);
    expect(host.sessions).toHaveLength(1);
    expect(lifecycle).toEqual(['bound:existing-session', 'accepted:existing-session:user-1']);
  });

  it('blocks an external mutation when the host provides no reconciled proof', async () => {
    const host = new FakeHost();
    const assignment = input('external-mutation');
    const executor = new SessionMissionExecutor({ host, workspaceId: 'workspace-1', workspaceRoot: '/tmp' });
    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({ status: 'failed', retryable: false, ambiguousMutation: true });
  });
});
