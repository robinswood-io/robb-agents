import { describe, expect, it } from 'bun:test';
import { MissionSpecSchema, type MissionSpec } from '@craft-agent/shared/missions';
import type { StoredAttachment } from '@craft-agent/core/types';
import type {
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  Session,
} from '@craft-agent/shared/protocol';
import type {
  MissionPendingTurnRecoveryClaim,
  SessionCompletionEvent,
} from '../sessions/SessionManager.ts';
import type { MissionExecutionInput } from './MissionRuntime.ts';
import type { MissionCapabilityLock } from '@craft-agent/shared/sessions';
import { specializedProfileCapabilityEnvelopeIdentity } from '@craft-agent/shared/specialized-profiles';
import {
  SessionMissionExecutor,
  buildMissionSessionPrompt,
  type MissionToolInvocationPreflightInput,
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

function reviewInput(): MissionExecutionInput {
  const mission = fixture();
  const objective = mission.workItems.find((candidate) => candidate.id === 'objective-one')!;
  return {
    mission,
    item: {
      id: 'review-objective-one-0',
      kind: 'objective-review',
      title: 'Review objective one',
      reviewTargetId: objective.id,
      acceptanceCriteria: objective.acceptanceCriteria,
      requiredEvidence: [],
      dependsOn: ['task-a'],
      effect: 'read',
    },
    profile: mission.agentProfiles.find((profile) => profile.role === 'reviewer')!,
    dispatchId: 'review-dispatch-1',
    upstream: [],
  };
}

function specializedInput(): MissionExecutionInput {
  const assignment = input();
  assignment.profile = {
    ...assignment.profile,
    model: 'evaluated-model',
    llmConnection: 'evaluated-connection',
    thinkingLevel: 'high',
  };
  assignment.specializedProfile = {
    schemaVersion: 1,
    profileId: assignment.profile.id,
    profileVersion: 1,
    selectedState: 'opt-in',
    lifecycleEntryTransitionSequence: 4,
    registryRevisionAtSelection: 7,
    registryHeadSha256AtSelection: 'a'.repeat(64),
    versionSha256: 'b'.repeat(64),
    capabilityEnvelopeSha256: specializedProfileCapabilityEnvelopeIdentity([
      { kind: 'workspace-read', name: 'workspace' },
    ]),
    executionRouteSha256: 'd'.repeat(64),
    currentState: 'opt-in',
    currentRegistryRevision: 7,
    currentRegistryHeadSha256: 'a'.repeat(64),
    provenance: {
      method: 'mission-pattern',
      proposedBy: { kind: 'service', actorId: 'foundry' },
      generatedBy: { name: 'foundry', version: '1' },
      generatedAt: '2026-09-20T00:00:00.000Z',
      sample: { rawTaskCount: 20, deduplicatedRootTaskCount: 20 },
      sources: [{ kind: 'mission', sourceId: 'source', sha256: 'e'.repeat(64), redacted: true }],
    },
    capabilityEnvelope: [{ kind: 'workspace-read', name: 'workspace' }],
  };
  return assignment;
}

function ordinaryRouteInput(): MissionExecutionInput {
  const assignment = input();
  assignment.profile = {
    ...assignment.profile,
    llmConnection: 'ordinary-connection',
    model: 'ordinary-model',
    thinkingLevel: 'high',
  };
  assignment.ordinaryRoutePin = {
    schemaVersion: 1,
    routeDecisionSha256: '1'.repeat(64),
    routeConfigIdentitySha256: '2'.repeat(64),
    connectionIdentitySha256: '3'.repeat(64),
    sourceIdentitySha256: '4'.repeat(64),
    agentProfileId: assignment.profile.id,
    connectionSlug: 'ordinary-connection',
    version: 2,
    profile: 'balanced',
    origin: 'mission',
    model: 'ordinary-model',
    thinkingLevel: 'high',
    measuredMissionUsd: 0,
    effectiveSourceSlugs: [],
    effectiveSourceBindings: [],
    cwd: '/tmp',
  };
  return assignment;
}

const VALID_OUTPUT = JSON.stringify({
  summary: 'Travail terminé',
  outputRefs: ['artifact://a'],
  evidence: [{ requirementId: 'test-a', uri: 'test://a', kind: 'test' }],
});

const VALID_REVIEW_OUTPUT = JSON.stringify({
  targetType: 'objective',
  targetId: 'objective-one',
  result: 'pass',
  summary: 'Contrôle indépendant réussi',
  criteria: [{
    criterionId: 'objective-ok',
    result: 'pass',
    evidenceRefs: ['tool://rbw-servers/ssh_execute'],
    explanation: 'La lecture enregistrée confirme le critère.',
  }],
  affectedWorkItemIds: [],
  corrections: [],
});

function addOriginAcceptanceContract(
  host: FakeHost,
  command: string,
): void {
  host.sessions.push({
    id: 'origin-session',
    workspaceId: 'workspace-1',
    workspaceName: 'Test',
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: false,
    activeObjective: {
      schemaVersion: 1,
      originalText: 'Vérifier le serveur avec le contrat enregistré.',
      userMessageId: 'origin-message',
      startedAt: 1,
      budgetBaselineUsd: 0,
      tokenBaseline: 0,
      continuationCount: 0,
      orchestrationMode: 'mission',
      risk: 'high-stakes',
      completionCriteria: ['requested-outcome-delivered'],
      terminalState: 'active',
      acceptanceCriteria: [{
        id: 'server-state',
        description: 'Le serveur expose l’état attendu.',
        toolName: 'mcp__rbw-servers__ssh_execute',
        input: { server: 'dev', cwd: '/srv/app', command },
        checks: [{ path: '$.transport.code', equals: 0 }],
      }],
    },
  } as Session);
}

class FakeHost implements SessionMissionHost {
  readonly sessions: Session[] = [];
  readonly sent: Array<{ sessionId: string; message: string; options?: SendMessageOptions }> = [];
  readonly listeners = new Set<(event: SessionCompletionEvent) => void>();
  output = VALID_OUTPUT;
  completionProof?: SessionCompletionEvent['executionProof'];
  completionTokenUsage?: SessionCompletionEvent['tokenUsage'];
  readonly capabilityLocks = new Map<string, MissionCapabilityLock>();
  readonly preflightCalls: MissionToolInvocationPreflightInput[] = [];
  workspaceDefaultSourceSlugs: string[] = [];
  preflightDecision: { allowed: true } | { allowed: false; reason: string } = { allowed: true };
  createCalls = 0;
  claimAndResumePendingMissionTurn?: NonNullable<SessionMissionHost['claimAndResumePendingMissionTurn']>;

  getSessions(): Session[] { return this.sessions; }
  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }
  async createSession(
    workspaceId: string,
    options?: CreateSessionOptions,
    internal?: {
      emitCreatedEvent?: boolean;
      missionOrdinaryRouteLock?: NonNullable<MissionExecutionInput['ordinaryRoutePin']>;
    },
  ): Promise<Session> {
    this.createCalls += 1;
    const session = {
      id: `session-${this.sessions.length + 1}`,
      workspaceId,
      workspaceName: 'Test',
      lastMessageAt: Date.now(),
      messages: [],
      isProcessing: false,
      ...options,
      ...(internal?.missionOrdinaryRouteLock
        ? { missionOrdinaryRouteLock: structuredClone(internal.missionOrdinaryRouteLock) }
        : {}),
    } as Session;
    this.sessions.push(session);
    return session;
  }
  async bindSpecializedMissionCapabilityLock(
    sessionId: string,
    lock: MissionCapabilityLock,
  ): Promise<void> {
    const existing = this.capabilityLocks.get(sessionId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(lock)) {
      throw new Error('immutable capability lock');
    }
    this.capabilityLocks.set(sessionId, lock);
  }
  async sendMessage(
    sessionId: string,
    message: string,
    _attachments?: FileAttachment[],
    _storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    _existingMessageId?: string,
    _isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
  ): Promise<void> {
    const session = this.sessions.find((candidate) => candidate.id === sessionId)!;
    this.sent.push({ sessionId, message, options });
    session.messages.push({
      id: 'user-1', role: 'user', content: message, timestamp: Date.now(),
      ...(options?.internalOrigin ? { internalOrigin: options.internalOrigin } : {}),
    });
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
  resolveMissionEnabledSourceSlugs(_workspaceId: string, requestedSourceSlugs?: string[]): string[] {
    return [...(requestedSourceSlugs ?? this.workspaceDefaultSourceSlugs)].sort();
  }
  preflightMissionToolInvocation(
    _workspaceId: string,
    input: MissionToolInvocationPreflightInput,
  ): { allowed: true } | { allowed: false; reason: string } {
    this.preflightCalls.push(structuredClone(input));
    return this.preflightDecision;
  }
}

describe('SessionMissionExecutor', () => {
  it('separates the structured Mission result from objective-outcome transport metadata', () => {
    const prompt = buildMissionSessionPrompt(reviewInput());

    expect(prompt).toContain('Return the result as exactly one JSON object, without Markdown fences.');
    expect(prompt).toContain('append it on its own final line after the JSON');
    expect(prompt).toContain('transport metadata, not part of the result JSON');
    expect(prompt).toContain('Return a StructuredMissionVerdict for targetType=objective and targetId=objective-one.');
  });

  it('inherits authenticated parent pins and preserves explicit profile model and reasoning overrides', async () => {
    for (const override of [false, true]) {
      const host = new FakeHost();
      const parent = await host.createSession('workspace-1', {
        model: 'parent-model', llmConnection: 'parent-connection', thinkingLevel: 'medium',
        modelRoutePinned: true, connectionRoutePinned: true, thinkingLevelPinned: true,
      });
      parent.id = 'origin-session';
      const executor = new SessionMissionExecutor({ host, workspaceId: 'workspace-1', workspaceRoot: '/tmp' });
      const assignment = input();
      if (override) assignment.profile = {
        ...assignment.profile, model: 'explicit-model', llmConnection: 'explicit-connection', thinkingLevel: 'high',
      };
      const binding = await executor.prepare(assignment);
      await executor.execute(assignment, binding);
      expect(host.sessions[1]).toMatchObject(override
        ? { model: 'explicit-model', llmConnection: 'explicit-connection', thinkingLevel: 'high' }
        : { model: 'parent-model', llmConnection: 'parent-connection', thinkingLevel: 'medium' });
      expect(host.sent[0]?.options).toMatchObject({
        internalOrigin: { kind: 'spawned-session', senderSessionId: 'origin-session' },
      });
    }
  });

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

  it('durably locks a specialized Mission session to its evaluated route', async () => {
    const host = new FakeHost();
    const assignment = specializedInput();
    const executor = new SessionMissionExecutor({ host, workspaceId: 'workspace-1', workspaceRoot: '/tmp' });

    expect((await executor.execute(assignment, await executor.prepare(assignment))).status).toBe('submission');
    expect(host.sessions[0]).toMatchObject({
      model: 'evaluated-model',
      llmConnection: 'evaluated-connection',
      thinkingLevel: 'high',
      modelRoutePinned: true,
      connectionRoutePinned: true,
      thinkingLevelPinned: true,
      missionRouteLockSha256: assignment.specializedProfile!.executionRouteSha256,
    });
    expect(host.capabilityLocks.get(host.sessions[0]!.id)).toEqual({
      schemaVersion: 1,
      capabilityEnvelopeSha256: assignment.specializedProfile!.capabilityEnvelopeSha256,
      capabilities: [...assignment.specializedProfile!.capabilityEnvelope],
    });

    const recovered = new FakeHost();
    recovered.sessions.push({ ...host.sessions[0]!, missionRouteLockSha256: undefined });
    const recoveryExecutor = new SessionMissionExecutor({
      host: recovered, workspaceId: 'workspace-1', workspaceRoot: '/tmp',
    });
    expect(await recoveryExecutor.execute(assignment, await recoveryExecutor.prepare(assignment)))
      .toMatchObject({ status: 'failed', retryable: false });
  });

  it('persists and enforces an exact host-owned ordinary Mission route', async () => {
    const host = new FakeHost();
    const assignment = ordinaryRouteInput();
    assignment.mission.cwd = '.';
    const executor = new SessionMissionExecutor({
      host, workspaceId: 'workspace-1', workspaceRoot: '/tmp',
    });

    expect(await executor.execute(assignment, await executor.prepare(assignment)))
      .toMatchObject({ status: 'submission' });
    expect(host.sessions[0]).toMatchObject({
      llmConnection: 'ordinary-connection',
      model: 'ordinary-model',
      thinkingLevel: 'high',
      workingDirectory: '/tmp',
      enabledSourceSlugs: [],
      missionOrdinaryRouteLock: assignment.ordinaryRoutePin,
    });
    expect(host.sent).toHaveLength(1);

    const recovered = new FakeHost();
    recovered.sessions.push({
      ...host.sessions[0]!,
      model: 'drifted-model',
      messages: [],
      isProcessing: false,
    });
    const recoveryExecutor = new SessionMissionExecutor({
      host: recovered, workspaceId: 'workspace-1', workspaceRoot: '/tmp',
    });
    const result = await recoveryExecutor.execute(
      assignment,
      await recoveryExecutor.prepare(assignment),
    );
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.status === 'failed' ? result.reason : '').toContain('session model differs');
    expect(recovered.sent).toHaveLength(0);
  });

  it('scopes a model-only profile to the effective default without an origin session', async () => {
    const host = new FakeHost();
    const assignment = input();
    assignment.mission = { ...assignment.mission, originSessionId: undefined };
    assignment.profile = {
      ...assignment.profile,
      model: 'profile-model',
      llmConnection: undefined,
    };
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
      defaultLlmConnection: 'workspace-default',
    });

    await executor.execute(assignment, await executor.prepare(assignment));
    expect(host.sessions[0]).toMatchObject({
      model: 'profile-model', modelRoutePinned: true,
      llmConnection: 'workspace-default', connectionRoutePinned: true,
    });
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

  it('claims a restored reviewer recovery only after installing its completion listener', async () => {
    const host = new FakeHost();
    const assignment = reviewInput();
    const prompt = buildMissionSessionPrompt(assignment);
    const isolation = {
      effect: 'read' as const,
      policy: {
        workspaceRoot: '/tmp', allowedReadPaths: ['.'], allowedWritePaths: [],
        networkAccess: 'disabled' as const, allowedHosts: [], maxCpuPercent: 100,
        maxMemoryMb: 1024, timeoutMs: 30 * 60 * 1000,
      },
    };
    const restored = {
      id: 'restored-review-session', workspaceId: 'workspace-1', workspaceName: 'Test',
      lastMessageAt: Date.now(), isProcessing: false,
      missionId: assignment.mission.id, missionWorkItemId: assignment.item.id,
      missionDispatchId: assignment.dispatchId, missionRole: 'reviewer' as const,
      permissionMode: 'safe' as const, enabledSourceSlugs: [], executionIsolation: isolation,
      messages: [{ id: 'accepted-review', role: 'user' as const, content: prompt, timestamp: 1 }],
    } as Session;
    host.sessions.push(restored);
    const claims: unknown[] = [];
    host.claimAndResumePendingMissionTurn = async (sessionId, claim) => {
      claims.push(structuredClone(claim));
      queueMicrotask(() => {
        restored.messages.push({
          id: 'resumed-final', role: 'assistant', content: VALID_REVIEW_OUTPUT, timestamp: 2,
        });
        for (const listener of host.listeners) listener({
          sessionId,
          workspaceId: restored.workspaceId,
          reason: 'complete',
          finalMessageId: 'resumed-final',
          finalText: VALID_REVIEW_OUTPUT,
        });
      });
      return { allowed: true };
    };
    const executor = new SessionMissionExecutor({
      host, workspaceId: 'workspace-1', workspaceRoot: '/tmp',
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({ status: 'verdict', verdict: { result: 'pass' } });
    expect(host.sent).toHaveLength(0);
    expect(host.createCalls).toBe(0);
    expect(claims).toEqual([{
      missionId: assignment.mission.id,
      missionWorkItemId: assignment.item.id,
      missionDispatchId: assignment.dispatchId,
      boundary: {
        permissionMode: 'safe', enabledSourceSlugs: [], executionIsolation: isolation,
        missionRole: 'reviewer',
      },
    }]);
  });

  it.each([
    ['legacy worker', input()],
    ['ordinary routed worker', ordinaryRouteInput()],
    ['specialized worker', specializedInput()],
  ] as const)('claims a restored %s through MissionRuntime instead of sending a duplicate', async (_name, assignment) => {
    const host = new FakeHost();
    const prompt = buildMissionSessionPrompt(assignment);
    const route = assignment.ordinaryRoutePin;
    const specialized = assignment.specializedProfile;
    const restored = {
      id: `restored-${_name.replaceAll(' ', '-')}`,
      workspaceId: 'workspace-1', workspaceName: 'Test', lastMessageAt: Date.now(),
      isProcessing: false,
      missionId: assignment.mission.id,
      missionWorkItemId: assignment.item.id,
      missionDispatchId: assignment.dispatchId,
      missionRole: 'worker' as const,
      permissionMode: 'safe' as const,
      enabledSourceSlugs: route?.effectiveSourceSlugs ?? [],
      workingDirectory: route?.cwd,
      llmConnection: assignment.profile.llmConnection,
      model: assignment.profile.model,
      thinkingLevel: assignment.profile.thinkingLevel,
      ...(route ? {
        missionOrdinaryRouteLock: structuredClone(route),
        connectionRoutePinned: true,
        modelRoutePinned: true,
        thinkingLevelPinned: true,
      } : {}),
      ...(specialized ? {
        missionRouteLockSha256: specialized.executionRouteSha256,
        connectionRoutePinned: true,
        modelRoutePinned: true,
        thinkingLevelPinned: true,
      } : {}),
      messages: [{ id: 'accepted-worker', role: 'user' as const, content: prompt, timestamp: 1 }],
    } as Session;
    host.sessions.push(restored);
    const claims: MissionPendingTurnRecoveryClaim[] = [];
    host.claimAndResumePendingMissionTurn = async (sessionId, claim) => {
      claims.push(structuredClone(claim));
      queueMicrotask(() => {
        restored.messages.push({
          id: 'resumed-worker-final', role: 'assistant', content: VALID_OUTPUT, timestamp: 2,
        });
        for (const listener of host.listeners) listener({
          sessionId,
          workspaceId: restored.workspaceId,
          reason: 'complete',
          finalMessageId: 'resumed-worker-final',
          finalText: VALID_OUTPUT,
        });
      });
      return { allowed: true };
    };
    const executor = new SessionMissionExecutor({
      host, workspaceId: 'workspace-1', workspaceRoot: '/tmp',
    });
    const lifecycle: string[] = [];

    const result = await executor.execute(assignment, await executor.prepare(assignment), {
      bindExternalExecution: (sessionId) => lifecycle.push(`bound:${sessionId}`),
      recordTurnAccepted: (sessionId, messageId) => lifecycle.push(`accepted:${sessionId}:${messageId}`),
    });

    expect(result.status).toBe('submission');
    expect(host.sent).toHaveLength(0);
    expect(host.createCalls).toBe(0);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      missionId: assignment.mission.id,
      missionWorkItemId: assignment.item.id,
      missionDispatchId: assignment.dispatchId,
      boundary: {
        permissionMode: 'safe',
        enabledSourceSlugs: route?.effectiveSourceSlugs ?? [],
        missionRole: 'worker',
        ...(route ? { ordinaryRouteLock: route } : {}),
        ...(specialized ? { specializedRouteLockSha256: specialized.executionRouteSha256 } : {}),
      },
    });
    expect(lifecycle).toEqual([
      `bound:${restored.id}`,
      `accepted:${restored.id}:accepted-worker`,
    ]);
  });

  it('removes the restrictive envelope only for an opted-in Execute child', async () => {
    const host = new FakeHost();
    const base = input();
    const assignment: MissionExecutionInput = {
      ...base,
      profile: { ...base.profile, permissionMode: 'allow-all' },
    };
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
      resolveSubagentAutonomyContext: () => ({
        parentPermissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
      }),
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));
    expect(result.status).toBe('submission');
    expect(host.sessions[0]?.permissionMode).toBe('allow-all');
    expect(host.sessions[0]?.executionIsolation).toBeUndefined();
  });

  it.each(['reviewer', 'supervisor'] as const)(
    'keeps a Mission v2 %s safe and isolated under an Execute parent',
    async (role) => {
      const host = new FakeHost();
      const base = input();
      const assignment: MissionExecutionInput = {
        ...base,
        profile: {
          ...base.mission.agentProfiles.find((profile) => profile.role === role)!,
          permissionMode: 'allow-all',
        },
      };
      const executor = new SessionMissionExecutor({
        host,
        workspaceId: 'workspace-1',
        workspaceRoot: '/tmp',
        resolveSubagentAutonomyContext: () => ({
          parentPermissionMode: 'allow-all',
          externalActionPolicy: 'allow-in-execute',
        }),
      });

      await executor.execute(assignment, await executor.prepare(assignment));
      expect(host.sessions[0]?.missionRole).toBe(role);
      expect(host.sessions[0]?.permissionMode).toBe('safe');
      expect(host.sessions[0]?.executionIsolation).toMatchObject({
        effect: 'read',
        policy: { networkAccess: 'disabled', allowedWritePaths: [] },
      });
    },
  );

  it('freezes the current workspace-default sources for a terminal reviewer without profile sources', async () => {
    const host = new FakeHost();
    host.workspaceDefaultSourceSlugs = ['workspace-default'];
    host.output = VALID_REVIEW_OUTPUT;
    const assignment = reviewInput();
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
    });

    await executor.execute(assignment, await executor.prepare(assignment));

    expect(host.sessions[0]?.enabledSourceSlugs).toEqual(['workspace-default']);
  });

  it('fails a registered review observation before session creation when Safe admission refuses it', async () => {
    const host = new FakeHost();
    addOriginAcceptanceContract(host, 'touch /srv/app/should-not-exist');
    host.preflightDecision = { allowed: false, reason: 'Safe mode cannot prove this invocation read-only' };
    const assignment = reviewInput();
    assignment.profile = { ...assignment.profile, sources: ['rbw-servers'], permissionMode: 'allow-all' };
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
      resolveSubagentAutonomyContext: () => ({ parentPermissionMode: 'allow-all' }),
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({ status: 'failed', retryable: false, ambiguousMutation: false });
    expect(host.createCalls).toBe(0);
    expect(host.sent).toHaveLength(0);
    expect(host.preflightCalls).toEqual([{
      toolName: 'mcp__rbw-servers__ssh_execute',
      toolInput: { server: 'dev', cwd: '/srv/app', command: 'touch /srv/app/should-not-exist' },
      permissionMode: 'safe',
      enabledSourceSlugs: ['rbw-servers'],
    }]);
  });

  it('executes a review when its exact literal SSH read is admitted in Safe mode', async () => {
    const host = new FakeHost();
    const command = 'sed -n 1,20p README.md';
    addOriginAcceptanceContract(host, command);
    host.output = VALID_REVIEW_OUTPUT;
    const assignment = reviewInput();
    assignment.profile = { ...assignment.profile, sources: ['rbw-servers'], permissionMode: 'allow-all' };
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
      resolveSubagentAutonomyContext: () => ({ parentPermissionMode: 'allow-all' }),
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({ status: 'verdict', verdict: { result: 'pass' } });
    expect(host.createCalls).toBe(1);
    expect(host.sent).toHaveLength(1);
    expect(host.sessions[1]).toMatchObject({
      missionRole: 'reviewer',
      permissionMode: 'safe',
      enabledSourceSlugs: ['rbw-servers'],
      executionIsolation: {
        effect: 'read',
        policy: {
          allowedReadToolInvocations: [{
            toolName: 'mcp__rbw-servers__ssh_execute',
            inputJson: JSON.stringify({ command, cwd: '/srv/app', server: 'dev' }),
          }],
        },
      },
    });
    expect(host.sent[0]?.message).toContain('Host-registered exact observations required');
    expect(host.sent[0]?.message).toContain(command);
  });

  it.each([
    {
      label: 'permission mode',
      overrides: { permissionMode: 'allow-all' as const },
      reason: 'permissionMode is allow-all instead of safe',
    },
    {
      label: 'enabled sources',
      overrides: {
        permissionMode: 'safe' as const,
        enabledSourceSlugs: ['unexpected-source'],
        executionIsolation: {
          effect: 'read' as const,
          policy: {
            workspaceRoot: '/tmp', allowedReadPaths: ['.'], allowedWritePaths: [],
            networkAccess: 'disabled' as const, allowedHosts: [], maxCpuPercent: 100,
            maxMemoryMb: 1024, timeoutMs: 30 * 60 * 1000,
          },
        },
      },
      reason: 'enabled sources differ',
    },
    {
      label: 'execution isolation',
      overrides: {
        permissionMode: 'safe' as const,
        enabledSourceSlugs: [],
        executionIsolation: undefined,
      },
      reason: 'execution isolation differs',
    },
  ])('refuses a durable Mission reviewer whose $label drifted before any provider call', async ({ overrides, reason }) => {
    const host = new FakeHost();
    const assignment = reviewInput();
    host.sessions.push({
      id: 'existing-review-session',
      workspaceId: 'workspace-1',
      workspaceName: 'Test',
      lastMessageAt: Date.now(),
      messages: [],
      isProcessing: false,
      missionId: assignment.mission.id,
      missionWorkItemId: assignment.item.id,
      missionDispatchId: assignment.dispatchId,
      missionRole: 'reviewer',
      enabledSourceSlugs: [],
      executionIsolation: {
        effect: 'read',
        policy: {
          workspaceRoot: '/tmp', allowedReadPaths: ['.'], allowedWritePaths: [],
          networkAccess: 'disabled', allowedHosts: [], maxCpuPercent: 100,
          maxMemoryMb: 1024, timeoutMs: 30 * 60 * 1000,
        },
      },
      ...overrides,
    } as Session);
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({
      status: 'failed', retryable: false, ambiguousMutation: false,
    });
    expect(result.status === 'failed' ? result.reason : '').toContain(reason);
    expect(host.createCalls).toBe(0);
    expect(host.sent).toHaveLength(0);
  });

  it('clamps a requested Execute child to Ask and keeps isolation under an Ask parent', async () => {
    const host = new FakeHost();
    const base = input();
    const assignment: MissionExecutionInput = {
      ...base,
      profile: { ...base.profile, permissionMode: 'allow-all' },
    };
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
      resolveSubagentAutonomyContext: () => ({
        parentPermissionMode: 'ask',
        externalActionPolicy: 'allow-in-execute',
      }),
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));
    expect(result.status).toBe('submission');
    expect(host.sessions[0]?.permissionMode).toBe('ask');
    expect(host.sessions[0]?.executionIsolation).toBeDefined();
  });

  it('blocks an external mutation when the host provides no reconciled proof', async () => {
    const host = new FakeHost();
    const assignment = input('external-mutation');
    const executor = new SessionMissionExecutor({ host, workspaceId: 'workspace-1', workspaceRoot: '/tmp' });
    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({ status: 'failed', retryable: false, ambiguousMutation: true });
  });
});
