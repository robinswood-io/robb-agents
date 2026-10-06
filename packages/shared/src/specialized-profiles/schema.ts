import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SPECIALIZED_PROFILE_REGISTRY_SCHEMA_VERSION = 2 as const;
export const SPECIALIZED_PROFILE_VERSION_SCHEMA_VERSION = 1 as const;
export const SPECIALIZED_PROFILE_REGISTRY_HEAD_SCHEMA_VERSION = 1 as const;
export const SPECIALIZED_PROFILE_REGISTRY_ANCHOR_SCHEMA_VERSION = 1 as const;

export const SPECIALIZED_PROFILE_STATES = [
  'candidate',
  'draft',
  'shadow',
  'opt-in',
  'canary',
  'default',
  'retired',
  'revoked',
] as const;

export const SPECIALIZED_PROFILE_EVALUATION_STAGES = [
  'offline',
  'shadow',
  'opt-in',
  'canary',
  'regression',
] as const;

export const SPECIALIZED_PROFILE_MIN_EVALUATION_CASES = 20 as const;

export const SPECIALIZED_PROFILE_ALLOWED_TRANSITIONS = Object.freeze({
  candidate: ['draft', 'revoked'],
  draft: ['shadow', 'retired', 'revoked'],
  shadow: ['draft', 'opt-in', 'retired', 'revoked'],
  'opt-in': ['shadow', 'canary', 'retired', 'revoked'],
  canary: ['opt-in', 'default', 'retired', 'revoked'],
  default: ['canary', 'retired', 'revoked'],
  retired: ['draft', 'revoked'],
  revoked: [],
} satisfies Record<
  (typeof SPECIALIZED_PROFILE_STATES)[number],
  readonly (typeof SPECIALIZED_PROFILE_STATES)[number][]
>);

export const SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE: Readonly<
  Partial<Record<(typeof SPECIALIZED_PROFILE_STATES)[number], (typeof SPECIALIZED_PROFILE_EVALUATION_STAGES)[number]>>
> = Object.freeze({
  shadow: 'offline',
  'opt-in': 'shadow',
  canary: 'opt-in',
  default: 'canary',
});

const SPECIALIZED_PROFILE_PROMOTION_RANK: Readonly<Partial<Record<SpecializedProfileState, number>>> = {
  candidate: 0,
  draft: 1,
  shadow: 2,
  'opt-in': 3,
  canary: 4,
  default: 5,
};

export function specializedProfileTransitionIsPromotion(
  from: SpecializedProfileState,
  to: SpecializedProfileState,
): boolean {
  const fromRank = SPECIALIZED_PROFILE_PROMOTION_RANK[from];
  const toRank = SPECIALIZED_PROFILE_PROMOTION_RANK[to];
  return fromRank !== undefined && toRank !== undefined && toRank > fromRank;
}

export const SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE: Readonly<
  Record<
    (typeof SPECIALIZED_PROFILE_EVALUATION_STAGES)[number],
    (typeof SPECIALIZED_PROFILE_STATES)[number]
  >
> = Object.freeze({
  offline: 'draft',
  shadow: 'shadow',
  'opt-in': 'opt-in',
  canary: 'canary',
  regression: 'default',
});

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CONDITION_FIELD_RE = /^[a-z][a-z0-9_.-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const profileId = z.string().regex(
  PROFILE_ID_RE,
  'Profile id must be a lowercase slug (a-z, 0-9, hyphens)',
);
const identifier = (label: string) => z.string().trim().min(1, `${label} is required`).max(256);
const timestamp = z.string().datetime({ offset: true });

export const SpecializedProfileStateSchema = z.enum(SPECIALIZED_PROFILE_STATES);
export type SpecializedProfileState = z.infer<typeof SpecializedProfileStateSchema>;

export const SpecializedProfileConditionSchema = z.object({
  id: profileId,
  description: z.string().trim().min(1).max(2_000),
  field: z.string().regex(CONDITION_FIELD_RE),
  operator: z.enum(['equals', 'includes', 'matches', 'present']),
  value: z.string().trim().min(1).max(1_024).optional(),
}).strict().superRefine((condition, ctx) => {
  if (condition.operator !== 'present' && condition.value === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: `${condition.operator} requires a value`,
    });
  }
  if (condition.operator === 'present' && condition.value !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'present must not declare a value',
    });
  }
});
export type SpecializedProfileCondition = z.infer<typeof SpecializedProfileConditionSchema>;

export const SpecializedProfileRequestedCapabilitySchema = z.object({
  id: profileId,
  kind: z.enum([
    'skill',
    'tool',
    'source',
    'workspace-read',
    'workspace-write',
    'network',
    'external-mutation',
  ]),
  name: z.string().trim().min(1).max(256),
  justification: z.string().trim().min(1).max(2_000),
  required: z.boolean(),
}).strict();
export type SpecializedProfileRequestedCapability = z.infer<typeof SpecializedProfileRequestedCapabilitySchema>;

