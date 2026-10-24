import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { detectHighStakesEvidenceDomain, isConcreteOperationalSoftwareRestatement, isOperationalTechnicalContractLifecycleObjective } from "@craft-agent/shared/agent";
import { objectiveAmendmentAuthorityText } from './amendment-authority.ts';
import { isTerseContextualRepairAmendment, looksLikeContinuation, retainedObjectiveEvidenceDomain } from './amendment-history.ts';
import { amendmentEvidenceRequests, isBareObjectiveContinuation, isChatResponseOnlyEdit, isResponsePresentationOnlyAmendment } from './amendment-intent.ts';
import { isExplicitReadOnlyClosureRequest, isExplicitReadOnlyReview } from './closure-intent.ts';
import { canCorrectLegacyMedicalFalsePositive, canCorrectLegacyTechnicalLegalFalsePositive, isObjectiveStatusOnly, latestExplicitAuditEvidenceDomain, reclassifiedHighStakesClarification, reclassifiedPersistedHighStakesObjective, startsExplicitNewObjective } from './evidence-domain.ts';
import { classifyAuthorizedObjectiveEvidenceDomain, classifyObjectiveRequest, objectiveRiskContext } from './execution-authority.ts';
import { objectiveRequiresExecutionEvidence } from './execution-requirements.ts';
import { explicitlyRevokesExecutionAuthority, latestClauseRequestsExecution } from './execution-revocation.ts';
import { MULTI_STEP_PATTERN, OBSERVATION_REQUEST_PATTERN, isExecutionChannelCorrection, isPrecisionOrCompletenessChallenge } from './intent-vocabulary.ts';
import { isExplicitQuestionAnswerOnlyRequest } from './question-answer-authority.ts';
import { hasExplicitTerminalContractMutation } from './terminal-contract-mutation.ts';
import type { ObjectiveTransitionInput } from './types.ts';

