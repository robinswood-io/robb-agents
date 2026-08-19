import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CreateSessionOptions, Session } from '@craft-agent/shared/protocol';
import type { ISessionManager } from '../handlers/session-manager-interface.ts';
import type { SessionCompletionEvent } from '../sessions/SessionManager.ts';
import { MissionPlanner } from './MissionPlanner.ts';

function validPlan(): string {
  return JSON.stringify({
    title: 'Mission planifiée',
    objective: 'Livrer un résultat vérifié',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission conforme' }],
    plannerProfileId: 'planner', defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer', supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Planifier.' },
      { id: 'worker', role: 'worker', specialty: 'travail', systemPrompt: 'Exécuter.' },
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
        id: 'task-one', kind: 'task', title: 'Travail', prompt: 'Faire le travail',
        parentId: 'objective-one', objectiveId: 'objective-one',
        acceptanceCriteria: [{ id: 'task-ok', description: 'Travail conforme' }],
      },
    ],
  });
}

class PlannerHost {
  readonly sessions: Session[] = [];
  readonly listeners = new Set<(event: SessionCompletionEvent) => void>();
  output = validPlan();
  lastOptions?: CreateSessionOptions;
  lastPrompt?: string;

  constructor(root: string) {
    this.sessions.push({
      id: 'origin', workspaceId: 'workspace-1', workspaceName: 'Test', lastMessageAt: Date.now(),
      messages: [], isProcessing: false, workingDirectory: root, projectId: 'project-1',
    });
  }

  getSessions(): Session[] { return this.sessions; }
  async getSession(id: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id === id) ?? null;
  }
  async createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session> {
    this.lastOptions = options;
    const session = {
      id: 'planner-session', workspaceId, workspaceName: 'Test', lastMessageAt: Date.now(),
      messages: [], isProcessing: false, ...options,
    } as Session;
    this.sessions.push(session);
    return session;
  }
  async sendMessage(
    sessionId: string,
    message: string,
    _a?: unknown,
    _b?: unknown,
    options?: { hidden?: boolean },
    _c?: unknown,
    _d?: unknown,
    onAck?: (messageId: string) => void,
  ): Promise<void> {
    expect(options?.hidden).toBe(true);
    this.lastPrompt = message;
    const session = this.sessions.find((candidate) => candidate.id === sessionId)!;
    session.messages.push({ id: 'planner-user', role: 'user', content: message, timestamp: Date.now(), hidden: true });
    session.isProcessing = true;
    onAck?.('planner-user');
    queueMicrotask(() => {
      session.messages.push({ id: 'planner-assistant', role: 'assistant', content: this.output, timestamp: Date.now() });
      session.isProcessing = false;
      const event: SessionCompletionEvent = {
        sessionId, workspaceId: session.workspaceId, reason: 'complete',
        finalMessageId: 'planner-assistant', finalText: this.output,
      };
      for (const listener of this.listeners) listener(event);
    });
  }
  onSessionComplete(listener: (event: SessionCompletionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getSessionFinalText(sessionId: string): string | undefined {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    return [...(session?.messages ?? [])].reverse().find((message) => message.role === 'assistant')?.content;
  }
}

describe('MissionPlanner', () => {
  let root: string;
  let host: PlannerHost;
  let planner: MissionPlanner;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mission-planner-'));
    host = new PlannerHost(root);
    planner = new MissionPlanner({
      host: host as unknown as ISessionManager,
      workspaceId: 'workspace-1',
      workspaceRoot: root,
      timeoutMs: 1_000,
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('durably accepts a dedicated planner turn and returns a host-bound valid preview', async () => {
    const started = await planner.start({ goal: 'Construire puis vérifier le livrable', originSessionId: 'origin' });
    expect(started.ack.plannerSessionId).toBe('planner-session');
    expect(host.lastOptions).toMatchObject({
      parentSessionId: 'origin', permissionMode: 'safe', missionRole: 'planner',
      missionWorkItemId: 'plan', missionDispatchId: started.ack.planRequestId,
    });
    expect(host.lastPrompt).toContain('<mission-plan-request');

    const result = await started.result;
    expect(result.status).toBe('planned');
    expect(result.spec).toMatchObject({
      id: started.ack.missionId,
      originSessionId: 'origin',
      plannerSessionId: 'planner-session',
      projectId: 'project-1',
      cwd: root,
    });
    expect((await planner.getPlan('planner-session')).spec).toEqual(result.spec);
  });

  it('returns validation issues instead of executing an invalid model plan', async () => {
    host.output = JSON.stringify({ title: 'Plan incomplet' });
    const result = await (await planner.start({ goal: 'Faire quelque chose', originSessionId: 'origin' })).result;
    expect(result.status).toBe('invalid');
    expect(result.issues?.length).toBeGreaterThan(0);
    expect(result.spec).toBeUndefined();
  });

  it('rejects a planner cwd outside the workspace before creating a session', async () => {
    await expect(planner.start({
      goal: 'Faire quelque chose', originSessionId: 'origin', cwd: `${root}-escape`,
    })).rejects.toThrow(/not authorized/);
    expect(host.sessions).toHaveLength(1);
  });
});
