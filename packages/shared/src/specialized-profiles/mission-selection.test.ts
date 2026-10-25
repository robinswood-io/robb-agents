import { describe, expect, it } from "bun:test";
import { AgentProfileSchema } from "../missions/schema.ts";
import type { SpecializedProfileRecord } from "./schema.ts";
import { parseSpecializedMissionProfileReference, selectSpecializedMissionProfile, specializedProfileHasCurrentMissionQualification } from "./mission-selection.ts";
import { CAPABILITY_HASH, NOW, PROFILE_ID, ROUTE_HASH, context, evaluation, profile, registry, requestedProfile, requiredStages } from "./testing/mission-selection-fixture.ts";

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
