import { z } from "zod";
import type { SpecializedAgentProfileDefinition } from './profile-definition.ts';
import { SHA256_RE, SPECIALIZED_PROFILE_EVALUATION_STAGES, SPECIALIZED_PROFILE_MIN_EVALUATION_CASES, identifier, profileId, timestamp } from './profile-definition.ts';

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