export const SpecializedAgentProfileDefinitionSchema = z.object({
  displayName: z.string().trim().min(1).max(128),
  role: z.enum(['planner', 'worker', 'reviewer', 'supervisor']),
  specialty: z.string().trim().min(1).max(512),
  objective: z.string().trim().min(1).max(4_000),
  systemPrompt: z.string().trim().min(1).max(64_000),
  riskClass: z.enum(['low', 'moderate', 'high', 'critical']),
  eligibilityCriteria: z.array(SpecializedProfileConditionSchema).min(1).max(64),
  abstentionCriteria: z.array(SpecializedProfileConditionSchema).min(1).max(64),
  requestedCapabilities: z.array(SpecializedProfileRequestedCapabilitySchema).max(64).default([]),
  successCriteria: z.array(z.object({
    id: profileId,
    description: z.string().trim().min(1).max(2_000),
  }).strict()).min(1).max(64),
}).strict().superRefine((definition, ctx) => {
  for (const [field, values] of [
    ['eligibilityCriteria', definition.eligibilityCriteria],
    ['abstentionCriteria', definition.abstentionCriteria],
    ['requestedCapabilities', definition.requestedCapabilities],
    ['successCriteria', definition.successCriteria],
  ] as const) {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, index, 'id'],
          message: `${field} ids must be unique`,
        });
      }
      seen.add(value.id);
    });
  }
});
export type SpecializedAgentProfileDefinition = z.infer<typeof SpecializedAgentProfileDefinitionSchema>;

export const SpecializedProfileSourceRefSchema = z.object({
  kind: z.enum(['session', 'mission', 'artifact', 'evaluation', 'manual']),
  sourceId: identifier('Source id').optional(),
  uri: z.string().trim().min(1).max(2_048).optional(),
  sha256: z.string().regex(SHA256_RE),
  redacted: z.literal(true),
}).strict().refine((source) => source.sourceId !== undefined || source.uri !== undefined, {
  message: 'A provenance source requires sourceId or uri',
});
export type SpecializedProfileSourceRef = z.infer<typeof SpecializedProfileSourceRefSchema>;

export const SpecializedProfileProvenanceSchema = z.object({
  method: z.enum(['mission-pattern', 'chat-pattern', 'manual', 'import']),
  proposedBy: z.object({
    kind: z.enum(['human', 'agent', 'service']),
    actorId: identifier('Proposer actor id'),
  }).strict(),
  generatedBy: z.object({
    name: identifier('Generator name'),
    version: z.string().trim().min(1).max(128),
  }).strict(),
  generatedAt: timestamp,
  analysisWindow: z.object({
    from: timestamp,
    to: timestamp,
  }).strict().optional(),
  sample: z.object({
    rawTaskCount: z.number().int().positive(),
    deduplicatedRootTaskCount: z.number().int().positive(),
  }).strict(),
  sources: z.array(SpecializedProfileSourceRefSchema).min(1).max(10_000),
}).strict().superRefine((provenance, ctx) => {
  if (provenance.sample.deduplicatedRootTaskCount > provenance.sample.rawTaskCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sample', 'deduplicatedRootTaskCount'],
      message: 'Deduplicated root task count cannot exceed raw task count',
    });
  }
  if (provenance.analysisWindow
    && Date.parse(provenance.analysisWindow.to) < Date.parse(provenance.analysisWindow.from)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['analysisWindow', 'to'],
      message: 'Analysis window end cannot precede its start',
    });
  }
  const hashes = new Set<string>();
  provenance.sources.forEach((source, index) => {
    if (hashes.has(source.sha256)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources', index, 'sha256'],
        message: 'Provenance source hashes must be unique',
      });
    }
    hashes.add(source.sha256);
  });
});
export type SpecializedProfileProvenance = z.infer<typeof SpecializedProfileProvenanceSchema>;

export const SpecializedProfileVersionSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_VERSION_SCHEMA_VERSION),
  profileId,
  version: z.number().int().positive(),
  definition: SpecializedAgentProfileDefinitionSchema,
  provenance: SpecializedProfileProvenanceSchema,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('initial'), reason: z.string().trim().min(1).max(2_000) }).strict(),
    z.object({
      kind: z.literal('revision'),
      previousVersion: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2_000),
    }).strict(),
    z.object({
      kind: z.literal('rollback'),
      previousVersion: z.number().int().positive(),
      rollbackOfVersion: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2_000),
    }).strict(),
  ]),
  createdAt: timestamp,
  createdBy: identifier('Version creator'),
}).strict().superRefine((version, ctx) => {
  if (version.version === 1 && version.change.kind !== 'initial') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['change'], message: 'Version 1 must be initial' });
  }
  if (version.version > 1 && version.change.kind === 'initial') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['change'], message: 'Only version 1 can be initial' });
  }
  if (version.change.kind !== 'initial' && version.change.previousVersion !== version.version - 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['change', 'previousVersion'],
      message: 'previousVersion must immediately precede the new version',
    });
  }
  if (version.change.kind === 'rollback' && version.change.rollbackOfVersion >= version.version) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['change', 'rollbackOfVersion'],
      message: 'Rollback target must be an earlier version',
    });
  }
});
export type SpecializedProfileVersion = z.infer<typeof SpecializedProfileVersionSchema>;

export const SpecializedProfileEvaluationSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier('Evaluation id'),
  profileId,
  profileVersion: z.number().int().positive(),
  stage: z.enum(SPECIALIZED_PROFILE_EVALUATION_STAGES),
  /** Exact lifecycle entry whose effective envelope was evaluated. */
  stageEntryTransitionSequence: z.number().int().positive(),
  executionRouteSha256: z.string().regex(SHA256_RE),
  capabilityEnvelopeSha256: z.string().regex(SHA256_RE),
  outcome: z.enum(['pass', 'fail', 'inconclusive']),
  runId: identifier('Evaluation run id'),
  corpus: z.object({
    id: identifier('Corpus id'),
    version: z.string().trim().min(1).max(128),
    /** True only when the host can prove separation from provenance sources. */
    heldOut: z.boolean(),
  }).strict(),
  baseline: z.object({
    kind: z.enum(['generalist', 'previous-version', 'none']),
    reference: identifier('Baseline reference'),
  }).strict(),
  /** Host-closed exhaustive population for this lifecycle entry. */
  cohort: z.object({
    id: identifier('Evaluation cohort id'),
    missionIds: z.array(identifier('Evaluation Mission id'))
      .min(SPECIALIZED_PROFILE_MIN_EVALUATION_CASES)
      .max(499),
    closedAt: timestamp,
  }).strict(),
  evaluator: z.object({
    actorId: identifier('Evaluator actor id'),
  }).strict(),
  metrics: z.object({
    caseCount: z.number().int().min(SPECIALIZED_PROFILE_MIN_EVALUATION_CASES),
    verifiedPassCount: z.number().int().nonnegative(),
    verifiedPassRate: z.number().min(0).max(1),
    falseCompletionCount: z.number().int().nonnegative(),
    policyViolationCount: z.number().int().nonnegative(),
    mutationCaseCount: z.number().int().nonnegative(),
    requiredReceiptCount: z.number().int().nonnegative(),
    completeReceiptCount: z.number().int().nonnegative(),
    humanInterventionRate: z.number().min(0).max(1),
    qualityDelta: z.number().finite().optional(),
    costDelta: z.number().finite().optional(),
  }).strict(),
  evidence: z.array(z.object({
    uri: z.string().trim().min(1).max(2_048),
    sha256: z.string().regex(SHA256_RE),
  }).strict()).min(1).max(1_000),
  startedAt: timestamp,
  completedAt: timestamp,
  validUntil: timestamp,
}).strict().superRefine((evaluation, ctx) => {
  const normalizedMissionIds = [...new Set(evaluation.cohort.missionIds)].sort();
  if (normalizedMissionIds.length !== evaluation.cohort.missionIds.length
    || normalizedMissionIds.some((id, index) => id !== evaluation.cohort.missionIds[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cohort', 'missionIds'],
      message: 'Evaluation cohort Mission ids must be unique and sorted',
    });
  }
  if (evaluation.cohort.missionIds.length !== evaluation.metrics.caseCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cohort', 'missionIds'],
      message: 'Evaluation cohort population must equal the measured case count',
    });
  }
  if (Date.parse(evaluation.cohort.closedAt) < Date.parse(evaluation.completedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cohort', 'closedAt'],
      message: 'Evaluation cohort cannot close before all cases complete',
    });
  }
  if (evaluation.metrics.verifiedPassCount > evaluation.metrics.caseCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics', 'verifiedPassCount'],
      message: 'Verified pass count cannot exceed case count',
    });
  }
  const derivedPassRate = evaluation.metrics.verifiedPassCount / evaluation.metrics.caseCount;
  if (Math.abs(derivedPassRate - evaluation.metrics.verifiedPassRate) > Number.EPSILON * 4) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics', 'verifiedPassRate'],
      message: 'Verified pass rate must equal verifiedPassCount / caseCount',
    });
  }
  if (evaluation.metrics.mutationCaseCount > evaluation.metrics.caseCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics', 'mutationCaseCount'],
      message: 'Mutation case count cannot exceed case count',
    });
  }
  if (evaluation.metrics.requiredReceiptCount < evaluation.metrics.mutationCaseCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics', 'requiredReceiptCount'],
      message: 'Every mutation case requires at least one receipt',
    });
  }
  if (evaluation.metrics.completeReceiptCount > evaluation.metrics.requiredReceiptCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics', 'completeReceiptCount'],
      message: 'Complete receipt count cannot exceed required receipt count',
    });
  }
  if (Date.parse(evaluation.completedAt) < Date.parse(evaluation.startedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completedAt'],
      message: 'Evaluation cannot complete before it starts',
    });
  }
  if (Date.parse(evaluation.validUntil) <= Date.parse(evaluation.completedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validUntil'],
      message: 'Evaluation validity must extend beyond completion',
    });
  }
});
export type SpecializedProfileEvaluation = z.infer<typeof SpecializedProfileEvaluationSchema>;

export const SpecializedProfileEvaluationCampaignSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier('Evaluation campaign id'),
  profileVersion: z.number().int().positive(),
  stage: z.enum(SPECIALIZED_PROFILE_EVALUATION_STAGES),
  stageEntryTransitionSequence: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  missionIds: z.array(identifier('Evaluation Mission id')).max(499),
  /** Host-reserved canonical case content, keyed by Mission id. Legacy absence fails closure. */
  caseFingerprints: z.record(identifier('Evaluation Mission id'), z.string().regex(SHA256_RE)).optional(),
  createdAt: timestamp,
  closedAt: timestamp.optional(),
  /** Registry revision supplied by the idempotent close request. */
  closedFromRevision: z.number().int().nonnegative().optional(),
  evaluationId: identifier('Evaluation id').optional(),
}).strict().superRefine((campaign, ctx) => {
  const normalized = [...new Set(campaign.missionIds)].sort();
  if (normalized.length !== campaign.missionIds.length
    || normalized.some((id, index) => id !== campaign.missionIds[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['missionIds'],
      message: 'Evaluation campaign Mission ids must be unique and sorted',
    });
  }
  if (campaign.caseFingerprints) {
    const cases = Object.keys(campaign.caseFingerprints).sort();
    if (cases.length !== normalized.length
      || cases.some((id, index) => id !== normalized[index])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caseFingerprints'],
        message: 'Evaluation campaign case fingerprints must exactly match its Mission population',
      });
    }
  }
  if (campaign.state === 'open' && (campaign.closedAt || campaign.closedFromRevision !== undefined || campaign.evaluationId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'Open evaluation campaign cannot be closed or evaluated',
    });
  }
  if (campaign.state === 'closed' && !campaign.closedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['closedAt'],
      message: 'Closed evaluation campaign requires a closure timestamp',
    });
  }
});
export type SpecializedProfileEvaluationCampaign = z.infer<typeof SpecializedProfileEvaluationCampaignSchema>;

export function specializedProfileEvaluationPassesPromotionGate(
  evaluation: SpecializedProfileEvaluation,
  definition: SpecializedAgentProfileDefinition | undefined,
  at: string | Date,
): boolean {
  const atMs = typeof at === 'string' ? Date.parse(at) : at.getTime();
  const mutationCapabilityRequested = definition?.requestedCapabilities.some(
    (capability) => capability.kind === 'external-mutation',
  ) ?? false;
  return evaluation.outcome === 'pass'
    && evaluation.corpus.heldOut
    && evaluation.metrics.caseCount >= SPECIALIZED_PROFILE_MIN_EVALUATION_CASES
    && evaluation.metrics.verifiedPassRate >= 0.95
    && evaluation.metrics.verifiedPassCount / evaluation.metrics.caseCount === evaluation.metrics.verifiedPassRate
    && evaluation.metrics.falseCompletionCount === 0
    && evaluation.metrics.policyViolationCount === 0
    && evaluation.metrics.completeReceiptCount === evaluation.metrics.requiredReceiptCount
    && (!mutationCapabilityRequested
      || (evaluation.metrics.mutationCaseCount > 0 && evaluation.metrics.requiredReceiptCount > 0))
    && Date.parse(evaluation.validUntil) > atMs;
}

export const SpecializedProfileHumanApprovalReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: identifier('Approval receipt id'),
  profileId,
  profileVersion: z.number().int().positive(),
  transition: z.object({
    from: SpecializedProfileStateSchema,
    to: z.enum(['opt-in', 'canary', 'default']),
  }).strict(),
  decision: z.literal('approved'),
  reviewer: z.object({
    kind: z.literal('human'),
    actorId: identifier('Human reviewer actor id'),
  }).strict(),
  authentication: z.object({
    assurance: z.enum(['webauthn', 'os-session', 'oauth-recent']),
    verifierId: identifier('Authentication verifier id'),
    eventId: identifier('Authentication event id'),
    authenticatedAt: timestamp,
  }).strict(),
  authorizationContext: z.object({
    registryRevision: z.number().int().nonnegative(),
    registryHeadSha256: z.string().regex(SHA256_RE),
    lifecycleEntryTransitionSequence: z.number().int().positive(),
    evaluationIds: z.array(identifier('Evaluation id')).max(100),
  }).strict(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  rationale: z.string().trim().min(1).max(4_000),
  evidence: z.array(z.object({
    uri: z.string().trim().min(1).max(2_048),
    sha256: z.string().regex(SHA256_RE),
  }).strict()).min(1).max(100),
}).strict().superRefine((receipt, ctx) => {
  if (Date.parse(receipt.authentication.authenticatedAt) > Date.parse(receipt.issuedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authentication', 'authenticatedAt'],
      message: 'Human authentication cannot occur after receipt issuance',
    });
  }
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Approval receipt expiry must follow issuance',
    });
  }
});
export type SpecializedProfileHumanApprovalReceipt = z.infer<typeof SpecializedProfileHumanApprovalReceiptSchema>;

export const SpecializedProfileTransitionSchema = z.object({
  sequence: z.number().int().positive(),
  profileVersion: z.number().int().positive(),
  from: SpecializedProfileStateSchema.nullable(),
  to: SpecializedProfileStateSchema,
  occurredAt: timestamp,
  actorId: identifier('Transition actor id'),
  reason: z.string().trim().min(1).max(4_000),
  evaluationIds: z.array(identifier('Evaluation id')).max(100).default([]),
  approvalReceipt: SpecializedProfileHumanApprovalReceiptSchema.optional(),
}).strict();
export type SpecializedProfileTransition = z.infer<typeof SpecializedProfileTransitionSchema>;

