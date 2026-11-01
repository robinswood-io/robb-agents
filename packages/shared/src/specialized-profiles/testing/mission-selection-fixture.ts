import { createHash } from "node:crypto";
import { AgentProfileSchema } from "../../missions/schema.ts";
import type { SpecializedAgentProfileDefinition, SpecializedProfileEvaluation, SpecializedProfileRecord, SpecializedProfileRegistryDocument, SpecializedProfileState, SpecializedProfileVersion } from "../schema.ts";



export const NOW = new Date('2026-09-20T10:00:00.000Z');

export const PROFILE_ID = 'specialist-document-production-a1b2c3d4e5f6';

export const HASH = 'a'.repeat(64);

export const ROUTE_HASH = 'e'.repeat(64);

export const CAPABILITIES = [
  { kind: 'workspace-read' as const, name: 'workspace' },
  { kind: 'skill' as const, name: 'documents' },
  { kind: 'source' as const, name: 'drive-readonly' },
];

export const CAPABILITY_HASH = createHash('sha256').update(JSON.stringify(
  [...CAPABILITIES].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)),
)).digest('hex');


export function definition(specialty = 'document-production'): SpecializedAgentProfileDefinition {
  return {
    displayName: 'Document Production',
    role: 'worker',
    specialty,
    objective: 'Produce a bounded document with verifiable evidence.',
    systemPrompt: 'Produce only the requested bounded document.',
    riskClass: 'low',
    eligibilityCriteria: [{
      id: 'matching-family',
      description: 'The Mission profile declares the qualified family.',
      field: 'task.family',
      operator: 'equals',
      value: specialty,
    }],
    abstentionCriteria: [{
      id: 'missing-capability',
      description: 'A required capability is missing.',
      field: 'runtime.missing-required-capability',
      operator: 'present',
    }],
    requestedCapabilities: [
      {
        id: 'workspace-read', kind: 'workspace-read', name: 'workspace',
        justification: 'Read the bounded workspace input.', required: true,
      },
      {
        id: 'document-skill', kind: 'skill', name: 'documents',
        justification: 'Use the already-granted document skill.', required: true,
      },
      {
        id: 'optional-pdf-tool', kind: 'tool', name: 'pdf',
        justification: 'Use PDF tooling only when already granted.', required: false,
      },
      {
        id: 'drive-source', kind: 'source', name: 'drive-readonly',
        justification: 'Read the already-enabled bounded source.', required: true,
      },
    ],
    successCriteria: [{ id: 'verified-document', description: 'The resulting document is verified.' }],
  };
}


export function version(versionNumber = 1): SpecializedProfileVersion {
  return {
    schemaVersion: 1,
    profileId: PROFILE_ID,
    version: versionNumber,
    definition: definition(),
    provenance: {
      method: 'mission-pattern',
      proposedBy: { kind: 'service', actorId: 'opportunity-engine' },
      generatedBy: { name: 'profile-foundry', version: '1' },
      generatedAt: '2026-09-18T08:00:00.000Z',
      sample: { rawTaskCount: 20, deduplicatedRootTaskCount: 12 },
      sources: [{ kind: 'mission', sourceId: 'mission-source', sha256: HASH, redacted: true }],
    },
    change: versionNumber === 1
      ? { kind: 'initial', reason: 'Initial qualified profile.' }
      : { kind: 'revision', previousVersion: versionNumber - 1, reason: 'Revised qualified profile.' },
    createdAt: versionNumber === 1
      ? '2026-09-18T08:00:00.000Z'
      : '2026-09-19T08:00:00.000Z',
    createdBy: 'profile-foundry',
  };
}


export function evaluation(
  stage: SpecializedProfileEvaluation['stage'],
  profileVersion = 1,
  validUntil = '2026-10-20T10:00:00.000Z',
): SpecializedProfileEvaluation {
  const entrySequence = stage === 'offline' ? 2
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
    stageEntryTransitionSequence: entrySequence,
    executionRouteSha256: ROUTE_HASH,
    capabilityEnvelopeSha256: CAPABILITY_HASH,
    outcome: 'pass',
    runId: `run-${stage}-v${profileVersion}`,
    corpus: { id: 'held-out-documents', version: '1', heldOut: true },
    baseline: { kind: 'generalist', reference: 'generalist-v1' },
    cohort: {
      id: `cohort-${stage}-v${profileVersion}`,
      missionIds: Array.from({ length: 20 }, (_, index) => `case-${stage}-${profileVersion}-${index}`).sort(),
      closedAt: times[stage][1],
    },
    evaluator: { actorId: `evaluator-${stage}` },
    metrics: {
      caseCount: 20,
      verifiedPassCount: 20,
      verifiedPassRate: 1,
      falseCompletionCount: 0,
      policyViolationCount: 0,
      mutationCaseCount: 0,
      requiredReceiptCount: 0,
      completeReceiptCount: 0,
      humanInterventionRate: 0,
    },
    evidence: [{ uri: `eval://${stage}/v${profileVersion}`, sha256: HASH }],
    startedAt: times[stage][0],
    completedAt: times[stage][1],
    validUntil,
  };
}


