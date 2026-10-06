import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MissionSpecSchema,
  type MissionExecutionBinding,
  type MissionSpec,
} from '@craft-agent/shared/missions';
import type {
  SpecializedAgentProfileDefinition,
  SpecializedProfileEvaluation,
  SpecializedProfileRecord,
  SpecializedProfileRegistryDocument,
  SpecializedProfileState,
  SpecializedProfileVersion,
} from '@craft-agent/shared/specialized-profiles';
import { saveWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { ISessionManager } from '../handlers/session-manager-interface.ts';
import {
  type MissionExecutionInput,
  type MissionExecutionResult,
  type MissionWorkExecutor,
} from './MissionRuntime.ts';
import { MissionRuntimeService } from './MissionRuntimeService.ts';

const NOW = new Date('2026-09-20T10:00:00.000Z');
const PROFILE_ID = 'specialist-document-production-a1b2c3d4e5f6';
const HASH = 'b'.repeat(64);
const ROUTE_HASH = 'f'.repeat(64);
const CAPABILITY_HASH = createHash('sha256').update(JSON.stringify([
  { kind: 'skill', name: 'documents' },
  { kind: 'source', name: 'drive-readonly' },
  { kind: 'workspace-read', name: 'workspace' },
])).digest('hex');

function mission(id = 'specialized-runtime'): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id,
    title: 'Document production',
    objective: 'Produce a verified document',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Document mission is complete' }],
    plannerProfileId: 'planner',
    defaultWorkerProfileId: PROFILE_ID,
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
      {
        id: PROFILE_ID,
        role: 'worker',
        specialty: 'document-production',
        systemPrompt: 'Unqualified Mission placeholder.',
        skills: ['documents'],
        tools: [],
        sources: ['drive-readonly'],
        permissionMode: 'safe',
        model: 'mission-selected-model',
        llmConnection: 'mission-selected-connection',
        thinkingLevel: 'medium',
      },
      { id: 'reviewer', role: 'reviewer', specialty: 'quality', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'final', systemPrompt: 'Supervise.' },
    ],
    policy: { maxConcurrentAgents: 1, maxTechnicalAttempts: 1 },
    workItems: [
      {
        id: 'objective-one', kind: 'objective', title: 'Document objective',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Document objective is complete' }],
      },
      {
        id: 'task-one', kind: 'task', title: 'Produce document', prompt: 'Produce it.',
        objectiveId: 'objective-one', dependsOn: [],
        acceptanceCriteria: [{ id: 'task-ok', description: 'Document exists' }],
        requiredEvidence: [], effect: 'read',
      },
    ],
  });
}

function definition(): SpecializedAgentProfileDefinition {
  return {
    displayName: 'Document Production',
    role: 'worker',
    specialty: 'document-production',
    objective: 'Produce bounded documents.',
    systemPrompt: 'Qualified document production instructions.',
    riskClass: 'low',
    eligibilityCriteria: [{
      id: 'matching-family', description: 'Family matches.',
      field: 'task.family', operator: 'equals', value: 'document-production',
    }],
    abstentionCriteria: [{
      id: 'missing-capability', description: 'A required capability is missing.',
      field: 'runtime.missing-required-capability', operator: 'present',
    }],
    requestedCapabilities: [
      {
        id: 'workspace-read', kind: 'workspace-read', name: 'workspace',
        justification: 'Read bounded workspace inputs.', required: true,
      },
      {
        id: 'documents-skill', kind: 'skill', name: 'documents',
        justification: 'Use the already granted skill.', required: true,
      },
      {
        id: 'drive-source', kind: 'source', name: 'drive-readonly',
        justification: 'Read the already-enabled source.', required: true,
      },
    ],
    successCriteria: [{ id: 'verified', description: 'Document is verified.' }],
  };
}

function version(number = 1): SpecializedProfileVersion {
  return {
    schemaVersion: 1,
    profileId: PROFILE_ID,
    version: number,
    definition: definition(),
    provenance: {
      method: 'mission-pattern',
      proposedBy: { kind: 'service', actorId: 'opportunity-engine' },
      generatedBy: { name: 'profile-foundry', version: '1' },
      generatedAt: '2026-09-18T08:00:00.000Z',
      sample: { rawTaskCount: 20, deduplicatedRootTaskCount: 12 },
      sources: [{ kind: 'mission', sourceId: 'source-mission', sha256: HASH, redacted: true }],
    },
    change: number === 1
      ? { kind: 'initial', reason: 'Initial profile.' }
      : { kind: 'revision', previousVersion: number - 1, reason: 'Revised profile.' },
    createdAt: number === 1 ? '2026-09-18T08:00:00.000Z' : '2026-09-19T08:00:00.000Z',
    createdBy: 'profile-foundry',
  };
}

