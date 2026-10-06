import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { AgentProfileSchema } from '../missions/schema.ts';
import type {
  SpecializedAgentProfileDefinition,
  SpecializedProfileEvaluation,
  SpecializedProfileRecord,
  SpecializedProfileRegistryDocument,
  SpecializedProfileState,
  SpecializedProfileVersion,
} from './schema.ts';
import {
  parseSpecializedMissionProfileReference,
  selectSpecializedMissionProfile,
  specializedProfileHasCurrentMissionQualification,
} from './mission-selection.ts';

const NOW = new Date('2026-09-20T10:00:00.000Z');
const PROFILE_ID = 'specialist-document-production-a1b2c3d4e5f6';
const HASH = 'a'.repeat(64);
const ROUTE_HASH = 'e'.repeat(64);
const CAPABILITIES = [
  { kind: 'workspace-read' as const, name: 'workspace' },
  { kind: 'skill' as const, name: 'documents' },
  { kind: 'source' as const, name: 'drive-readonly' },
];
const CAPABILITY_HASH = createHash('sha256').update(JSON.stringify(
  [...CAPABILITIES].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)),
)).digest('hex');

function definition(specialty = 'document-production'): SpecializedAgentProfileDefinition {
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

function version(versionNumber = 1): SpecializedProfileVersion {
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

function evaluation(
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

function requiredStages(state: SpecializedProfileState): SpecializedProfileEvaluation['stage'][] {
  if (state === 'opt-in') return ['offline', 'shadow'];
  if (state === 'canary') return ['offline', 'shadow', 'opt-in'];
  if (state === 'default') return ['offline', 'shadow', 'opt-in', 'canary'];
  return [];
}

function profile(
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

function registry(record: SpecializedProfileRecord, revision = 7): SpecializedProfileRegistryDocument {
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

function requestedProfile() {
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

const context = {
  fields: { 'task.family': 'document-production' },
  capabilities: CAPABILITIES,
  executionRouteSha256: ROUTE_HASH,
};

describe('specialized Mission profile selection', () => {
  it.each(['opt-in', 'canary', 'default'] as const)(
    'selects an explicitly requested, currently qualified %s profile deterministically',
    (state) => {
      const selected = selectSpecializedMissionProfile({
        requestedProfile: requestedProfile(),
        registry: registry(profile(state)),
        context,
        at: NOW,
      });

      expect(selected?.binding).toMatchObject({
        profileId: PROFILE_ID,
        profileVersion: 1,
        selectedState: state,
        currentState: state,
        registryRevisionAtSelection: 7,
        provenance: { generatedBy: { name: 'profile-foundry', version: '1' } },
      });
      expect(selected?.profile).toMatchObject({
        specialty: 'document-production',
        skills: ['documents'],
        tools: [],
        sources: ['drive-readonly'],
        permissionMode: 'safe',
        model: 'explicit-model',
        llmConnection: 'explicit-connection',
      });
      expect(selected?.profile.systemPrompt).toContain('Produce only the requested bounded document.');
      expect(selected?.profile.systemPrompt).not.toContain('Caller-authored placeholder');
      expect(parseSpecializedMissionProfileReference(selected!.profile.systemPrompt)).toMatchObject({
        profileId: PROFILE_ID,
        profileVersion: 1,
      });
    },
  );

  it.each(['candidate', 'draft', 'shadow', 'retired', 'revoked'] as const)(
    'fails closed for the inactive %s state',
    (state) => {
      expect(() => selectSpecializedMissionProfile({
        requestedProfile: requestedProfile(),
        registry: registry(profile(state)),
        context,
        at: NOW,
      })).toThrow(`is inactive in state ${state}`);
    },
  );

  it('requires the complete unexpired qualification chain and every required capability', () => {
    const incomplete = profile('default', 1, [evaluation('canary')]);
    expect(specializedProfileHasCurrentMissionQualification(incomplete, NOW)).toBe(false);
    expect(() => selectSpecializedMissionProfile({
      requestedProfile: requestedProfile(), registry: registry(incomplete), context, at: NOW,
    })).toThrow('complete qualification chain');

    const expired = profile('opt-in', 1, [
      evaluation('offline'),
      evaluation('shadow', 1, '2026-09-20T09:59:59.000Z'),
    ]);
    expect(() => selectSpecializedMissionProfile({
      requestedProfile: requestedProfile(), registry: registry(expired), context, at: NOW,
    })).toThrow('complete qualification chain');

    expect(() => selectSpecializedMissionProfile({
      requestedProfile: requestedProfile(),
      registry: registry(profile('opt-in')),
      context: {
        fields: context.fields,
        capabilities: [{ kind: 'workspace-read', name: 'workspace' }],
        executionRouteSha256: ROUTE_HASH,
      },
      at: NOW,
    })).toThrow('complete qualification chain');
  });

  it('pins version and provenance and rejects a later version drift', () => {
    const first = selectSpecializedMissionProfile({
      requestedProfile: requestedProfile(),
      registry: registry(profile('opt-in')),
      context,
      at: NOW,
    })!;
    const expected = parseSpecializedMissionProfileReference(first.profile.systemPrompt)!;
    const revised = profile('opt-in', 2, requiredStages('opt-in').map((stage) => evaluation(stage, 2)));

    expect(() => selectSpecializedMissionProfile({
      requestedProfile: first.profile,
      registry: registry(revised, 11),
      context,
      at: NOW,
      expected,
    })).toThrow('drifted from selected version 1');
  });

  it('requires monitoring to preserve the complete certified route and capability chain', () => {
    const record = profile('opt-in');
    record.evaluations.push({
      ...evaluation('opt-in'),
      id: 'monitor-route-b',
      runId: 'monitor-route-b',
      stageEntryTransitionSequence: 4,
      executionRouteSha256: '9'.repeat(64),
      completedAt: '2026-09-19T12:00:00.000Z',
      validUntil: '2026-10-20T12:00:00.000Z',
    });
    expect(() => selectSpecializedMissionProfile({
      requestedProfile: requestedProfile(),
      registry: registry(record),
      context: { ...context, executionRouteSha256: '9'.repeat(64) },
      at: NOW,
    })).toThrow('complete qualification chain');
  });

  it('suspends an active entry on its latest negative result and recovers on a later pass', () => {
    const record = profile('canary');
    const failed = {
      ...evaluation('canary'),
      id: 'monitor-canary-fail',
      runId: 'monitor-canary-fail',
      stageEntryTransitionSequence: 5,
      outcome: 'fail' as const,
      completedAt: '2026-09-19T12:00:00.000Z',
      validUntil: '2026-10-20T12:00:00.000Z',
      metrics: { ...evaluation('canary').metrics, verifiedPassCount: 0, verifiedPassRate: 0 },
    };
    record.evaluations.push(failed);
    expect(specializedProfileHasCurrentMissionQualification(record, NOW, {
      executionRouteSha256: ROUTE_HASH,
      capabilityEnvelopeSha256: CAPABILITY_HASH,
    })).toBe(false);

    record.evaluations.push({
      ...evaluation('canary'),
      id: 'monitor-canary-recovered',
      runId: 'monitor-canary-recovered',
      stageEntryTransitionSequence: 5,
      completedAt: '2026-09-19T13:00:00.000Z',
      validUntil: '2026-10-20T13:00:00.000Z',
    });
    expect(specializedProfileHasCurrentMissionQualification(record, NOW, {
      executionRouteSha256: ROUTE_HASH,
      capabilityEnvelopeSha256: CAPABILITY_HASH,
    })).toBe(true);
  });

  it('does not reactivate a negative default entry by downgrading or cycling state', () => {
    const record = profile('default');
    record.evaluations.push({
      ...evaluation('regression'),
      id: 'regression-fail',
      runId: 'regression-fail',
      outcome: 'fail',
      metrics: { ...evaluation('regression').metrics, verifiedPassCount: 0, verifiedPassRate: 0 },
      completedAt: '2026-09-19T12:00:00.000Z',
      validUntil: '2026-10-20T12:00:00.000Z',
    });
    record.transitions.push({
      sequence: 7, profileVersion: 1, from: 'default', to: 'canary',
      occurredAt: '2026-09-19T12:10:00.000Z', actorId: 'operator',
      reason: 'Fail closed downgrade.', evaluationIds: [],
    });
    record.currentState = 'canary';
    expect(specializedProfileHasCurrentMissionQualification(record, NOW, {
      executionRouteSha256: ROUTE_HASH,
      capabilityEnvelopeSha256: CAPABILITY_HASH,
    })).toBe(false);
  });

  it('accepts monotone promotion after admission but rejects a downgrade and re-entry cycle', () => {
    const admitted = selectSpecializedMissionProfile({
      requestedProfile: requestedProfile(), registry: registry(profile('opt-in')), context, at: NOW,
    })!;
    const promoted = profile('canary');
    expect(selectSpecializedMissionProfile({
      requestedProfile: admitted.profile, registry: registry(promoted, 8), context, at: NOW,
      expected: parseSpecializedMissionProfileReference(admitted.profile.systemPrompt)!,
    })).not.toBeNull();

    promoted.transitions.push({
      sequence: 6, profileVersion: 1, from: 'canary', to: 'opt-in',
      occurredAt: '2026-09-19T12:00:00.000Z', actorId: 'operator',
      reason: 'Downgrade.', evaluationIds: [],
    });
    promoted.currentState = 'opt-in';
    promoted.evaluations.push({
      ...evaluation('opt-in'), id: 'new-opt-in-entry-pass', runId: 'new-opt-in-entry-pass',
      stageEntryTransitionSequence: 6,
      startedAt: '2026-09-19T12:30:00.000Z',
      completedAt: '2026-09-19T13:00:00.000Z',
      validUntil: '2026-10-20T13:00:00.000Z',
      cohort: { ...evaluation('opt-in').cohort, closedAt: '2026-09-19T13:00:00.000Z' },
    });
    expect(() => selectSpecializedMissionProfile({
      requestedProfile: admitted.profile, registry: registry(promoted, 9), context, at: NOW,
      expected: parseSpecializedMissionProfileReference(admitted.profile.systemPrompt)!,
    })).toThrow('drifted');
  });

  it('does not auto-select an ordinary profile even when a registry id collides', () => {
    const ordinary = AgentProfileSchema.parse({
      id: 'worker', role: 'worker', specialty: 'document-production', systemPrompt: 'Ordinary worker.',
    });
    const colliding = { ...profile('opt-in'), id: 'worker' } as SpecializedProfileRecord;
    expect(selectSpecializedMissionProfile({
      requestedProfile: ordinary,
      registry: registry(colliding),
      context,
      at: NOW,
    })).toBeNull();
  });
});
