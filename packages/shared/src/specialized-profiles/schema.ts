import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SPECIALIZED_PROFILE_REGISTRY_SCHEMA_VERSION = 1 as const;
export const SPECIALIZED_PROFILE_VERSION_SCHEMA_VERSION = 1 as const;

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
  'opt-in': ['draft', 'shadow', 'canary', 'retired', 'revoked'],
  canary: ['draft', 'opt-in', 'default', 'retired', 'revoked'],
  default: ['draft', 'canary', 'retired', 'revoked'],
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
  outcome: z.enum(['pass', 'fail', 'inconclusive']),
  runId: identifier('Evaluation run id'),
  corpus: z.object({
    id: identifier('Corpus id'),
    version: z.string().trim().min(1).max(128),
    heldOut: z.literal(true),
  }).strict(),
  baseline: z.object({
    kind: z.enum(['generalist', 'previous-version']),
    reference: identifier('Baseline reference'),
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
    assurance: z.literal('host-attested'),
    verifierId: identifier('Authentication verifier id'),
    authenticatedAt: timestamp,
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
  currentVersion: z.number().int().positive(),
  currentState: SpecializedProfileStateSchema,
  versions: z.array(SpecializedProfileVersionSchema).min(1).max(1_000),
  evaluations: z.array(SpecializedProfileEvaluationSchema).max(100_000),
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
  const evaluationsById = new Map<string, SpecializedProfileEvaluation>();
  record.evaluations.forEach((evaluation, index) => {
    if (evaluationIds.has(evaluation.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluations', index, 'id'], message: 'Evaluation ids must be unique' });
    }
    evaluationIds.add(evaluation.id);
    evaluationsById.set(evaluation.id, evaluation);
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
    const humanApprovalRequired = transition.to === 'opt-in'
      || transition.to === 'canary'
      || transition.to === 'default';
    if (humanApprovalRequired && !receipt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt'], message: `Transition to ${transition.to} requires human approval` });
    }
    if (!humanApprovalRequired && receipt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions', index, 'approvalReceipt'], message: `Transition to ${transition.to} must not contain a human approval receipt` });
    }

    const requiredStage = SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE[transition.to];
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
      }
    }
    expectedFrom = transition.to;
    previousVersion = transition.profileVersion;
    previousOccurredAt = Date.parse(transition.occurredAt);
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

const SPECIALIZED_PROFILE_CURRENT_QUALIFICATION_STAGES: Readonly<
  Partial<Record<SpecializedProfileState, readonly SpecializedProfileEvaluation['stage'][]>>
> = Object.freeze({
  shadow: ['offline'],
  'opt-in': ['offline', 'shadow'],
  canary: ['offline', 'shadow', 'opt-in'],
  default: ['offline', 'shadow', 'opt-in', 'canary'],
});

/**
 * Re-evaluate the complete qualification chain at read/runtime time. Historical
 * transition validity is insufficient because evaluation evidence expires.
 */
export function specializedProfileHasCurrentQualification(
  profile: SpecializedProfileRecord,
  at: string | Date,
): boolean {
  const requiredStages = SPECIALIZED_PROFILE_CURRENT_QUALIFICATION_STAGES[profile.currentState];
  if (!requiredStages) return true;
  const definition = profile.versions[profile.currentVersion - 1]?.definition;
  if (!definition) return false;
  return requiredStages.every((stage) => {
    const latest = profile.evaluations
      .filter((evaluation) => evaluation.profileVersion === profile.currentVersion
        && evaluation.stage === stage)
      .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt))
      .at(-1);
    return latest !== undefined
      && specializedProfileEvaluationPassesPromotionGate(latest, definition, at);
  });
}

export const SpecializedProfileRegistryDocumentSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_REGISTRY_SCHEMA_VERSION),
  workspaceId: identifier('Workspace id'),
  revision: z.number().int().nonnegative(),
  updatedAt: timestamp,
  updatedBy: identifier('Registry actor id'),
  profiles: z.array(SpecializedProfileRecordSchema).max(10_000),
}).strict().superRefine((registry, ctx) => {
  const ids = new Set<string>();
  registry.profiles.forEach((profile, index) => {
    if (ids.has(profile.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', index, 'id'], message: 'Profile ids must be unique' });
    }
    ids.add(profile.id);
  });
});
export type SpecializedProfileRegistryDocument = z.infer<typeof SpecializedProfileRegistryDocumentSchema>;

export interface CreateSpecializedProfileCandidateInput {
  profileId: string;
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