function evaluation(stage: SpecializedProfileEvaluation['stage'], profileVersion: number): SpecializedProfileEvaluation {
  const stageEntryTransitionSequence = stage === 'offline' ? 2
    : stage === 'shadow' ? 3
      : stage === 'opt-in' ? 4
        : stage === 'canary' ? 5
          : 6;
  const times = {
    offline: ['2026-09-19T09:00:00.000Z', '2026-09-19T10:00:00.000Z'],
    shadow: ['2026-09-19T10:10:00.000Z', '2026-09-19T10:20:00.000Z'],
    'opt-in': ['2026-09-19T10:30:00.000Z', '2026-09-19T10:40:00.000Z'],
    canary: ['2026-09-19T10:50:00.000Z', '2026-09-19T11:00:00.000Z'],
    regression: ['2026-09-19T11:10:00.000Z', '2026-09-19T11:20:00.000Z'],
  } satisfies Record<SpecializedProfileEvaluation['stage'], readonly [string, string]>;
  return {
    schemaVersion: 1,
    id: `eval-${stage}-v${profileVersion}`,
    profileId: PROFILE_ID,
    profileVersion,
    stage,
    stageEntryTransitionSequence,
    executionRouteSha256: ROUTE_HASH,
    capabilityEnvelopeSha256: CAPABILITY_HASH,
    outcome: 'pass',
    runId: `run-${stage}-v${profileVersion}`,
    corpus: { id: 'held-out-documents', version: '1', heldOut: true },
    baseline: { kind: 'generalist', reference: 'generalist-v1' },
    cohort: {
      id: `campaign-${stage}-${profileVersion}`,
      missionIds: Array.from({ length: 20 }, (_, index) => `case-${stage}-${profileVersion}-${index}`),
      closedAt: times[stage][1],
    },
    evaluator: { actorId: `evaluator-${stage}` },
    metrics: {
      caseCount: 20, verifiedPassCount: 20, verifiedPassRate: 1,
      falseCompletionCount: 0, policyViolationCount: 0, mutationCaseCount: 0,
      requiredReceiptCount: 0, completeReceiptCount: 0, humanInterventionRate: 0,
    },
    evidence: [{ uri: `eval://${stage}`, sha256: HASH }],
    startedAt: times[stage][0],
    completedAt: times[stage][1],
    validUntil: '2026-10-20T10:00:00.000Z',
  };
}

function stages(state: SpecializedProfileState): SpecializedProfileEvaluation['stage'][] {
  if (state === 'opt-in') return ['offline', 'shadow'];
  if (state === 'canary') return ['offline', 'shadow', 'opt-in'];
  if (state === 'default') return ['offline', 'shadow', 'opt-in', 'canary'];
  return [];
}

function registry(state: SpecializedProfileState, profileVersion = 1): SpecializedProfileRegistryDocument {
  const transitions: SpecializedProfileRecord['transitions'] = [{
    sequence: 1, profileVersion: 1, from: null, to: 'candidate',
    occurredAt: '2026-09-18T08:00:00.000Z', actorId: 'profile-foundry',
    reason: 'Initial candidate.', evaluationIds: [],
  }];
  if (state !== 'candidate') {
    transitions.push({
      sequence: 2, profileVersion, from: 'candidate', to: 'draft',
      occurredAt: '2026-09-19T08:00:00.000Z', actorId: 'profile-foundry',
      reason: 'Draft entry.', evaluationIds: [],
    });
  }
  if (!['candidate', 'draft'].includes(state)) {
    transitions.push({
      sequence: 3, profileVersion, from: 'draft', to: 'shadow',
      occurredAt: '2026-09-19T10:05:00.000Z', actorId: 'profile-foundry',
      reason: 'Offline evaluation passed.', evaluationIds: [`eval-offline-v${profileVersion}`],
    });
  }
  if (['opt-in', 'canary', 'default'].includes(state)) {
    transitions.push({
      sequence: 4, profileVersion, from: 'shadow', to: 'opt-in',
      occurredAt: '2026-09-19T10:25:00.000Z', actorId: 'human-reviewer',
      reason: 'Shadow evaluation passed.', evaluationIds: [`eval-shadow-v${profileVersion}`],
    });
  }
  if (['canary', 'default'].includes(state)) {
    transitions.push({
      sequence: 5, profileVersion, from: 'opt-in', to: 'canary',
      occurredAt: '2026-09-19T10:45:00.000Z', actorId: 'human-reviewer',
      reason: 'Opt-in evaluation passed.', evaluationIds: [`eval-opt-in-v${profileVersion}`],
    });
  }
  if (state === 'default') {
    transitions.push({
      sequence: 6, profileVersion, from: 'canary', to: 'default',
      occurredAt: '2026-09-19T11:05:00.000Z', actorId: 'human-reviewer',
      reason: 'Canary evaluation passed.', evaluationIds: [`eval-canary-v${profileVersion}`],
    });
  }
  const record: SpecializedProfileRecord = {
    id: PROFILE_ID,
    creationRequestId: `proposal-${PROFILE_ID}`,
    currentVersion: profileVersion,
    currentState: state,
    versions: Array.from({ length: profileVersion }, (_, index) => version(index + 1)),
    evaluations: stages(state).map((stage) => evaluation(stage, profileVersion)),
    transitions,
    createdAt: '2026-09-18T08:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
  };
  return {
    schemaVersion: 2,
    workspaceId: 'workspace-1',
    revision: profileVersion + 6,
    updatedAt: '2026-09-19T12:00:00.000Z',
    updatedBy: 'human-reviewer',
    profiles: [record],
    head: {
      schemaVersion: 1,
      revision: profileVersion + 6,
      documentSha256: 'c'.repeat(64),
      previousDocumentSha256: 'd'.repeat(64),
      authority: { scheme: 'hmac-sha256', keyId: 'test', sha256: 'e'.repeat(64) },
    },
  };
}

