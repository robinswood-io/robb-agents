import { MissionSpecSchema, type MissionSpec } from "@craft-agent/shared/missions";
import type { StoredAttachment } from "@craft-agent/core/types";
import type { CreateSessionOptions, FileAttachment, SendMessageOptions, Session } from "@craft-agent/shared/protocol";
import type { SessionCompletionEvent } from "../../sessions/SessionManager.ts";
import type { MissionExecutionInput } from "../MissionRuntime.ts";
import type { MissionCapabilityLock } from "@craft-agent/shared/sessions";
import { specializedProfileCapabilityEnvelopeIdentity } from "@craft-agent/shared/specialized-profiles";
import { type MissionToolInvocationPreflightInput, type SessionMissionHost } from "../SessionMissionExecutor.ts";



export function fixture(): MissionSpec {
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


export function input(effect: 'read' | 'workspace-write' | 'external-mutation' = 'read'): MissionExecutionInput {
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


export function reviewInput(): MissionExecutionInput {
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


export function specializedInput(): MissionExecutionInput {
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


export function ordinaryRouteInput(): MissionExecutionInput {
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


export const VALID_OUTPUT = JSON.stringify({
  summary: 'Travail terminé',
  outputRefs: ['artifact://a'],
  evidence: [{ requirementId: 'test-a', uri: 'test://a', kind: 'test' }],
});


export const VALID_REVIEW_OUTPUT = JSON.stringify({
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


export function addOriginAcceptanceContract(
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


export class FakeHost implements SessionMissionHost {
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
    this.sent.push({ sessionId, message, ...(options !== undefined ? { options: options } : {}) });
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
