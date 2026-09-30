/**
 * Privacy-minimal evidence attached to a root mission observation.
 *
 * The contract intentionally excludes transcripts, prompts, responses, tool
 * payloads, routes, models, and permissions. Callers must adjudicate these
 * signals before passing them to this read-only classifier.
 */
export const SPECIALIZATION_SIGNALS = [
  'platform-defect',
  'context-retrieval-gap',
  'durable-preference',
  'reusable-knowledge',
  'deterministic-procedure',
  'stable-variable-workflow',
  'domain-judgment',
  'stable-tool-boundary',
  'stable-risk-boundary',
  'stable-verification-boundary',
] as const;

export type SpecializationSignal = typeof SPECIALIZATION_SIGNALS[number];

export const SPECIALIZATION_OPPORTUNITY_CATEGORIES = [
  // Order is also conservative selection precedence. A shared defect or
  // missing context should be corrected before adding execution machinery;
  // a bounded agent profile supersedes the less isolated skill alternative.
  'platform-fix',
  'memory',
  'automation',
  'agent-profile',
  'skill',
] as const;

export type SpecializationOpportunityCategory =
  typeof SPECIALIZATION_OPPORTUNITY_CATEGORIES[number];

export interface RootMissionSpecializationObservation {
  /** Stable identifier of the externally adjudicated observation. */
  readonly observationId: string;
  /** Objective of the root mission, never a child-agent objective. */
  readonly rootObjective: string;
  /** Stable task-family label supplied by the host or an offline audit. */
  readonly family: string;
  /** Structured signals only; no transcript-derived free-form payload. */
  readonly signals: readonly SpecializationSignal[];
}

export interface SpecializationCategoryThreshold {
  readonly minimumFamilyRootMissions: number;
  readonly minimumSupportingRootMissions: number;
  readonly minimumSupportingRate: number;
}

export interface AgentProfileOpportunityThreshold extends SpecializationCategoryThreshold {
  /** Number of tool, risk, and verification boundaries required on each supporting mission. */
  readonly minimumBoundaryKinds: number;
}

export interface SpecializationOpportunityThresholds {
  readonly 'platform-fix': SpecializationCategoryThreshold;
  readonly memory: SpecializationCategoryThreshold;
  readonly automation: SpecializationCategoryThreshold;
  readonly skill: SpecializationCategoryThreshold;
  readonly 'agent-profile': AgentProfileOpportunityThreshold;
}

export interface SpecializationOpportunityThresholdOverrides {
  readonly 'platform-fix'?: Partial<SpecializationCategoryThreshold>;
  readonly memory?: Partial<SpecializationCategoryThreshold>;
  readonly automation?: Partial<SpecializationCategoryThreshold>;
  readonly skill?: Partial<SpecializationCategoryThreshold>;
  readonly 'agent-profile'?: Partial<AgentProfileOpportunityThreshold>;
}

export const DEFAULT_SPECIALIZATION_OPPORTUNITY_THRESHOLDS: SpecializationOpportunityThresholds =
  Object.freeze({
    'platform-fix': Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
    }),
    memory: Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
    }),
    automation: Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
    }),
    skill: Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
    }),
    'agent-profile': Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
      minimumBoundaryKinds: 3,
    }),
  });

export interface SpecializationCandidateAssessment {
  readonly category: SpecializationOpportunityCategory;
  readonly eligible: boolean;
  readonly familyRootMissionCount: number;
  readonly supportingRootMissionCount: number;
  readonly supportingRate: number;
  readonly threshold: SpecializationCategoryThreshold | AgentProfileOpportunityThreshold;
  readonly reasons: readonly string[];
}

export interface SpecializationFamilyAnalysis {
  readonly family: string;
  readonly normalizedFamily: string;
  readonly rawObservationCount: number;
  readonly rootMissionCount: number;
  readonly candidates: readonly SpecializationCandidateAssessment[];
  readonly selectedCategory?: SpecializationOpportunityCategory;
  readonly explanation: readonly string[];
}

/**
 * A recommendation only. There is deliberately no active state or activation
 * callback in this contract.
 */
