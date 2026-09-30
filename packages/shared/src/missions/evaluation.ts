import { z } from 'zod';
import { MISSION_ID_RE, MISSION_STATUSES } from './schema.ts';

const id = z.string().regex(MISSION_ID_RE);

export const MissionEvaluationFaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reject-objective'), times: z.number().int().positive() }),
  z.object({ kind: z.literal('reject-final'), times: z.number().int().positive() }),
  z.object({ kind: z.literal('transient-failure'), itemId: id, times: z.number().int().positive() }),
  z.object({ kind: z.literal('ambiguous-mutation'), itemId: id }),
  z.object({ kind: z.literal('missing-evidence'), itemId: id }),
]);

export const MissionEvaluationScenarioSchema = z.object({
  id,
  title: z.string().min(1),
  category: z.enum(['quality', 'correction', 'recovery', 'safety', 'boundedness']),
  expectedStatus: z.enum(MISSION_STATUSES),
  expectedCorrectionCycles: z.number().int().nonnegative(),
  expectedAttempts: z.record(id, z.number().int().positive()).default({}),
  maxTechnicalAttempts: z.number().int().positive().max(10).optional(),
  maxCorrectionCycles: z.number().int().nonnegative().max(10).optional(),
  recoveryPoint: z.literal('reserved-dispatch').optional(),
  faults: z.array(MissionEvaluationFaultSchema).default([]),
});

export const MissionEvaluationPromotionPolicySchema = z.object({
  minScenarioPassRate: z.number().min(0).max(1),
  minExpectedCompletionRate: z.number().min(0).max(1),
  minCorrectionConvergenceRate: z.number().min(0).max(1),
  minRecoveryFidelityRate: z.number().min(0).max(1),
  minTelemetryCoverageRate: z.number().min(0).max(1),
  maxGuardrailFailures: z.number().int().nonnegative(),
  maxFalseCompletions: z.number().int().nonnegative(),
  maxDuplicateDispatches: z.number().int().nonnegative(),
});

export const MissionEvaluationCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  promotionPolicy: MissionEvaluationPromotionPolicySchema,
  scenarios: z.array(MissionEvaluationScenarioSchema).min(1),
}).superRefine((corpus, ctx) => {
  const ids = corpus.scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenarios'], message: 'Evaluation scenario ids must be unique' });
  }
});

export type MissionEvaluationFault = z.infer<typeof MissionEvaluationFaultSchema>;
export type MissionEvaluationScenario = z.infer<typeof MissionEvaluationScenarioSchema>;
export type MissionEvaluationPromotionPolicy = z.infer<typeof MissionEvaluationPromotionPolicySchema>;
export type MissionEvaluationCorpus = z.infer<typeof MissionEvaluationCorpusSchema>;
