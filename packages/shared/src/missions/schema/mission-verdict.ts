import { z } from "zod";
import { MissionCriterionSchema, slug } from './work-items.ts';

export const CriterionVerdictSchema = z.object({
  criterionId: slug('criterion id'),
  result: z.enum(['pass', 'fail', 'inconclusive']),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  explanation: z.string().min(1),
});

export const CorrectionBriefSchema = z.object({
  correctsWorkItemId: slug('corrected work item id'),
  title: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  acceptanceCriteria: z.array(MissionCriterionSchema).min(1).optional(),
  agentProfileId: slug('agent profile id').optional(),
});

export const StructuredMissionVerdictSchema = z.object({
  targetType: z.enum(['objective', 'mission']),
  targetId: slug('verdict target id'),
  result: z.enum(['pass', 'fail', 'inconclusive']),
  summary: z.string().min(1),
  criteria: z.array(CriterionVerdictSchema).min(1),
  affectedWorkItemIds: z.array(slug('affected work item id')).default([]),
  corrections: z.array(CorrectionBriefSchema).default([]),
}).superRefine((verdict, ctx) => {
  const criterionIds = verdict.criteria.map((criterion) => criterion.criterionId);
  if (new Set(criterionIds).size !== criterionIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'Criterion verdict ids must be unique' });
  }
  if (new Set(verdict.affectedWorkItemIds).size !== verdict.affectedWorkItemIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedWorkItemIds'], message: 'Affected work item ids must be unique' });
  }
  const correctionTargets = verdict.corrections.map((correction) => correction.correctsWorkItemId);
  if (new Set(correctionTargets).size !== correctionTargets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['corrections'], message: 'Only one correction brief is allowed per affected work item' });
  }
  if (verdict.result === 'pass' && (verdict.affectedWorkItemIds.length > 0 || verdict.corrections.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedWorkItemIds'], message: 'A PASS verdict cannot request corrections' });
  }
  if (verdict.result === 'fail' && verdict.affectedWorkItemIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedWorkItemIds'], message: 'A FAIL verdict must identify affected work' });
  }
  if (verdict.result === 'pass' && verdict.criteria.some((criterion) => criterion.result !== 'pass')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'Every criterion must pass when the verdict is PASS' });
  }
  if (verdict.result === 'fail' && !verdict.criteria.some((criterion) => criterion.result === 'fail')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'A FAIL verdict must fail at least one criterion' });
  }
  if (verdict.result === 'inconclusive' && !verdict.criteria.some((criterion) => criterion.result === 'inconclusive')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'An INCONCLUSIVE verdict must mark at least one criterion inconclusive' });
  }
});

export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

export type CorrectionBrief = z.infer<typeof CorrectionBriefSchema>;

export type StructuredMissionVerdict = z.infer<typeof StructuredMissionVerdictSchema>;
