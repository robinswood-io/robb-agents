import type { DeduplicatedRootMission, RootMissionSpecializationObservation, SpecializationCandidateAssessment, SpecializationFamilyAnalysis, SpecializationOpportunityCategory, SpecializationOpportunityProposal, SpecializationOpportunityReport, SpecializationOpportunityThresholdOverrides, SpecializationOpportunityThresholds } from './contracts.ts';
import { AGENT_BOUNDARY_SIGNALS, CATEGORY_SIGNAL_DESCRIPTIONS, MEMORY_SIGNALS, SPECIALIZATION_OPPORTUNITY_CATEGORIES } from './contracts.ts';
import { canonicalFamily, deduplicateRootMissionObservations, formatRate, lexical, passFail, proposalId, sortedEntries, sortedStrings } from './observations.ts';
import { resolveSpecializationOpportunityThresholds } from './validation.ts';

/**
 * Detect specialization opportunities from externally adjudicated root-mission
 * observations. This function performs no I/O and cannot activate a proposal.
 */
export function detectSpecializationOpportunities(
  observations: readonly RootMissionSpecializationObservation[],
  thresholdOverrides: SpecializationOpportunityThresholdOverrides = {},
): SpecializationOpportunityReport {
  const thresholds = resolveSpecializationOpportunityThresholds(thresholdOverrides);
  const roots = deduplicateRootMissionObservations(observations);
  const familyGroups = new Map<string, DeduplicatedRootMission[]>();
  for (const root of roots) {
    const group = familyGroups.get(root.normalizedFamily) ?? [];
    group.push(root);
    familyGroups.set(root.normalizedFamily, group);
  }

  const analyses: SpecializationFamilyAnalysis[] = [];
  const proposals: SpecializationOpportunityProposal[] = [];
  for (const [normalizedFamily, familyRoots] of sortedEntries(familyGroups)) {
    const rootsInFamily = [...familyRoots].sort((left, right) => lexical(left.key, right.key));
    const family = canonicalFamily(rootsInFamily);
    const rawObservationCount = rootsInFamily.reduce(
      (total, root) => total + root.rawObservationCount,
      0,
    );
    const candidates = SPECIALIZATION_OPPORTUNITY_CATEGORIES.map((category) =>
      assessCategory(category, rootsInFamily, thresholds));
    const selected = candidates.find((candidate) => candidate.eligible);
    const eligibleAlternatives = candidates
      .filter((candidate) => candidate.eligible && candidate !== selected)
      .map((candidate) => candidate.category);
    const explanation = selected
      ? [
        ...selected.reasons,
        eligibleAlternatives.length === 0
          ? `${selected.category} is the only category that meets its configured thresholds.`
          : `${selected.category} wins the conservative precedence over: ${eligibleAlternatives.join(', ')}.`,
      ]
      : [
        `No category meets all configured thresholds for ${family}.`,
        ...candidates.flatMap((candidate) =>
          candidate.reasons.filter((reason) => reason.endsWith('(fail).'))),
      ];

    analyses.push({
      family,
      normalizedFamily,
      rawObservationCount,
      rootMissionCount: rootsInFamily.length,
      candidates,
      ...(selected ? { selectedCategory: selected.category } : {}),
      explanation,
    });
    if (!selected) continue;

    const supportingRoots = rootsInFamily.filter((root) =>
      rootSupportsCategory(root, selected.category, thresholds['agent-profile'].minimumBoundaryKinds));
    proposals.push({
      schemaVersion: 1,
      proposalId: proposalId(normalizedFamily, selected.category),
      family,
      normalizedFamily,
      category: selected.category,
      state: 'inactive',
      activationMode: 'human-review-required',
      automaticActivation: false,
      rawObservationCount,
      rootMissionCount: rootsInFamily.length,
      supportingRootMissionCount: supportingRoots.length,
      supportingRate: supportingRoots.length / rootsInFamily.length,
      supportingObservationIds: sortedStrings(new Set(
        supportingRoots.flatMap((root) => [...root.observationIds]),
      )),
      explanation: [
        ...explanation,
        'The proposal remains inactive until an external human review; this engine cannot activate it.',
      ],
    });
  }

  return {
    schemaVersion: 1,
    mode: 'analysis-only',
    mutationMode: 'forbidden',
    activationMode: 'proposal-only',
    thresholds,
    rawObservationCount: observations.length,
    deduplicatedRootMissionCount: roots.length,
    analyses,
    proposals,
  };
}

function assessCategory(
  category: SpecializationOpportunityCategory,
  roots: readonly DeduplicatedRootMission[],
  thresholds: SpecializationOpportunityThresholds,
): SpecializationCandidateAssessment {
  const threshold = thresholds[category];
  const supportingCount = roots.filter((root) =>
    rootSupportsCategory(root, category, thresholds['agent-profile'].minimumBoundaryKinds)).length;
  const supportingRate = supportingCount / roots.length;
  const recurrencePasses = roots.length >= threshold.minimumFamilyRootMissions;
  const countPasses = supportingCount >= threshold.minimumSupportingRootMissions;
  const ratePasses = supportingRate >= threshold.minimumSupportingRate;
  const reasons = [
    `${roots.length} deduplicated root missions observed; minimum is ${threshold.minimumFamilyRootMissions} (${passFail(recurrencePasses)}).`,
    `${supportingCount}/${roots.length} root missions show ${CATEGORY_SIGNAL_DESCRIPTIONS[category]}; `
      + `minimum count is ${threshold.minimumSupportingRootMissions} and minimum rate is `
      + `${formatRate(threshold.minimumSupportingRate)} (${passFail(countPasses && ratePasses)}).`,
  ];
  if (category === 'agent-profile') {
    reasons.push(
      `Each supporting mission has stable-variable-workflow, domain-judgment, and at least `
        + `${thresholds['agent-profile'].minimumBoundaryKinds}/3 stable tool, risk, or verification boundaries.`,
    );
  }
  return {
    category,
    eligible: recurrencePasses && countPasses && ratePasses,
    familyRootMissionCount: roots.length,
    supportingRootMissionCount: supportingCount,
    supportingRate,
    threshold: { ...threshold },
    reasons,
  };
}

function rootSupportsCategory(
  root: DeduplicatedRootMission,
  category: SpecializationOpportunityCategory,
  minimumBoundaryKinds: number,
): boolean {
  switch (category) {
    case 'platform-fix':
      return root.signals.has('platform-defect');
    case 'memory':
      return [...MEMORY_SIGNALS].some((signal) => root.signals.has(signal));
    case 'automation':
      return root.signals.has('deterministic-procedure');
    case 'skill':
      return root.signals.has('stable-variable-workflow');
    case 'agent-profile':
      return root.signals.has('stable-variable-workflow')
        && root.signals.has('domain-judgment')
        && AGENT_BOUNDARY_SIGNALS.filter((signal) => root.signals.has(signal)).length >= minimumBoundaryKinds;
  }
}