export interface SpecializationOpportunityProposal {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly family: string;
  readonly normalizedFamily: string;
  readonly category: SpecializationOpportunityCategory;
  readonly state: 'inactive';
  readonly activationMode: 'human-review-required';
  readonly automaticActivation: false;
  readonly rawObservationCount: number;
  readonly rootMissionCount: number;
  readonly supportingRootMissionCount: number;
  readonly supportingRate: number;
  readonly supportingObservationIds: readonly string[];
  readonly explanation: readonly string[];
}

export interface SpecializationOpportunityReport {
  readonly schemaVersion: 1;
  readonly mode: 'analysis-only';
  readonly mutationMode: 'forbidden';
  readonly activationMode: 'proposal-only';
  readonly thresholds: SpecializationOpportunityThresholds;
  readonly rawObservationCount: number;
  readonly deduplicatedRootMissionCount: number;
  readonly analyses: readonly SpecializationFamilyAnalysis[];
  readonly proposals: readonly SpecializationOpportunityProposal[];
}

interface DeduplicatedRootMission {
  readonly key: string;
  readonly normalizedFamily: string;
  readonly familyVariants: Set<string>;
  readonly observationIds: Set<string>;
  readonly signals: Set<SpecializationSignal>;
  rawObservationCount: number;
}

const OBSERVATION_KEYS = new Set(['observationId', 'rootObjective', 'family', 'signals']);
const SIGNAL_SET = new Set<string>(SPECIALIZATION_SIGNALS);
const CATEGORY_SET = new Set<string>(SPECIALIZATION_OPPORTUNITY_CATEGORIES);
const BASE_THRESHOLD_KEYS = new Set([
  'minimumFamilyRootMissions',
  'minimumSupportingRootMissions',
  'minimumSupportingRate',
]);
const AGENT_THRESHOLD_KEYS = new Set([...BASE_THRESHOLD_KEYS, 'minimumBoundaryKinds']);
const MEMORY_SIGNALS = new Set<SpecializationSignal>([
  'context-retrieval-gap',
  'durable-preference',
  'reusable-knowledge',
]);
const AGENT_BOUNDARY_SIGNALS = [
  'stable-tool-boundary',
  'stable-risk-boundary',
  'stable-verification-boundary',
] as const satisfies readonly SpecializationSignal[];

const CATEGORY_SIGNAL_DESCRIPTIONS: Record<SpecializationOpportunityCategory, string> = {
  'platform-fix': 'a recurring platform defect',
  memory: 'a durable-context or reusable-knowledge need',
  automation: 'a deterministic procedure',
  skill: 'a stable workflow with variable inputs',
  'agent-profile': 'a stable judgment workflow with its own operational boundaries',
};

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

export function resolveSpecializationOpportunityThresholds(
  overrides: SpecializationOpportunityThresholdOverrides = {},
): SpecializationOpportunityThresholds {
  assertPlainRecord(overrides, 'threshold overrides');
  assertNoUnknownKeys(overrides, CATEGORY_SET, 'threshold overrides');
  const resolved = {} as Record<SpecializationOpportunityCategory, SpecializationCategoryThreshold>;
  for (const category of SPECIALIZATION_OPPORTUNITY_CATEGORIES) {
    const override = overrides[category];
    if (override !== undefined) {
      assertPlainRecord(override, `${category} threshold`);
      assertNoUnknownKeys(
        override,
        category === 'agent-profile' ? AGENT_THRESHOLD_KEYS : BASE_THRESHOLD_KEYS,
        `${category} threshold`,
      );
    }
    const threshold = { ...DEFAULT_SPECIALIZATION_OPPORTUNITY_THRESHOLDS[category], ...override };
    validateBaseThreshold(category, threshold);
    if (category === 'agent-profile') {
      const boundaryKinds = (threshold as AgentProfileOpportunityThreshold).minimumBoundaryKinds;
      if (!Number.isInteger(boundaryKinds) || boundaryKinds < 1 || boundaryKinds > 3) {
        throw new Error('agent-profile.minimumBoundaryKinds must be an integer between 1 and 3');
      }
    }
    resolved[category] = threshold;
  }
  return resolved as unknown as SpecializationOpportunityThresholds;
}