export function requiredStages(state: SpecializedProfileState): SpecializedProfileEvaluation['stage'][] {
  if (state === 'opt-in') return ['offline', 'shadow'];
  if (state === 'canary') return ['offline', 'shadow', 'opt-in'];
  if (state === 'default') return ['offline', 'shadow', 'opt-in', 'canary'];
  return [];
}


export function profile(
  state: SpecializedProfileState,
  profileVersion = 1,
  evaluations = requiredStages(state).map((stage) => evaluation(stage, profileVersion)),
): SpecializedProfileRecord {
  const versions = Array.from({ length: profileVersion }, (_, index) => version(index + 1));
  const transitionVersion = profileVersion;
  const transitions: SpecializedProfileRecord['transitions'] = [{
    sequence: 1,
    profileVersion: 1,
    from: null,
    to: 'candidate',
    occurredAt: '2026-09-18T08:00:00.000Z',
    actorId: 'profile-foundry',
    reason: 'Initial candidate.',
    evaluationIds: [],
  }];
  if (state !== 'candidate') {
    transitions.push({
      sequence: 2,
      profileVersion: transitionVersion,
      from: 'candidate',
      to: 'draft',
      occurredAt: '2026-09-19T08:00:00.000Z',
      actorId: 'profile-foundry',
      reason: 'Draft entry.',
      evaluationIds: [],
    });
  }
  if (!['candidate', 'draft'].includes(state)) {
    transitions.push({
      sequence: 3,
      profileVersion: transitionVersion,
      from: 'draft',
      to: 'shadow',
      occurredAt: '2026-09-19T10:05:00.000Z',
      actorId: 'profile-foundry',
      reason: 'Offline evaluation passed.',
      evaluationIds: [`eval-offline-v${profileVersion}`],
    });
  }
  if (['opt-in', 'canary', 'default'].includes(state)) {
    transitions.push({
      sequence: 4,
      profileVersion: transitionVersion,
      from: 'shadow',
      to: 'opt-in',
      occurredAt: '2026-09-19T10:25:00.000Z',
      actorId: 'human-reviewer',
      reason: 'Shadow evaluation passed.',
      evaluationIds: [`eval-shadow-v${profileVersion}`],
    });
  }
  if (['canary', 'default'].includes(state)) {
    transitions.push({
      sequence: 5,
      profileVersion: transitionVersion,
      from: 'opt-in',
      to: 'canary',
      occurredAt: '2026-09-19T10:45:00.000Z',
      actorId: 'human-reviewer',
      reason: 'Opt-in evaluation passed.',
      evaluationIds: [`eval-opt-in-v${profileVersion}`],
    });
  }
  if (state === 'default') {
    transitions.push({
      sequence: 6,
      profileVersion: transitionVersion,
      from: 'canary',
      to: 'default',
      occurredAt: '2026-09-19T11:05:00.000Z',
      actorId: 'human-reviewer',
      reason: 'Canary evaluation passed.',
      evaluationIds: [`eval-canary-v${profileVersion}`],
    });
  }
  if (state === 'retired' || state === 'revoked') {
    transitions.push({
      sequence: transitions.length + 1,
      profileVersion: transitionVersion,
      from: transitions.at(-1)!.to,
      to: state,
      occurredAt: '2026-09-19T11:05:00.000Z',
      actorId: 'human-reviewer',
      reason: `${state} profile.`,
      evaluationIds: [],
    });
  }
  return {
    id: PROFILE_ID,
    creationRequestId: 'proposal-document-production',
    currentVersion: profileVersion,
    currentState: state,
    versions,
    evaluations,
    transitions,
    createdAt: '2026-09-18T08:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
  };
}


export function registry(record: SpecializedProfileRecord, revision = 7): SpecializedProfileRegistryDocument {
  return {
    schemaVersion: 2,
    workspaceId: 'workspace-1',
    revision,
    updatedAt: '2026-09-19T12:00:00.000Z',
    updatedBy: 'human-reviewer',
    profiles: [record],
    head: {
      schemaVersion: 1,
      revision,
      documentSha256: 'b'.repeat(64),
      previousDocumentSha256: 'c'.repeat(64),
      authority: { scheme: 'hmac-sha256', keyId: 'test', sha256: 'd'.repeat(64) },
    },
  };
}


export function requestedProfile() {
  return AgentProfileSchema.parse({
    id: PROFILE_ID,
    role: 'worker',
    specialty: 'document-production',
    systemPrompt: 'Caller-authored placeholder; it is not qualified instructions.',
    skills: ['documents'],
    tools: [],
    sources: ['drive-readonly'],
    permissionMode: 'safe',
    modelTier: 'best',
    model: 'explicit-model',
    llmConnection: 'explicit-connection',
    thinkingLevel: 'medium',
  });
}


export const context = {
  fields: { 'task.family': 'document-production' },
  capabilities: CAPABILITIES,
  executionRouteSha256: ROUTE_HASH,
};