export const SpecializedProfileRecordSchema = z.object({
  id: profileId,
  creationRequestId: identifier('Creation request id'),
  currentVersion: z.number().int().positive(),
  currentState: SpecializedProfileStateSchema,
  versions: z.array(SpecializedProfileVersionSchema).min(1).max(1_000),
  evaluations: z.array(SpecializedProfileEvaluationSchema).max(100_000),
  evaluationCampaigns: z.array(SpecializedProfileEvaluationCampaignSchema).max(10_000).optional(),
  transitions: z.array(SpecializedProfileTransitionSchema).min(1).max(100_000),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((record, ctx) => {
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAt'], message: 'Profile update cannot precede creation' });
  }
  record.versions.forEach((version, index) => {
    if (version.profileId !== record.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versions', index, 'profileId'], message: 'Version profile id mismatch' });
    }
    if (version.version !== index + 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versions', index, 'version'], message: 'Profile versions must be contiguous' });
    }
    if (Date.parse(version.createdAt) < Date.parse(record.createdAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versions', index, 'createdAt'], message: 'Profile version cannot precede profile creation' });
    }
  });
  if (record.currentVersion !== record.versions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentVersion'], message: 'currentVersion must identify the latest version' });
  }
  const evaluationIds = new Set<string>();
  const evaluationRunIds = new Set<string>();
  const evaluationsById = new Map<string, SpecializedProfileEvaluation>();
  record.evaluations.forEach((evaluation, index) => {
    if (evaluationIds.has(evaluation.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluations', index, 'id'], message: 'Evaluation ids must be unique' });
    }
    evaluationIds.add(evaluation.id);
    evaluationsById.set(evaluation.id, evaluation);
    if (evaluationRunIds.has(evaluation.runId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluations', index, 'runId'], message: 'Evaluation run ids must be unique' });
    }
    evaluationRunIds.add(evaluation.runId);
    if (evaluation.profileId !== record.id || evaluation.profileVersion > record.currentVersion) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluations', index], message: 'Evaluation target does not exist in this profile' });
    }
    const version = record.versions[evaluation.profileVersion - 1];
    if (version && Date.parse(evaluation.startedAt) < Date.parse(version.createdAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluations', index, 'startedAt'], message: 'Evaluation cannot start before its profile version exists' });
    }
    if (version && [version.createdBy, version.provenance.proposedBy.actorId].includes(evaluation.evaluator.actorId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluations', index, 'evaluator', 'actorId'], message: 'Evaluator must be independent from the version proposer and creator' });
    }
  });
  const campaignIds = new Set<string>();
  (record.evaluationCampaigns ?? []).forEach((campaign, index) => {
    if (campaignIds.has(campaign.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluationCampaigns', index, 'id'], message: 'Evaluation campaign ids must be unique' });
    }
    campaignIds.add(campaign.id);
    const entry = record.transitions[campaign.stageEntryTransitionSequence - 1];
    if (campaign.profileVersion > record.currentVersion
      || !entry
      || entry.profileVersion !== campaign.profileVersion
      || entry.to !== SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[campaign.stage]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluationCampaigns', index], message: 'Evaluation campaign is not bound to its exact lifecycle entry' });
    }
    if (campaign.state === 'closed'
      && campaign.missionIds.length < SPECIALIZED_PROFILE_MIN_EVALUATION_CASES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluationCampaigns', index, 'missionIds'], message: 'Closed evaluation campaign has too few cases' });
    }
    if (campaign.evaluationId) {
      const evaluation = evaluationsById.get(campaign.evaluationId);
      if (!evaluation
        || evaluation.cohort.id !== campaign.id
        || evaluation.profileVersion !== campaign.profileVersion
        || evaluation.stage !== campaign.stage
        || evaluation.stageEntryTransitionSequence !== campaign.stageEntryTransitionSequence
        || evaluation.cohort.missionIds.length !== campaign.missionIds.length
        || evaluation.cohort.missionIds.some((id, missionIndex) => id !== campaign.missionIds[missionIndex])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluationCampaigns', index, 'evaluationId'], message: 'Evaluation campaign result does not match its closed population' });
      }
    }
  });
  let expectedFrom: SpecializedProfileState | null = null;
  let previousVersion = 0;
  let previousOccurredAt = Number.NEGATIVE_INFINITY;
  const approvalReceiptIds = new Set<string>();
  record.transitions.forEach((transition, index) => {
    if (transition.sequence !== index + 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'sequence'], message: 'Transition sequences must be contiguous' });
    }
    if (transition.from !== expectedFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'from'], message: 'Transition history is not contiguous' });
    }
    const version = record.versions[transition.profileVersion - 1];
    if (!version) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'profileVersion'], message: 'Transition profile version does not exist' });
    }
    if (Date.parse(transition.occurredAt) < previousOccurredAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'occurredAt'], message: 'Transition timestamps must be monotonic' });
    }
    if (version && Date.parse(transition.occurredAt) < Date.parse(version.createdAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'occurredAt'], message: 'Transition cannot precede its profile version' });
    }
    if (index > 0) {
      if (transition.profileVersion === previousVersion) {
        const allowed: readonly SpecializedProfileState[] = expectedFrom === null
          ? []
          : SPECIALIZED_PROFILE_ALLOWED_TRANSITIONS[expectedFrom];
        if (!allowed.includes(transition.to)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transitions', index, 'to'],
            message: `Transition from ${expectedFrom} to ${transition.to} is not allowed`,
          });
        }
      } else if (transition.profileVersion === previousVersion + 1) {
        if (expectedFrom === 'revoked' || transition.to !== 'draft') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transitions', index, 'to'],
            message: 'Every new version must reset a non-revoked profile to draft',
          });
        }
      } else {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transitions', index, 'profileVersion'],
          message: 'Transition history must introduce profile versions one at a time',
        });
      }
    }
    transition.evaluationIds.forEach((id) => {
      const evaluation = evaluationsById.get(id);
      if (!evaluation) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'evaluationIds'], message: `Unknown evaluation "${id}"` });
      } else if (evaluation.profileVersion !== transition.profileVersion) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'evaluationIds'], message: `Evaluation "${id}" targets another profile version` });
      } else if (Date.parse(evaluation.completedAt) > Date.parse(transition.occurredAt)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'evaluationIds'], message: `Evaluation "${id}" completed after the transition` });
      }
    });
    const receipt = transition.approvalReceipt;
    if (receipt) {
      if (approvalReceiptIds.has(receipt.receiptId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt', 'receiptId'], message: 'Approval receipt ids must be unique' });
      }
      approvalReceiptIds.add(receipt.receiptId);
      if (receipt.profileId !== record.id
        || receipt.profileVersion !== transition.profileVersion
        || receipt.transition.from !== transition.from
        || receipt.transition.to !== transition.to) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt'], message: 'Approval receipt scope must match its transition' });
      }
      if (receipt.reviewer.actorId !== transition.actorId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt', 'reviewer', 'actorId'], message: 'Approval reviewer must match the authenticated transition actor' });
      }
      if (Date.parse(receipt.issuedAt) > Date.parse(transition.occurredAt)
        || Date.parse(receipt.expiresAt) <= Date.parse(transition.occurredAt)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt'], message: 'Approval receipt must be issued and unexpired at transition time' });
      }
      if (version && [version.createdBy, version.provenance.proposedBy.actorId].includes(receipt.reviewer.actorId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt', 'reviewer', 'actorId'], message: 'Human reviewer must be independent from the version proposer and creator' });
      }
      if (record.evaluations.some((evaluation) =>
        evaluation.profileVersion === transition.profileVersion
        && evaluation.evaluator.actorId === receipt.reviewer.actorId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt', 'reviewer', 'actorId'], message: 'Human reviewer must be independent from profile evaluators' });
      }
    }
    const humanApprovalRequired = transition.from !== null
      && specializedProfileTransitionIsPromotion(transition.from, transition.to)
      && (transition.to === 'opt-in' || transition.to === 'canary' || transition.to === 'default');
    if (humanApprovalRequired && !receipt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt'], message: `Transition to ${transition.to} requires human approval` });
    }
    if (!humanApprovalRequired && receipt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt'], message: `Transition to ${transition.to} must not contain a human approval receipt` });
    }

    const requiredStage = transition.from !== null
      && specializedProfileTransitionIsPromotion(transition.from, transition.to)
      ? SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE[transition.to]
      : undefined;
    if (requiredStage) {
      const eligible = record.evaluations
        .filter((evaluation) => evaluation.profileVersion === transition.profileVersion
          && evaluation.stage === requiredStage
          && Date.parse(evaluation.completedAt) <= Date.parse(transition.occurredAt))
        .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
      const latest = eligible.at(-1);
      if (!latest || !transition.evaluationIds.includes(latest.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transitions', index, 'evaluationIds'],
          message: `Transition to ${transition.to} requires the latest ${requiredStage} evaluation`,
        });
      } else if (!specializedProfileEvaluationPassesPromotionGate(latest, version?.definition, transition.occurredAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transitions', index, 'evaluationIds'],
          message: `Evaluation "${latest.id}" does not satisfy the promotion gate`,
        });
      } else {
        const priorCertified = record.transitions
          .slice(0, index)
          .flatMap((candidate) => candidate.profileVersion === transition.profileVersion
            ? candidate.evaluationIds.flatMap((id) => {
                const evaluation = evaluationsById.get(id);
                return evaluation ? [evaluation] : [];
              })
            : []);
        if (priorCertified.some((evaluation) =>
          evaluation.executionRouteSha256 !== latest.executionRouteSha256
          || evaluation.capabilityEnvelopeSha256 !== latest.capabilityEnvelopeSha256)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transitions', index, 'evaluationIds'],
            message: 'Promotion chain must retain one certified route and capability envelope',
          });
        }
        const sourceEntry = record.transitions
          .slice(0, index)
          .filter((candidate) => candidate.profileVersion === transition.profileVersion
            && candidate.to === transition.from)
          .at(-1);
        if (!sourceEntry || latest.stageEntryTransitionSequence !== sourceEntry.sequence) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transitions', index, 'evaluationIds'],
            message: `Evaluation "${latest.id}" was pre-certified outside the current ${transition.from} stage entry`,
          });
        }
      }
    }
    expectedFrom = transition.to;
    previousVersion = transition.profileVersion;
    previousOccurredAt = Date.parse(transition.occurredAt);
  });
  record.evaluations.forEach((evaluation, index) => {
    const entry = record.transitions[evaluation.stageEntryTransitionSequence - 1];
    const expectedState = SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[evaluation.stage];
    if (!entry
      || entry.sequence !== evaluation.stageEntryTransitionSequence
      || entry.profileVersion !== evaluation.profileVersion
      || entry.to !== expectedState) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluations', index, 'stageEntryTransitionSequence'],
        message: `Evaluation stage ${evaluation.stage} must bind to the exact ${expectedState} entry transition`,
      });
      return;
    }
    if (Date.parse(evaluation.startedAt) < Date.parse(entry.occurredAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluations', index, 'startedAt'],
        message: `Evaluation stage ${evaluation.stage} cannot start before entering ${expectedState}`,
      });
    }
    const nextTransition = record.transitions[evaluation.stageEntryTransitionSequence];
    if (nextTransition && Date.parse(evaluation.completedAt) > Date.parse(nextTransition.occurredAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluations', index, 'completedAt'],
        message: `Evaluation stage ${evaluation.stage} must complete before leaving ${expectedState}`,
      });
    }
  });
  const initial = record.transitions[0];
  if (initial?.from !== null || initial?.to !== 'candidate' || initial?.profileVersion !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', 0], message: 'Profile history must begin as version 1 candidate' });
  }
  if (expectedFrom !== record.currentState) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentState'], message: 'Current state must match the final transition' });
  }
  if (record.transitions.at(-1)?.profileVersion !== record.currentVersion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentVersion'], message: 'Latest profile version must have a lifecycle transition' });
  }
});
export type SpecializedProfileRecord = z.infer<typeof SpecializedProfileRecordSchema>;

