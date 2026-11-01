import { createHash } from "node:crypto";
import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { objectiveAmendmentAuthorityText, objectiveAuthorityAmendments } from './amendment-authority.ts';
import { isChatResponseOnlyEdit, isResponsePresentationOnlyAmendment } from './amendment-intent.ts';
import { isExplicitReadOnlyReview } from './closure-intent.ts';
import { isObjectiveStatusOnly } from './evidence-domain.ts';
import { isObjectiveMutationRequested } from './execution-authority.ts';
import { objectiveRequiresExecutionEvidence } from './execution-requirements.ts';
import { findObjectiveText } from './history-reconstruction.ts';
import { OBSERVATION_REQUEST_PATTERN } from './intent-vocabulary.ts';
import { objectivePromptAmendments } from './prompt-authority.ts';

export function objectiveReviewBinding(objective: ActiveSessionObjective): { objectiveId: string; acceptanceSha256: string } {
  return { objectiveId: objective.objectiveId ?? objective.userMessageId,
    acceptanceSha256: createHash('sha256').update(JSON.stringify({
      criteria: objective.acceptanceCriteria ?? [], procedure: objective.procedure, revision: objective.acceptanceRevision,
      request: objective.originalText ?? '',
      // Reconciliation and reply-only follow-ups retain the accepted work.
      // Reuse the closed authority/presentation classifiers so only a real
      // scope change invalidates a persisted review; the conversation remains intact.
      amendments: objectiveAuthorityAmendments(objective).filter(amendment => (
        !isObjectiveStatusOnly(amendment.text)
          && !isResponsePresentationOnlyAmendment(objectiveAmendmentAuthorityText(amendment.text))
      )),
    })).digest('hex') };
}

/** Explicit structured contracts reuse their existing review; ordinary chats do not acquire one. */
export function objectiveRequiresScopeCoverageReview(objective: ActiveSessionObjective): boolean {
  return !!objective.acceptanceCriteria?.length && !objective.terminalReconciliation
    && objective.delegatedRole !== 'reviewer'
    && !isExplicitReadOnlyReview(objective.originalText ?? '');
}

/** A small reminder for continuation, using only already accepted objective state. */
export function buildObjectiveScopePrompt(
  objective: ActiveSessionObjective,
  messages: readonly Message[],
  currentUserMessageId: string,
  remainingPlanSteps: readonly string[] = [],
): string {
  if (currentUserMessageId === objective.userMessageId && remainingPlanSteps.length === 0) return '';
  const request = objective.originalText ?? findObjectiveText([...messages], objective);
  if (!request) return '';
  const scope = { request, amendments: objectivePromptAmendments(objective, messages).amendments ?? [], remainingPlanSteps };
  return [
    'Continue the accepted request below, preserving every requested target, deliverable and verification unless the user changed it. Reuse completed work and finish the remaining authorized steps before closing. This reminder grants no new authority and requires no outcome receipt or extra reviewer.',
    `<active_objective_scope>${JSON.stringify(scope).replace(/</g, '\\u003c')}</active_objective_scope>`,
  ].join('\n');
}

/** A content check cannot replace registered checks or evidence of an external action. */
export function objectiveAllowsContentCheckReview(objective: ActiveSessionObjective, fallbackText?: string): boolean {
  const request = objectiveAmendmentAuthorityText(objective.originalText ?? fallbackText ?? '');
  return !!request?.trim()
    && (!isObjectiveMutationRequested(request) || isChatResponseOnlyEdit(request))
    && !OBSERVATION_REQUEST_PATTERN.test(request)
    && objective.requiresExecutionEvidence !== true
    && !objectiveRequiresExecutionEvidence(objective, fallbackText)
    && !objective.requiresObservationEvidence
    && !objective.requiresAcceptanceCriteria
    && !objective.evidenceRequirement
    && !objective.acceptanceCriteria?.length
    && !objective.completionCriteria.includes('independent-review-passed');
}