export function transitionObjectiveContract(input: ObjectiveTransitionInput): ActiveSessionObjective {
  const nowMs = input.nowMs ?? Date.now();
  const authorityText = objectiveAmendmentAuthorityText(input.text);
  const readOnlyClosure = isExplicitReadOnlyClosureRequest(input.text);
  const terseContextualRepair = isTerseContextualRepairAmendment(input.text);
  const executionChannelCorrection = isExecutionChannelCorrection(input.text);
  const terminalReconciliation = !!input.existing && readOnlyClosure
    && !startsExplicitNewObjective(input.text);
  if (input.existing && terminalReconciliation) {
    const alreadyRecorded = input.existing.amendments?.some(amendment => (
      amendment.messageId === input.messageId
    ));
    // This is the same objective and the same host-owned contract. The user
    // turn constrains how its terminal state is reconciled; it does not become
    // an acceptance revision, target change, payload change or new authority.
    return {
      ...input.existing,
      terminalReconciliation: {
        messageId: input.messageId,
        // Once the host grants the one-time initial-registration capability,
        // its timestamp is the immutable lower bound for both registration and
        // the optional review. Repeating the same closure after registration
        // must not move that bound past acceptanceRegisteredAt and deadlock it.
        timestamp: input.existing.terminalReconciliation
          ?.initialAcceptanceRegistrationRequired === true
          ? input.existing.terminalReconciliation.timestamp : nowMs,
        ...(input.existing.terminalReconciliation?.initialAcceptanceRegistrationRequired
          || input.existing.requiresAcceptanceCriteria === true
            && (!input.existing.acceptanceCriteria?.length || input.existing.acceptanceNeedsReview === true)
          ? { initialAcceptanceRegistrationRequired: true as const } : {}),
      },
      lastUserMessageId: input.messageId,
      continuationCount: input.existing.continuationCount + 1,
      terminalState: 'active',
      completedAt: undefined,
      lastOutcome: undefined,
      interruptedTurnRecovery: undefined,
      amendments: input.text.trim() && !alreadyRecorded
        ? [...(input.existing.amendments ?? []), {
            messageId: input.messageId, text: input.text, timestamp: nowMs,
          }]
        : input.existing.amendments,
    };
  }
  const preserveExisting = input.existing
    && !startsExplicitNewObjective(input.text)
    // A valid reconciliation returned above with its current contract intact.
    // If review is unresolved, keep the objective fail-closed here instead of
    // silently creating a criteria-free reporting objective.
    // While work is active, user feedback steers that work unless the user
    // explicitly changes the mission. Replacing the root on an unrecognized
    // clarification loses its acceptance checks, evidence and budget baseline.
    && (input.existing.terminalState === 'active'
      || looksLikeContinuation(input.text)
        && (input.existing.terminalState !== 'complete_verified'
          || !terseContextualRepair && !executionChannelCorrection));
  if (input.existing && preserveExisting) {
    const substantiveAmendment = !!input.text.trim() && !isBareObjectiveContinuation(input.text)
      && !isObjectiveStatusOnly(input.text)
      && input.messageId !== input.existing.lastUserMessageId
      && !input.existing.amendments?.some(item => item.messageId === input.messageId);
    const presentationOnlyAmendment = substantiveAmendment
      && isResponsePresentationOnlyAmendment(input.text)
      // The presentation recognizer is intentionally conversational, but a
      // trailing send/retarget instruction changes the protected target. A
      // terminal lock must fail closed rather than preserve itself here.
      && !hasExplicitTerminalContractMutation(authorityText);
    // Preserving the root must not preserve a response-only completion shortcut
    // when an accepted amendment now asks for artifacts or observations. Reuse
    // the normal request classifier, but promote only evidence obligations;
    // identity, accounting, execution permissions and model settings stay put.
    const amendment = substantiveAmendment ? transitionObjectiveContract({
      messageId: input.messageId, text: authorityText, delegatedRole: input.existing.delegatedRole,
      nowMs,
    }) : undefined;
    // Terse amendments such as "fix the reported issues" own their mutation
    // authority but inherit only the referenced domain from the accepted root.
    // Historical imperative wording therefore cannot become a fresh command,
    // while RBAC/credential/production findings still keep their safety tier.
    const contextualAmendment = substantiveAmendment
      ? classifyObjectiveRequest(authorityText, objectiveRiskContext(input.existing))
      : undefined;
    const requestedEvidence = substantiveAmendment
      ? amendmentEvidenceRequests(authorityText, input.existing.delegatedRole)
      : undefined;
    if (requestedEvidence && latestClauseRequestsExecution(authorityText, input.existing.delegatedRole)) {
      requestedEvidence.execution = true;
    }
    // Once a terminal no-effect boundary exists, conversational acknowledgments
    // and unclassified prose cannot silently reopen the old mutation. Only a
    // positively classified execution/observation instruction (or an explicit
    // new objective handled above) may replace the terminal contract.
    const terminalAuthorityAmendment = requestedEvidence?.execution === true
      || requestedEvidence?.observation === true
      || isPrecisionOrCompletenessChallenge(input.text)
      || hasExplicitTerminalContractMutation(authorityText);
    const acceptanceRelevantAmendment = substantiveAmendment
      && !presentationOnlyAmendment
      && (!input.existing.terminalReconciliation || terminalAuthorityAmendment);
    const executionAuthorityRevoked = substantiveAmendment
      && explicitlyRevokesExecutionAuthority(authorityText);
    const requiresExecutionEvidence = !executionAuthorityRevoked
      && (objectiveRequiresExecutionEvidence(input.existing) || requestedEvidence?.execution);
    const requiresObservationEvidence = input.existing.requiresObservationEvidence || requestedEvidence?.observation;
    const requiresAcceptanceCriteria = input.existing.requiresAcceptanceCriteria || requiresExecutionEvidence || requiresObservationEvidence;
    const clarificationHighStakes = reclassifiedHighStakesClarification(
      input.existing,
      authorityText,
      substantiveAmendment,
    );
    const persistedHighStakes = substantiveAmendment
      ? undefined
      : reclassifiedPersistedHighStakesObjective(input.existing);
    const candidateEvidenceDomain = persistedHighStakes !== undefined
      ? persistedHighStakes.evidenceDomain
      : clarificationHighStakes !== undefined
        ? clarificationHighStakes.evidenceDomain
      : (substantiveAmendment
        ? classifyAuthorizedObjectiveEvidenceDomain(authorityText)
          ?? (requestedEvidence?.execution
            ? latestExplicitAuditEvidenceDomain(input.existing)
            : retainedObjectiveEvidenceDomain(input.existing))
        : retainedObjectiveEvidenceDomain(input.existing));
    const correctsLegacyMedicalFalsePositive = canCorrectLegacyMedicalFalsePositive(
      input.existing,
      authorityText,
      substantiveAmendment,
    );
    const correctsLegacyTechnicalLegalFalsePositive = canCorrectLegacyTechnicalLegalFalsePositive(
      input.existing,
      authorityText,
      substantiveAmendment,
    );
    const correctsLegacyEvidenceFalsePositive = correctsLegacyMedicalFalsePositive
      || correctsLegacyTechnicalLegalFalsePositive;
    const currentOperationalRestatement = substantiveAmendment
      && (isConcreteOperationalSoftwareRestatement(objectiveAmendmentAuthorityText(input.text))
        || isOperationalTechnicalContractLifecycleObjective(objectiveAmendmentAuthorityText(input.text)))
      && classifyAuthorizedObjectiveEvidenceDomain(objectiveAmendmentAuthorityText(input.text)) === undefined
      && detectHighStakesEvidenceDomain(objectiveAmendmentAuthorityText(input.text)) === undefined;
    const amendmentCarriesHighStakesRisk = amendment?.risk === 'high-stakes'
      // A complete, current operational restatement owns its own subject.
      // Contextual classification still sees the historical journal and can
      // otherwise recreate the obsolete legal/medical label that the bounded
      // migration below just disproved. Genuine historical high-stakes work is
      // preserved separately because `correctsLegacyEvidenceFalsePositive`
      // remains false for a real legal, clinical or security segment.
      || contextualAmendment?.highRisk === true && !currentOperationalRestatement
      || clarificationHighStakes !== undefined
      || persistedHighStakes !== undefined;
    // The explicit correction may itself mention a missing secret or medical
    // source while saying those are not the task. Do not replace the stale
    // medical domain with another mention-only domain unless the amendment's
    // scoped mutation classifier independently establishes high stakes.
    const evidenceDomain = correctsLegacyEvidenceFalsePositive && !amendmentCarriesHighStakesRisk
      ? undefined
      : candidateEvidenceDomain;
    // A deictic correction ("fix the findings") inherits the latest audited
    // sensitive subject. The earlier read-only audit did not grant mutation
    // authority; this explicit correction does, and must now receive the same
    // high-stakes source/review protections as a fully restated request.
    const amendmentHighStakes = amendmentCarriesHighStakesRisk
      || requestedEvidence?.execution === true && !!evidenceDomain;
    const highStakes = amendmentHighStakes
      || input.existing.risk === 'high-stakes' && !correctsLegacyEvidenceFalsePositive;
    const evidenceRequired = highStakes && requiresExecutionEvidence && !!evidenceDomain;
    const mission = input.existing.orchestrationMode === 'mission'
      || amendment?.orchestrationMode === 'mission'
      || amendmentHighStakes;
    const existingTerminalReview = input.existing.delegatedRole === 'reviewer'
      || !requiresExecutionEvidence
        && !!input.existing.originalText
        && isExplicitReadOnlyReview(objectiveAmendmentAuthorityText(input.existing.originalText));
    const completionCriteria = existingTerminalReview
      ? input.existing.completionCriteria.filter(criterion => criterion !== 'independent-review-passed')
      : !highStakes && correctsLegacyEvidenceFalsePositive
      ? input.existing.completionCriteria.filter(criterion => criterion !== 'independent-review-passed')
      : amendmentHighStakes && input.existing.delegatedRole !== 'reviewer'
          && !input.existing.completionCriteria.includes('independent-review-passed')
        ? [...input.existing.completionCriteria, 'independent-review-passed' as const]
        : input.existing.completionCriteria;
    const continued: ActiveSessionObjective = {
      ...input.existing,
      ...(requiresExecutionEvidence ? { requiresExecutionEvidence: true } : {}),
      ...(requiresObservationEvidence ? { requiresObservationEvidence: true } : {}),
      ...(requiresAcceptanceCriteria ? { requiresAcceptanceCriteria: true } : {}),
      ...(evidenceDomain ? { evidenceDomain } : {}),
      ...(!input.existing.evidenceRequirement && evidenceRequired
        ? { evidenceRequirement: 'authoritative-sources-before-mutation' as const } : {}),
      risk: highStakes ? 'high-stakes' : 'standard',
      completionCriteria,
      ...(mission ? { orchestrationMode: 'mission' as const } : {}),
      // A new accepted message supersedes the stopped turn's Retry anchor.
      interruptedTurnRecovery: undefined,
      // A substantive non-reconciliation amendment supersedes the dedicated
      // terminal mode. Historical reconciliation prompts remain excluded from
      // authority by objectiveAuthorityAmendments.
      terminalReconciliation: acceptanceRelevantAmendment
        ? undefined : input.existing.terminalReconciliation,
      ...(acceptanceRelevantAmendment && (input.existing.acceptanceCriteria?.length || isPrecisionOrCompletenessChallenge(input.text)) ? {
        acceptanceRevision: input.messageId, acceptanceNeedsReview: true,
      } : {}),
      objectiveId: input.existing.objectiveId ?? input.existing.userMessageId,
      lastUserMessageId: input.messageId,
      continuationCount: input.existing.continuationCount + 1,
      terminalState: 'active',
      completedAt: undefined,
      lastOutcome: undefined,
      amendments: input.text.trim() && !isBareObjectiveContinuation(input.text)
        && !input.existing.amendments?.some(amendment => amendment.messageId === input.messageId)
        ? [...(input.existing.amendments ?? []), { messageId: input.messageId, text: input.text, timestamp: nowMs }]
        : input.existing.amendments,
    };
    // Normalize legacy false positives while the objective is already being
    // persisted for a new turn. Keeping the stale raw flag would make callers
    // that have not yet adopted objectiveRequiresExecutionEvidence disagree.
    if (!requiresExecutionEvidence) {
      delete continued.requiresExecutionEvidence;
    }
    if (!evidenceRequired) {
      delete continued.evidenceRequirement;
    }
    if (!evidenceDomain) {
      delete continued.evidenceDomain;
    }
    return continued;
  }

  const requestClassification = classifyObjectiveRequest(authorityText);
  // The broad router treats the standalone noun “santé” as medical. In a
  // fully restated software recovery mission with a concrete host/path,
  // service action and technical verification, the narrower evidence-domain
  // classifier has already proved that no legal, medical, financial or
  // security subject remains after neutralizing only operational health.
  const concreteOperationalSoftware = isConcreteOperationalSoftwareRestatement(authorityText);
  const highStakes = !readOnlyClosure && requestClassification.highRisk && !concreteOperationalSoftware;
  const readOnlyReview = input.delegatedRole === 'reviewer' || isExplicitReadOnlyReview(authorityText);
  const questionAnswerOnly = isExplicitQuestionAnswerOnlyRequest(authorityText);
  const requiresExecutionEvidence = !readOnlyClosure && (requestClassification.mutationRequested
      || latestClauseRequestsExecution(authorityText, input.delegatedRole))
    && !explicitlyRevokesExecutionAuthority(authorityText)
    && !readOnlyReview && !questionAnswerOnly && !isChatResponseOnlyEdit(authorityText);
  const requiresObservationEvidence = !readOnlyClosure && !questionAnswerOnly
    && (OBSERVATION_REQUEST_PATTERN.test(authorityText) || readOnlyReview);
  // A read-only audit may establish the subject of a later deictic correction,
  // but never mutation authority. The separate requirement below is created
  // only when this same objective actually requests execution.
  const evidenceDomain = readOnlyClosure ? undefined : detectHighStakesEvidenceDomain(authorityText);
  const mission = !readOnlyClosure && !questionAnswerOnly
    && (highStakes || MULTI_STEP_PATTERN.test(authorityText));
  const completionCriteria: ActiveSessionObjective['completionCriteria'] = [
    'requested-outcome-delivered',
    'relevant-checks-passed',
    'no-safe-work-remaining',
  ];
  // An explicit independent read-only review is already the terminal reviewer.
  // Requiring a review of that review creates an unbounded reviewer chain.
  if (highStakes && !readOnlyReview && input.delegatedRole !== 'reviewer') {
    completionCriteria.push('independent-review-passed');
  }

  return {
    schemaVersion: 1,
    originalText: input.text,
    ...(input.delegatedRole ? { delegatedRole: input.delegatedRole } : {}),
    ...(requiresExecutionEvidence || requiresObservationEvidence ? { requiresAcceptanceCriteria: true } : {}),
    ...(requiresObservationEvidence ? { requiresObservationEvidence: true } : {}),
    objectiveId: input.messageId,
    userMessageId: input.messageId,
    lastUserMessageId: input.messageId,
    startedAt: nowMs,
    budgetBaselineUsd: Math.max(0, input.lifetimeCostUsd ?? 0),
    tokenBaseline: Math.max(0, input.lifetimeTokens ?? 0),
    continuationCount: 0,
    orchestrationMode: mission ? 'mission' : 'direct',
    risk: highStakes ? 'high-stakes' : 'standard',
    ...(requiresExecutionEvidence ? { requiresExecutionEvidence: true } : {}),
    ...(evidenceDomain ? { evidenceDomain } : {}),
    ...(highStakes && requiresExecutionEvidence && evidenceDomain
      ? { evidenceRequirement: 'authoritative-sources-before-mutation' as const }
      : {}),
    completionCriteria,
    // A fresh informational closure has no earlier contract to recover, but it
    // still carries the same no-effect host lock. A later substantive user
    // amendment clears this marker through the ordinary amendment path.
    ...(readOnlyClosure ? { terminalReconciliation: {
      messageId: input.messageId,
      timestamp: nowMs,
    } } : {}),
    terminalState: 'active',
  };
}