export const SpecializedProfileRegistryAuthorityAttestationSchema = z.object({
  scheme: z.literal('hmac-sha256'),
  keyId: identifier('Authority key id'),
  sha256: z.string().regex(SHA256_RE),
}).strict();
export type SpecializedProfileRegistryAuthorityAttestation = z.infer<
  typeof SpecializedProfileRegistryAuthorityAttestationSchema
>;

export const SpecializedProfileRegistryHeadSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_REGISTRY_HEAD_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  documentSha256: z.string().regex(SHA256_RE),
  previousDocumentSha256: z.string().regex(SHA256_RE).nullable(),
  authority: SpecializedProfileRegistryAuthorityAttestationSchema,
}).strict();
export type SpecializedProfileRegistryHead = z.infer<typeof SpecializedProfileRegistryHeadSchema>;

const SpecializedProfileRegistryPayloadSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_REGISTRY_SCHEMA_VERSION),
  workspaceId: identifier('Workspace id'),
  revision: z.number().int().nonnegative(),
  updatedAt: timestamp,
  updatedBy: identifier('Registry actor id'),
  profiles: z.array(SpecializedProfileRecordSchema).max(10_000),
}).strict();

export const SpecializedProfileRegistryDocumentSchema = SpecializedProfileRegistryPayloadSchema.extend({
  head: SpecializedProfileRegistryHeadSchema,
}).strict().superRefine((registry, ctx) => {
  const ids = new Set<string>();
  registry.profiles.forEach((profile, index) => {
    if (ids.has(profile.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', index, 'id'], message: 'Profile ids must be unique' });
    }
    ids.add(profile.id);
  });
  if (registry.head.revision !== registry.revision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['head', 'revision'], message: 'Registry head revision must match the document revision' });
  }
  if (registry.head.documentSha256 !== canonicalSpecializedProfileRegistryPayloadHash(registry)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['head', 'documentSha256'], message: 'Registry document digest does not match its payload' });
  }
});
export type SpecializedProfileRegistryDocument = z.infer<typeof SpecializedProfileRegistryDocumentSchema>;

