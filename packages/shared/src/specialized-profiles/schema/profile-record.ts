import { z } from "zod";
import { SpecializedProfileTransitionSchema } from './approval.ts';
import type { SpecializedProfileEvaluation } from './evaluation.ts';
import { SpecializedProfileEvaluationCampaignSchema, SpecializedProfileEvaluationSchema, specializedProfileEvaluationPassesPromotionGate } from './evaluation.ts';
import type { SpecializedProfileState } from './profile-definition.ts';
import { SPECIALIZED_PROFILE_ALLOWED_TRANSITIONS, SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE, SPECIALIZED_PROFILE_MIN_EVALUATION_CASES, SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE, SpecializedProfileStateSchema, identifier, profileId, specializedProfileTransitionIsPromotion, timestamp } from './profile-definition.ts';
import { SpecializedProfileVersionSchema } from './profile-provenance.ts';

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
