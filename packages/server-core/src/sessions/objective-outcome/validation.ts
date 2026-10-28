import type { AutonomyEvent, Message, ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { objectiveRequiresScopeCoverageReview } from "../objective-contract.ts";
import { collectObjectiveAcceptanceEvidenceRefs, projectObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from "../objective-acceptance-criteria.ts";
import { deriveNativeQuestionOutcome, nativeQuestionCompletionRefs } from "../native-question-completion.ts";
import { addAutonomyBlockerRefs, currentAutonomyBlockerEvents } from './blocker-observations.ts';
import type { ObjectiveOutcomeValidation } from './declaration.ts';
import { HUMAN_BLOCKER_KINDS, claimsPendingHumanConfirmation, concreteRemainingWork, whollyDependentOnExternalWait } from './declaration.ts';
import { hostEvidenceRefs } from './execution-evidence.ts';
import { explicitReadOnlyAuthorityBlocker } from './read-only-authority.ts';

/** Validate model intent against host-observed evidence; declarations alone never prove completion. */
export function validateObjectiveOutcome(
  declaration: ObjectiveOutcomeDeclaration | undefined,
  options: {
    objective: ActiveSessionObjective;
    messages: Message[];
    /** Host-owned session identity used to bind spill artifacts to this transcript. */
    sessionId?: string | undefined;
    extractionError?: string | undefined;
    evidenceGap?: string | undefined;
    executionEvidenceMissing?: boolean | undefined;
    autonomyEvents?: readonly AutonomyEvent[] | undefined;
    /** True only while the host owns an unresolved structured question,
     * authentication flow or scoped permission request for this session. */
    pendingHumanConfirmation?: boolean | undefined;
    /** Legacy turns cannot safely spend another automatic attempt. Preserve
     * only an earlier host-validated continuation if it still validates now. */
    preservedContinueOnLegacyBudget?: boolean | undefined;
  },
): ObjectiveOutcomeValidation {
  const gaps: string[] = [];
  if (options.extractionError) gaps.push(options.extractionError);
  if (!declaration) {
    const prior = options.objective.lastOutcome;
    if (options.preservedContinueOnLegacyBudget && !options.extractionError
      && prior?.state === 'continue') {
      const priorValidation = validateObjectiveOutcome(prior, {
        ...options, preservedContinueOnLegacyBudget: false,
      });
      if (priorValidation.valid && priorValidation.state === 'continue') {
        return {
          state: 'continue', valid: true, gaps: [],
          effectiveDeclaration: priorValidation.effectiveDeclaration ?? prior,
          preservedFromPriorOutcome: true,
        };
      }
    }
    gaps.push('missing structured objective outcome receipt');
    return { state: 'continue', valid: false, gaps };
  }

  const acceptanceEvidenceRefs = collectObjectiveAcceptanceEvidenceRefs(
    options.objective, options.messages, declaration, options.sessionId,
  );
  const reviewNotBefore = options.objective.terminalReconciliation
      ?.initialAcceptanceRegistrationRequired === true
    ? options.objective.acceptanceRegisteredAt
    : undefined;
  const refs = hostEvidenceRefs(
    options.messages,
    options.objective,
    acceptanceEvidenceRefs,
    reviewNotBefore,
  );
  const currentAutonomyBlockers = currentAutonomyBlockerEvents(
    options.autonomyEvents ?? [], options.objective, options.messages,
  );
  addAutonomyBlockerRefs(refs.blockers, currentAutonomyBlockers);
  const derived = !options.extractionError && !options.evidenceGap && !options.executionEvidenceMissing
    && currentAutonomyBlockers.length === 0
    && Object.values(refs.blockers).every(evidence => evidence.size === 0)
    ? deriveNativeQuestionOutcome(declaration, options.objective, options.messages) : undefined;
  if (derived) declaration = derived;
  if (declaration.state === 'complete_verified') {
    for (const ref of nativeQuestionCompletionRefs(options.objective, options.messages)) refs.checks.add(ref);
  }
  const criteria = new Map<string, { satisfied: boolean; evidence: string[] }>();
  for (const criterion of declaration.criteria) {
    if (criteria.has(criterion.id)) gaps.push(`duplicate criterion: ${criterion.id}`);
    criteria.set(criterion.id, criterion);
  }

  if (declaration.state === 'continue') {
    if (declaration.blocker) gaps.push('continue requires blocker:null');
    if (declaration.remainingWork.length === 0) gaps.push('continue requires remainingWork');
    if (declaration.remainingWork.some(item => !concreteRemainingWork(item))) {
      gaps.push('continue requires concrete, non-placeholder remainingWork');
    }
    if (whollyDependentOnExternalWait(declaration.remainingWork)) {
      gaps.push('continue cannot represent a passive external wait; use blocked_human with matching host-observed blocker evidence');
    }
    if (claimsPendingHumanConfirmation(declaration.remainingWork)
      && options.pendingHumanConfirmation !== true) {
      gaps.push('remainingWork claims a pending human confirmation, but no structured question, authentication flow, or permission request is pending');
    }
    const acceptanceCriterionIds = new Set(projectObjectiveAcceptanceCriteria(
      options.objective, options.messages,
    ).criteria.map(criterion => criterion.id));
    const knownCriterionIds = new Set([
      ...options.objective.completionCriteria,
      ...acceptanceCriterionIds,
    ]);
    for (const criterion of declaration.criteria) {
      if (!knownCriterionIds.has(criterion.id)) {
        gaps.push(`unknown criterion: ${criterion.id}`);
        continue;
      }
      if (!criterion.satisfied) continue;
      if (criterion.id === 'no-safe-work-remaining') {
        // `continue` and concrete remaining work are authoritative. Models
        // occasionally copy the terminal criterion template unchanged; retain
        // the checkpoint without turning that contradiction into a costly
        // retry or persisting a false terminal claim.
        continue;
      }
      if (acceptanceCriterionIds.has(criterion.id)) {
        const matched = collectObjectiveAcceptanceEvidenceRefs(options.objective, options.messages, {
          ...declaration, criteria: [criterion],
        }, options.sessionId);
        if (matched.size === 0) gaps.push(`criterion lacks observed evidence: ${criterion.id}`);
        continue;
      }
      const allowedRefs = criterion.id === 'independent-review-passed'
        ? refs.review
        : criterion.id === 'relevant-checks-passed'
          ? refs.checks
          : refs.successful;
      if (!criterion.evidence.some(ref => allowedRefs.has(ref))) {
        gaps.push(`criterion lacks observed evidence: ${criterion.id}`);
      }
    }
    // A concrete `continue` receipt is an in-progress checkpoint, not a claim
    // that the requested mutation already happened. Requiring execution proof
    // here rejects the very first honest checkpoint before the remaining work
    // can run. The pre-tool gate still enforces authoritative evidence before
    // any mutation, while every criterion claimed by this checkpoint remains
    // host-validated above. A missing or failing independent review is likewise
    // actionable remaining work, not a reason to reject the continuation that
    // will correct its findings. Evidence and execution proof remain mandatory
    // for complete_verified below.
    const copiedTerminalCriterion = declaration.criteria.some(criterion => (
      criterion.id === 'no-safe-work-remaining' && (criterion.satisfied || criterion.evidence.length > 0)
    ));
    const effectiveDeclaration: ObjectiveOutcomeDeclaration | undefined = copiedTerminalCriterion
      ? {
        ...declaration,
        criteria: declaration.criteria.map(criterion => criterion.id === 'no-safe-work-remaining'
          ? { ...criterion, satisfied: false, evidence: [] }
          : { ...criterion, evidence: [...criterion.evidence] }),
        remainingWork: [...declaration.remainingWork],
        blocker: null,
      }
      : undefined;
    return {
      state: 'continue', valid: gaps.length === 0, gaps,
      ...(gaps.length === 0 && effectiveDeclaration ? { effectiveDeclaration } : {}),
    };
  }

  if (declaration.state === 'blocked_human' || declaration.state === 'blocked_policy') {
    if (!declaration.blocker) {
      gaps.push(`${declaration.state} requires a blocker receipt`);
    } else {
      const kindValid = declaration.state === 'blocked_policy'
        ? declaration.blocker.kind === 'policy'
        : HUMAN_BLOCKER_KINDS.has(declaration.blocker.kind);
      if (!kindValid) gaps.push(`invalid blocker kind for ${declaration.state}`);
      const observedBlockerRefs = refs.blockers[declaration.blocker.kind];
      const readOnlyAuthority = kindValid && explicitReadOnlyAuthorityBlocker(
        declaration, options.objective, options.messages, options.sessionId,
      );
      if (!declaration.blocker.evidence.some(ref => observedBlockerRefs.has(ref))
        && !readOnlyAuthority) {
        gaps.push('blocker evidence does not reference a matching host-observed blocker');
      }
    }
    return { state: gaps.length === 0 ? declaration.state : 'continue', valid: gaps.length === 0, gaps };
  }

  if (declaration.blocker) gaps.push('complete_verified cannot include a blocker');
  gaps.push(...validateObjectiveAcceptanceCriteria(
    options.objective, options.messages, declaration, options.sessionId,
  ));
  if (declaration.remainingWork.length > 0) gaps.push('complete_verified cannot include remainingWork');
  for (const expected of options.objective.completionCriteria) {
    const receipt = criteria.get(expected);
    if (!receipt) {
      gaps.push(`missing criterion: ${expected}`);
      continue;
    }
    if (!receipt.satisfied) gaps.push(`unsatisfied criterion: ${expected}`);
    const scopeReviewRequired = expected === 'requested-outcome-delivered'
      && objectiveRequiresScopeCoverageReview(options.objective)
      && nativeQuestionCompletionRefs(options.objective, options.messages).size !== 4;
    if (scopeReviewRequired && refs.review.size === 0) {
      gaps.push('Full-request coverage requires the current independent review, not only a successful registered observation');
    }
    const allowedRefs = expected === 'independent-review-passed'
      ? refs.review
      : expected === 'relevant-checks-passed'
        ? refs.checks
        : refs.successful;
    if (!receipt.evidence.some(ref => allowedRefs.has(ref))) {
      gaps.push(`criterion lacks observed evidence: ${expected}`);
      if (expected === 'relevant-checks-passed') {
        const missing = [...new Set(receipt.evidence.flatMap(ref => refs.incompleteCheckReviews.get(ref) ?? []))];
        if (missing.length > 0) {
          gaps.push(`Cited review receipt is missing exact host criterion IDs: ${missing.join(', ')}. Review the existing deliverable and return those IDs; do not repeat its external actions.`);
        }
      }
    }
  }
  if (options.evidenceGap) gaps.push(options.evidenceGap);
  if (options.executionEvidenceMissing) gaps.push('required execution evidence is missing');
  return { state: gaps.length === 0 ? 'complete_verified' : 'continue', valid: gaps.length === 0, gaps,
    ...(gaps.length === 0 && derived ? { declaration: derived } : {}) };
}