class CapturingExecutor implements MissionWorkExecutor {
  readonly prepared: MissionExecutionInput[] = [];
  readonly executed: MissionExecutionInput[] = [];

  async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
    this.prepared.push(input);
    return { executorKind: 'capturing', executionId: input.dispatchId };
  }

  async execute(input: MissionExecutionInput): Promise<MissionExecutionResult> {
    this.executed.push(input);
    if (input.item.kind === 'objective-review') {
      return { status: 'verdict', verdict: {
        targetType: 'objective', targetId: 'objective-one', result: 'pass', summary: 'Pass',
        criteria: [{ criterionId: 'objective-ok', result: 'pass', evidenceRefs: ['test://objective'], explanation: 'Pass' }],
        affectedWorkItemIds: [], corrections: [],
      } };
    }
    if (input.item.kind === 'final-review') {
      return { status: 'verdict', verdict: {
        targetType: 'mission', targetId: input.mission.id, result: 'pass', summary: 'Pass',
        criteria: [{ criterionId: 'mission-ok', result: 'pass', evidenceRefs: ['test://mission'], explanation: 'Pass' }],
        affectedWorkItemIds: [], corrections: [],
      } };
    }
    return { status: 'submission', submission: { summary: 'Done', outputRefs: [], evidence: [] } };
  }
}