export const SpecializedProfileRegistryAnchorRefSchema = z.object({
  revision: z.number().int().nonnegative(),
  documentSha256: z.string().regex(SHA256_RE),
}).strict();
export type SpecializedProfileRegistryAnchorRef = z.infer<typeof SpecializedProfileRegistryAnchorRefSchema>;

const SpecializedProfileRegistryAnchorPayloadSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_REGISTRY_ANCHOR_SCHEMA_VERSION),
  workspaceId: identifier('Workspace id'),
  committed: SpecializedProfileRegistryAnchorRefSchema.nullable(),
  pending: SpecializedProfileRegistryAnchorRefSchema.optional(),
  updatedAt: timestamp,
}).strict();

export const SpecializedProfileRegistryAnchorSchema = SpecializedProfileRegistryAnchorPayloadSchema.extend({
  authority: SpecializedProfileRegistryAuthorityAttestationSchema,
}).strict().superRefine((anchor, ctx) => {
  if (anchor.pending) {
    const expectedRevision = (anchor.committed?.revision ?? -1) + 1;
    if (anchor.pending.revision !== expectedRevision) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending', 'revision'], message: 'Pending registry anchor must immediately follow the committed head' });
    }
    if (anchor.pending.documentSha256 === anchor.committed?.documentSha256) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending', 'documentSha256'], message: 'Pending registry anchor must identify a new document' });
    }
  }
});
export type SpecializedProfileRegistryAnchor = z.infer<typeof SpecializedProfileRegistryAnchorSchema>;

export interface CreateSpecializedProfileCandidateInput {
  profileId: string;
  creationRequestId: string;
  definition: SpecializedAgentProfileDefinition;
  provenance: SpecializedProfileProvenance;
  actorId: string;
  reason: string;
}

export interface ReviseSpecializedProfileInput {
  profileId: string;
  expectedCurrentVersion: number;
  definition: SpecializedAgentProfileDefinition;
  provenance: SpecializedProfileProvenance;
  actorId: string;
  reason: string;
}

export interface TransitionSpecializedProfileInput {
  profileId: string;
  expectedCurrentVersion: number;
  to: SpecializedProfileState;
  actorId: string;
  reason: string;
  evaluationIds?: string[];
  approvalReceipt?: SpecializedProfileHumanApprovalReceipt;
}

export interface RollbackSpecializedProfileInput {
  profileId: string;
  expectedCurrentVersion: number;
  rollbackOfVersion: number;
  actorId: string;
  reason: string;
}

export function canonicalSpecializedProfileDefinitionHash(value: unknown): string {
  return sha256(canonicalJson(SpecializedAgentProfileDefinitionSchema.parse(value)));
}

export function canonicalSpecializedProfileVersionHash(value: unknown): string {
  return sha256(canonicalJson(SpecializedProfileVersionSchema.parse(value)));
}

export function canonicalSpecializedProfileRegistryPayloadHash(value: unknown): string {
  const candidate = value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'head'))
    : value;
  return sha256(canonicalJson(SpecializedProfileRegistryPayloadSchema.parse(candidate)));
}

export function canonicalSpecializedProfileRegistryAnchorPayloadHash(value: unknown): string {
  const candidate = value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'authority'))
    : value;
  const parsed = SpecializedProfileRegistryAnchorPayloadSchema.parse(candidate);
  return sha256(canonicalJson(parsed));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