function deduplicateRootMissionObservations(
  observations: readonly RootMissionSpecializationObservation[],
): DeduplicatedRootMission[] {
  if (!Array.isArray(observations)) throw new Error('observations must be an array');
  const roots = new Map<string, DeduplicatedRootMission>();
  const keyByObservationId = new Map<string, string>();
  for (const [index, observation] of observations.entries()) {
    validateObservation(observation, index);
    const observationId = observation.observationId.trim();
    const normalizedFamily = normalizeIdentity(observation.family);
    const normalizedObjective = normalizeIdentity(observation.rootObjective);
    const key = `${normalizedFamily}\u0000${normalizedObjective}`;
    const previousKey = keyByObservationId.get(observationId);
    if (previousKey !== undefined && previousKey !== key) {
      throw new Error(`observationId "${observationId}" refers to more than one root mission`);
    }
    keyByObservationId.set(observationId, key);

    const existing = roots.get(key);
    if (existing) {
      existing.rawObservationCount += 1;
      existing.familyVariants.add(observation.family.trim());
      existing.observationIds.add(observationId);
      for (const signal of observation.signals) existing.signals.add(signal);
      continue;
    }
    roots.set(key, {
      key,
      normalizedFamily,
      familyVariants: new Set([observation.family.trim()]),
      observationIds: new Set([observationId]),
      signals: new Set(observation.signals),
      rawObservationCount: 1,
    });
  }
  return [...roots.values()].sort((left, right) => lexical(left.key, right.key));
}

function validateObservation(
  observation: RootMissionSpecializationObservation,
  index: number,
): void {
  assertPlainRecord(observation, `observation[${index}]`);
  assertNoUnknownKeys(observation, OBSERVATION_KEYS, `observation[${index}]`);
  validateBoundedString(observation.observationId, `observation[${index}].observationId`, 200);
  validateBoundedString(observation.rootObjective, `observation[${index}].rootObjective`, 2_000);
  validateBoundedString(observation.family, `observation[${index}].family`, 200);
  if (!Array.isArray(observation.signals)) {
    throw new Error(`observation[${index}].signals must be an array`);
  }
  for (const signal of observation.signals) {
    if (typeof signal !== 'string' || !SIGNAL_SET.has(signal)) {
      throw new Error(`observation[${index}].signals contains unsupported signal "${String(signal)}"`);
    }
  }
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

function validateBaseThreshold(
  category: SpecializationOpportunityCategory,
  threshold: SpecializationCategoryThreshold,
): void {
  for (const key of ['minimumFamilyRootMissions', 'minimumSupportingRootMissions'] as const) {
    const value = threshold[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${category}.${key} must be a positive integer`);
    }
  }
  const rate = threshold.minimumSupportingRate;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`${category}.minimumSupportingRate must be between 0 and 1`);
  }
}

function validateBoundedString(value: unknown, path: string, maximumLength: number): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${path} must be at most ${maximumLength} characters`);
  }
}

function assertPlainRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object`);
  }
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unsupported field "${unknown[0]}"`);
}

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function canonicalFamily(roots: readonly DeduplicatedRootMission[]): string {
  return sortedStrings(new Set(roots.flatMap((root) => [...root.familyVariants])))[0]!;
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): Array<[string, T]> {
  return [...map.entries()].sort(([left], [right]) => lexical(left, right));
}

function sortedStrings(values: ReadonlySet<string>): string[] {
  return [...values].sort(lexical);
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function passFail(passed: boolean): 'pass' | 'fail' {
  return passed ? 'pass' : 'fail';
}

function formatRate(rate: number): string {
  return rate.toFixed(3);
}

function proposalId(
  normalizedFamily: string,
  category: SpecializationOpportunityCategory,
): string {
  const slug = normalizedFamily
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48) || 'family';
  return `specialization:${category}:${slug}:${stableHash(normalizedFamily)}`;
}

/** Non-cryptographic, deterministic identifier suffix; never used as proof. */
function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    first = Math.imul(first ^ unit, 0x01000193);
    second = Math.imul(second ^ unit, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}
