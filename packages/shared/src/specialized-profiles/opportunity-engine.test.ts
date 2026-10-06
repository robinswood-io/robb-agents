import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SPECIALIZATION_OPPORTUNITY_THRESHOLDS,
  detectSpecializationOpportunities,
  type RootMissionSpecializationObservation,
  type SpecializationSignal,
} from './opportunity-engine.ts';

function familyObservations(
  family: string,
  signals: readonly SpecializationSignal[],
  count = 8,
): RootMissionSpecializationObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    observationId: `${family}-${index + 1}`,
    rootObjective: `Root objective ${index + 1}`,
    family,
    signals,
  }));
}

describe('specialization opportunity engine', () => {
  it('classifies each recurring family with the least expansive fitting response', () => {
    const observations = [
      ...familyObservations('A platform family', ['platform-defect']),
      ...familyObservations('B memory family', ['context-retrieval-gap']),
      ...familyObservations('C automation family', ['deterministic-procedure']),
      ...familyObservations('D skill family', ['stable-variable-workflow']),
      ...familyObservations('E profile family', [
        'stable-variable-workflow',
        'domain-judgment',
        'stable-tool-boundary',
        'stable-risk-boundary',
        'stable-verification-boundary',
      ]),
    ];

    const report = detectSpecializationOpportunities(observations);

    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: 'analysis-only',
      mutationMode: 'forbidden',
      activationMode: 'proposal-only',
      rawObservationCount: 40,
      deduplicatedRootMissionCount: 40,
      thresholds: {
        'platform-fix': {
          minimumFamilyRootMissions: 8,
          minimumSupportingRootMissions: 5,
          minimumSupportingRate: 0.6,
        },
        memory: {
          minimumFamilyRootMissions: 8,
          minimumSupportingRootMissions: 5,
          minimumSupportingRate: 0.6,
        },
        automation: {
          minimumFamilyRootMissions: 8,
          minimumSupportingRootMissions: 5,
          minimumSupportingRate: 0.6,
        },
        skill: {
          minimumFamilyRootMissions: 8,
          minimumSupportingRootMissions: 5,
          minimumSupportingRate: 0.6,
        },
        'agent-profile': {
          minimumFamilyRootMissions: 8,
          minimumSupportingRootMissions: 5,
          minimumSupportingRate: 0.6,
          minimumBoundaryKinds: 3,
        },
      },
    });
    expect(report.proposals.map(({ family, category }) => [family, category])).toEqual([
      ['A platform family', 'platform-fix'],
      ['B memory family', 'memory'],
      ['C automation family', 'automation'],
      ['D skill family', 'skill'],
      ['E profile family', 'agent-profile'],
    ]);
    expect(report.proposals.every((proposal) =>
      proposal.state === 'inactive'
      && proposal.activationMode === 'human-review-required'
      && proposal.automaticActivation === false)).toBe(true);
    expect(JSON.stringify(report.proposals)).not.toContain('permissionMode');
    expect(JSON.stringify(report.proposals)).not.toContain('model');
    expect(JSON.stringify(report.proposals)).not.toContain('route');
  });

  it('deduplicates normalized root objective and family pairs without inflating recurrence', () => {
    const observations: RootMissionSpecializationObservation[] = [
      {
        observationId: 'child-a', rootObjective: '  Generate   invoice ', family: ' Finance ',
        signals: ['deterministic-procedure'],
      },
      {
        observationId: 'child-b', rootObjective: 'generate invoice', family: 'finance',
        signals: ['stable-verification-boundary'],
      },
      {
        observationId: 'child-c', rootObjective: 'GENERATE INVOICE', family: 'FINANCE',
        signals: ['deterministic-procedure'],
      },
    ];

    const report = detectSpecializationOpportunities(observations, {
      automation: {
        minimumFamilyRootMissions: 2,
        minimumSupportingRootMissions: 2,
        minimumSupportingRate: 1,
      },
    });

    expect(report).toMatchObject({ rawObservationCount: 3, deduplicatedRootMissionCount: 1 });
    expect(report.proposals).toEqual([]);
    expect(report.analyses[0]).toMatchObject({
      rawObservationCount: 3,
      rootMissionCount: 1,
    });
    expect(report.analyses[0]?.selectedCategory).toBeUndefined();
  });

  it('uses conservative precedence and records why other eligible responses were not selected', () => {
    const allSignals: SpecializationSignal[] = [
      'platform-defect',
      'context-retrieval-gap',
      'deterministic-procedure',
      'stable-variable-workflow',
      'domain-judgment',
      'stable-tool-boundary',
      'stable-risk-boundary',
      'stable-verification-boundary',
    ];
    const report = detectSpecializationOpportunities(familyObservations('Mixed', allSignals));
    const proposal = report.proposals[0]!;

    expect(proposal.category).toBe('platform-fix');
    expect(proposal.explanation.join(' ')).toContain(
      'platform-fix wins the conservative precedence over: memory, automation, agent-profile, skill',
    );
  });

  it('honors per-category thresholds, including the profile boundary requirement', () => {
    const observations = familyObservations('Legal review', [
      'stable-variable-workflow',
      'domain-judgment',
      'stable-risk-boundary',
      'stable-verification-boundary',
    ], 2);

    const defaultReport = detectSpecializationOpportunities(observations);
    expect(defaultReport.proposals).toEqual([]);

    const configured = detectSpecializationOpportunities(observations, {
      skill: {
        minimumFamilyRootMissions: 2,
        minimumSupportingRootMissions: 2,
        minimumSupportingRate: 1,
      },
      'agent-profile': {
        minimumFamilyRootMissions: 2,
        minimumSupportingRootMissions: 2,
        minimumSupportingRate: 1,
        minimumBoundaryKinds: 2,
      },
    });
    expect(configured.proposals[0]).toMatchObject({
      category: 'agent-profile',
      rootMissionCount: 2,
      supportingRootMissionCount: 2,
      supportingRate: 1,
    });
    expect(configured.analyses[0]?.candidates.find(({ category }) => category === 'agent-profile'))
      .toMatchObject({ eligible: true, threshold: { minimumBoundaryKinds: 2 } });
  });

  it('returns auditable failed assessments instead of a weak proposal', () => {
    const report = detectSpecializationOpportunities([
      ...familyObservations('Rare workflow', ['stable-variable-workflow'], 1),
      {
        observationId: 'rare-2', rootObjective: 'Root objective 2', family: 'Rare workflow', signals: [],
      },
      {
        observationId: 'rare-3', rootObjective: 'Root objective 3', family: 'Rare workflow', signals: [],
      },
    ]);

    expect(report.proposals).toEqual([]);
    expect(report.analyses[0]?.explanation.join(' ')).toContain('No category meets all configured thresholds');
    expect(report.analyses[0]?.candidates.find(({ category }) => category === 'skill')).toMatchObject({
      eligible: false,
      familyRootMissionCount: 3,
      supportingRootMissionCount: 1,
      supportingRate: 1 / 3,
    });
  });

  it('applies the default count and rate thresholds at their exact boundary', () => {
    const observations = (supportingCount: number): RootMissionSpecializationObservation[] =>
      Array.from({ length: 8 }, (_, index) => ({
        observationId: `boundary-${supportingCount}-${index}`,
        rootObjective: `Boundary objective ${index}`,
        family: `Boundary ${supportingCount}`,
        signals: index < supportingCount ? ['deterministic-procedure'] : [],
      }));

    const below = detectSpecializationOpportunities(observations(4));
    const atBoundary = detectSpecializationOpportunities(observations(5));

    expect(below.proposals).toEqual([]);
    expect(atBoundary.proposals).toHaveLength(1);
    expect(atBoundary.proposals[0]).toMatchObject({
      category: 'automation',
      rootMissionCount: 8,
      supportingRootMissionCount: 5,
      supportingRate: 0.625,
    });
  });

  it('is deterministic and does not mutate observations or threshold overrides', () => {
    const observations = familyObservations('Invoices', ['deterministic-procedure']);
    const overrides = { automation: { minimumSupportingRate: 0.5 } } as const;
    const observationsBefore = structuredClone(observations);
    const overridesBefore = structuredClone(overrides);

    const first = detectSpecializationOpportunities(observations, overrides);
    const second = detectSpecializationOpportunities([...observations].reverse(), overrides);

    expect(first).toEqual(second);
    expect(observations).toEqual(observationsBefore);
    expect(overrides).toEqual(overridesBefore);
    expect(first.thresholds.automation).toEqual({
      ...DEFAULT_SPECIALIZATION_OPPORTUNITY_THRESHOLDS.automation,
      minimumSupportingRate: 0.5,
    });
  });

  it('rejects transcripts, unsupported signals, ambiguous ids, and invalid thresholds', () => {
    const withTranscript = {
      observationId: 'obs-1',
      rootObjective: 'Objective',
      family: 'Family',
      signals: [],
      transcript: 'private chat body',
    } as unknown as RootMissionSpecializationObservation;
    expect(() => detectSpecializationOpportunities([withTranscript])).toThrow(
      'unsupported field "transcript"',
    );

    const invalidSignal = {
      observationId: 'obs-1', rootObjective: 'Objective', family: 'Family', signals: ['unknown'],
    } as unknown as RootMissionSpecializationObservation;
    expect(() => detectSpecializationOpportunities([invalidSignal])).toThrow('unsupported signal');

    expect(() => detectSpecializationOpportunities([
      { observationId: 'same', rootObjective: 'One', family: 'Family', signals: [] },
      { observationId: 'same', rootObjective: 'Two', family: 'Family', signals: [] },
    ])).toThrow('refers to more than one root mission');

    expect(() => detectSpecializationOpportunities([], {
      automation: { minimumSupportingRate: Number.NaN },
    })).toThrow('minimumSupportingRate must be between 0 and 1');
    expect(() => detectSpecializationOpportunities([], {
      'agent-profile': { minimumBoundaryKinds: 4 },
    })).toThrow('minimumBoundaryKinds must be an integer between 1 and 3');
    expect(() => detectSpecializationOpportunities([], {
      automation: { unexpected: 1 } as never,
    })).toThrow('unsupported field "unexpected"');
  });
});