async function eventually(assertion: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for specialized Mission runtime');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('MissionRuntimeService specialized profiles', () => {
  let root: string;
  let executor: CapturingExecutor;
  let sessionManager: ISessionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mission-specialized-profile-'));
    executor = new CapturingExecutor();
    sessionManager = {
      waitForInit: async () => {},
      getSessions: () => [],
      cancelProcessing: async () => {},
    } as unknown as ISessionManager;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function service(loadRegistry: () => Promise<SpecializedProfileRegistryDocument | null>) {
    return new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [{ id: 'workspace-1', rootPath: root }],
      executorFactory: () => executor,
      specializedProfileRegistryLoader: loadRegistry,
      specializedProfileNow: () => NOW,
      specializedProfileCapabilityResolver: () => [
        { kind: 'workspace-read', name: 'workspace' },
        { kind: 'skill', name: 'documents' },
        { kind: 'source', name: 'drive-readonly' },
      ],
      specializedProfileRouteIdentityResolver: () => ROUTE_HASH,
    });
  }

  it.each(['opt-in', 'canary', 'default'] as const)(
    'materializes and executes an explicit qualified %s profile without expanding capabilities',
    async (state) => {
      const missionId = `specialized-runtime-${state}`;
      const runtime = service(async () => registry(state));
      await runtime.createAndStart('workspace-1', mission(missionId));
      await eventually(async () =>
        (await runtime.getMission('workspace-1', missionId)).status === 'completed');

      const snapshot = await runtime.getMission('workspace-1', missionId);
      const persisted = snapshot.spec.agentProfiles.find((profile) => profile.id === PROFILE_ID)!;
      const workerInput = executor.executed.find((input) => input.item.id === 'task-one')!;
      expect(persisted.systemPrompt).toContain('<robb-specialized-profile-binding>');
      expect(persisted.systemPrompt).toContain('Qualified document production instructions.');
      expect(workerInput.specializedProfile).toMatchObject({
        profileId: PROFILE_ID,
        profileVersion: 1,
        selectedState: state,
        provenance: { generatedBy: { name: 'profile-foundry', version: '1' } },
      });
      expect(workerInput.profile).toMatchObject({
        skills: ['documents'], tools: [], sources: ['drive-readonly'], permissionMode: 'safe',
        model: 'mission-selected-model', llmConnection: 'mission-selected-connection',
      });
    },
  );

  it.each(['draft', 'shadow'] as const)('rejects an explicit %s profile before Mission creation', async (state) => {
    const runtime = service(async () => registry(state));
    await expect(runtime.createAndStart('workspace-1', mission(`inactive-${state}`)))
      .rejects.toThrow(`is inactive in state ${state}`);
    expect(executor.prepared).toHaveLength(0);
  });

  it('revalidates the pinned version before dispatch and fails closed on drift', async () => {
    let loads = 0;
    const runtime = service(async () => {
      loads += 1;
      return loads === 1 ? registry('opt-in', 1) : registry('opt-in', 2);
    });
    await runtime.createAndStart('workspace-1', mission('version-drift'));
    await eventually(async () => (await runtime.getMission('workspace-1', 'version-drift')).status === 'blocked');

    const blocked = await runtime.getMission('workspace-1', 'version-drift');
    expect(blocked.workItems['task-one']?.statusReason).toContain('drifted from selected version 1');
    expect(executor.prepared).toHaveLength(0);
    expect(executor.executed).toHaveLength(0);
  });

  it('keeps specialized route locks while admitting and pinning ordinary profiles in a mixed Mission', async () => {
    const createdAt = NOW.getTime();
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Mixed workspace', slug: 'mixed-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
      costControl: {},
    });
    const base = mission('mixed-routes');
    const spec = MissionSpecSchema.parse({
      ...base,
      agentProfiles: [
        ...base.agentProfiles,
        {
          id: 'ordinary-worker', role: 'worker', specialty: 'general', systemPrompt: 'Work normally.',
          skills: [], tools: [], sources: [], permissionMode: 'safe',
        },
      ],
      workItems: [
        ...base.workItems,
        {
          id: 'ordinary-task', kind: 'task', title: 'Ordinary check', prompt: 'Check the result.',
          objectiveId: 'objective-one', agentProfileId: 'ordinary-worker', dependsOn: ['task-one'],
          acceptanceCriteria: [{ id: 'ordinary-ok', description: 'Check complete' }],
          requiredEvidence: [], effect: 'read',
        },
      ],
    });
    const runtime = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      executorFactory: () => executor,
      preflightConnections: () => [{
        slug: 'openai', providerType: 'pi', piAuthProvider: 'openai',
        models: ['pi/gpt-5.6-luna', 'pi/gpt-5.6-terra', 'pi/gpt-5.6-sol'],
        defaultModel: 'pi/gpt-5.6-terra',
      }],
      specializedProfileRegistryLoader: async () => registry('opt-in'),
      specializedProfileNow: () => NOW,
      specializedProfileCapabilityResolver: () => [
        { kind: 'workspace-read', name: 'workspace' },
        { kind: 'skill', name: 'documents' },
        { kind: 'source', name: 'drive-readonly' },
      ],
      specializedProfileRouteIdentityResolver: () => ROUTE_HASH,
    });

    await runtime.createAndStart('workspace-1', spec);
    await eventually(async () =>
      (await runtime.getMission('workspace-1', 'mixed-routes')).status === 'completed');

    const specialized = executor.executed.find(input => input.item.id === 'task-one')!;
    const ordinary = executor.executed.find(input => input.item.id === 'ordinary-task')!;
    expect(specialized.specializedProfile?.executionRouteSha256).toBe(ROUTE_HASH);
    expect(specialized.profile).toMatchObject({
      llmConnection: 'mission-selected-connection',
      model: 'mission-selected-model',
      thinkingLevel: 'medium',
    });
    expect(ordinary.specializedProfile).toBeUndefined();
    expect(ordinary.profile).toMatchObject({
      llmConnection: 'openai',
      model: expect.stringMatching(/^pi\/gpt-5\.6-/),
      thinkingLevel: expect.any(String),
    });
    const snapshot = await runtime.getMission('workspace-1', 'mixed-routes');
    expect(snapshot.workItems['ordinary-task']?.executionBinding?.missionRoute).toMatchObject({
      routeDecisionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      agentProfileId: 'ordinary-worker',
      connectionSlug: 'openai',
      model: ordinary.profile.model,
      thinkingLevel: ordinary.profile.thinkingLevel,
    });
    expect(snapshot.workItems['task-one']?.executionBinding?.missionRoute).toBeUndefined();
    expect(snapshot.workItems['task-one']?.executionBinding?.specializedProfile?.executionRouteSha256)
      .toBe(ROUTE_HASH);
  });
});
