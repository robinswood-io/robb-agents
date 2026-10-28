import { isJsonObject, isUnknownArray } from '@craft-agent/shared/utils/json';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { inspectReadOnlyReviewCommand } from "@craft-agent/shared/agent/bash-validator";
import { isObjectiveEvidenceInvalidatingMutation } from "../objective-contract.ts";
import { collectObjectiveAcceptanceObservations } from "../objective-acceptance-criteria.ts";
import type { DelegatedReviewValidation } from './host-scope.ts';
import { COORDINATION, LOCAL_REVIEW_SHELL_TOOLS } from './host-scope.ts';
import { criterionInvocationMatches, isBoundReadOnlyHostTargetCheck, isExplicitHostPolicyRefusal, isShellTool, observationalTool, observedRevision, reviewCommand, shellCommand } from './review-observations.ts';
import { getDelegatedReviewRequest } from './review-request.ts';

/**
 * A delegated review can be delivered with a negative verdict. This host
 * attestation is deliberately separate from the parent's PASS-only gate.
 * No saved objective/criterion, result, authorization or visible JSON is changed.
 */
export function validateDelegatedReviewCompletion(input: {
  parentSessionId?: string | undefined;
  sessionId?: string | undefined;
  objective: ActiveSessionObjective;
  messages: Message[];
  sourceSlugs?: readonly string[] | undefined;
  finalMessage?: Message | undefined;
}): DelegatedReviewValidation | undefined {
  if (!input.parentSessionId || !input.objective.originalText) return undefined;
  const request = getDelegatedReviewRequest(
    input.objective.originalText,
    input.sourceSlugs,
    input.objective.delegatedRole,
  );
  if (!request) return undefined;
  const reject = (gap: string): DelegatedReviewValidation => ({ valid: false, state: 'continue', gaps: [gap] });
  const final = input.finalMessage;
  const roots = input.messages.filter(message => message.id === input.objective.userMessageId);
  const root = roots.length === 1 ? roots[0] : undefined;
  const rootIndex = root ? input.messages.indexOf(root) : -1;
  const finalIndex = final ? input.messages.findIndex(message => message.id === final.id) : -1;
  if (!final || final.role !== 'assistant' || final.isIntermediate || rootIndex < 0 || finalIndex <= rootIndex) return reject('The delegated review needs a final response in its own objective transcript');
  if (request.hostBound && (input.objective.delegatedRole !== 'reviewer'
    || root!.role !== 'user' || root!.hidden || root!.isQueued || root!.isPending
    || root!.internalOrigin?.kind !== 'spawned-session'
    || root!.internalOrigin.senderSessionId !== input.parentSessionId
    || root!.content !== input.objective.originalText)) return reject('The host review contract needs its authenticated root and delegating parent');
  const content = final.content.trim();
  if (content.length > 32_000) return reject('The delegated review receipt exceeds the size limit');
  let receipt: unknown;
  try { receipt = JSON.parse(content); } catch { return reject('Return the single requested review JSON object, without a second receipt or surrounding prose'); }
  if (!isJsonObject(receipt) || (receipt['verdict'] !== 'PASS' && receipt['verdict'] !== 'FAIL')
    || receipt['objectiveId'] !== request.objectiveId || receipt['acceptanceSha256'] !== request.acceptanceSha256) return reject('The review verdict must retain the exact binding from the original delegated request');
  const criteria = receipt['criteria'];
  if (!isUnknownArray(criteria) || criteria.length !== request.criteria.length
    || !criteria.every((item): item is { id: string; passed: boolean } => isJsonObject(item)
      && typeof item['id'] === 'string' && typeof item['passed'] === 'boolean')
    || new Set(criteria.map(item => item.id)).size !== request.criteria.length
    || request.criteria.some(id => !criteria.some(item => item.id === id))) return reject('The review must report every requested criterion exactly once');
  const findings = receipt['findings'];
  if (!isUnknownArray(findings) || findings.length > 64
    || !findings.every((item): item is string => typeof item === 'string' && !!item.trim() && item.length <= 4_000
      && !/^<.*>$/.test(item.trim())
      && !/replace this example|example[_ -]?only/i.test(item))) return reject('Review findings must be bounded, concrete text rather than an example placeholder');
  if (receipt['verdict'] === 'PASS' ? findings.length > 0 || criteria.some(item => !item.passed)
    : findings.length === 0) return reject('The review verdict, criterion results and findings must agree');
  const scoped = input.messages.slice(rootIndex + 1, finalIndex);
  if (scoped.some(message => message.role === 'tool' && message.toolExecuted !== false && !COORDINATION.test(message.toolName ?? '')
    && !isExplicitHostPolicyRefusal(message)
    && isObjectiveEvidenceInvalidatingMutation(message)
    && !request.targetChecks?.some(criterion => criterionInvocationMatches(criterion, message)
      && isBoundReadOnlyHostTargetCheck(criterion, message)))) {
    return reject('A review with a target mutation requires the normal objective validation');
  }
  if (scoped.some(message => {
    if (message.role !== 'tool' || message.toolExecuted === false || message.toolCheckpoint !== undefined || COORDINATION.test(message.toolName ?? '')
      || isExplicitHostPolicyRefusal(message)) return false;
    const command = shellCommand(message);
    if (command === undefined) return false;
    if (request.targetChecks) {
      if (!isShellTool(message)) return false;
      const targetCheck = request.targetChecks.find(criterion => criterionInvocationMatches(criterion, message));
      if (targetCheck) return !isBoundReadOnlyHostTargetCheck(targetCheck, message);
      return !(LOCAL_REVIEW_SHELL_TOOLS.has(message.toolName ?? '')
        && inspectReadOnlyReviewCommand(
          command,
          '/',
          typeof message.toolInput?.["cwd"] === 'string' ? message.toolInput["cwd"] : undefined,
        ).safe);
    }
    return !reviewCommand(message, request).safe;
  })) return reject('An opaque or mutating shell command requires normal objective validation');
  // The final host envelope is already authenticated by the exact spawned root
  // above. Evaluate its immutable checks directly rather than asking the child
  // model to duplicate them with set_completion_criteria. Child registration
  // metadata is neither authority nor a prerequisite for these observations.
  const evidenceObjective = request.targetChecks ? omitUndefined<ActiveSessionObjective>({
    ...input.objective,
    acceptanceCriteria: structuredClone(request.targetChecks),
    acceptanceNeedsReview: false,
    acceptanceRevision: undefined,
    acceptanceRegisteredRevision: undefined,
    acceptanceRegisteredAt: input.objective.startedAt,
    acceptanceRegisteredAtById: Object.fromEntries(request.targetChecks.map(check => [
      check.id,
      input.objective.startedAt,
    ])),
  }) : input.objective;
  const observations = collectObjectiveAcceptanceObservations(
    evidenceObjective, input.messages.slice(0, finalIndex), input.sessionId,
  )
    .filter(({ criterionId, message }) => request.targetChecks
      ? request.targetChecks.some(criterion => criterion.id === criterionId
        && isBoundReadOnlyHostTargetCheck(criterion, message))
      : observationalTool(message, request));
  if (!observations.length && !(receipt['verdict'] === 'FAIL' && request.targetChecks?.length)) {
    return reject('The review needs an observed invocation of a registered check on the requested target');
  }
  const expectedObservationCount = request.targetChecks?.length ?? input.objective.acceptanceCriteria?.length;
  if (receipt['verdict'] === 'PASS' && (observations.length !== expectedObservationCount || observations.some(item => !item.passed))) return reject('A passing review cannot certify a failed or unobserved registered check');
  const failedTargetEvidence: Message[] = [];
  if (receipt['verdict'] === 'FAIL' && request.targetChecks) {
    const observationById = new Map(observations.map(observation => [observation.criterionId, observation]));
    let observedTargetFailure = false;
    for (const targetCheck of request.targetChecks) {
      const reported = criteria.find(item => item.id === targetCheck.id)!;
      const observation = observationById.get(targetCheck.id);
      if (reported.passed) {
        if (!observation?.passed) return reject(`The review marks ${targetCheck.id} passed without a matching positive host observation`);
        continue;
      }
      if (observation && !observation.passed) {
        observedTargetFailure = true;
        continue;
      }
      // A failed exact invocation can substantiate that this review check was
      // unavailable. It cannot overturn an already positive business result.
      const failedAttempts = scoped.filter(message => criterionInvocationMatches(targetCheck, message)
        && message.role === 'tool' && message.toolExecuted !== false && message.toolCheckpoint === undefined
        && (message.toolStatus === 'error' || message.isError) && !!message.toolResult?.trim()
        && input.messages.filter(candidate => candidate.id === message.id).length === 1
        && (!message.toolUseId || input.messages.filter(candidate => candidate.toolUseId === message.toolUseId).length === 1));
      if (observation?.passed || !failedAttempts.length) {
        return reject(`The review marks ${targetCheck.id} failed without a matching negative result or failed exact invocation`);
      }
      failedTargetEvidence.push(...failedAttempts);
      observedTargetFailure = true;
    }
    if (!observedTargetFailure) return reject('A failing review needs at least one host-observed target failure');
  }
  if (request.revision && !request.targetChecks) {
    const revisions = observations.map(item => observedRevision(item.message, request)).filter((value): value is string => !!value);
    const observedExpected = revisions.some(value => value.startsWith(request.revision!.toLowerCase()));
    // A changed HEAD is a valid negative audit result, never proof that the
    // expected commit was reviewed. Require the observed revision in findings.
    const reportedMismatch = receipt['verdict'] === 'FAIL' && revisions.some(value => !value.startsWith(request.revision!.toLowerCase())
      && findings.some(finding => finding.toLowerCase().includes(value)));
    if (!observedExpected && !reportedMismatch) return reject('The requested revision must be observed, or its observed mismatch explicitly reported as FAIL');
  }
  const evidence = [...new Set([
    ...observations.flatMap(item => [item.message.id, ...(item.message.toolUseId ? [item.message.toolUseId] : [])]),
    ...failedTargetEvidence.flatMap(message => [message.id, ...(message.toolUseId ? [message.toolUseId] : [])]),
  ])];
  return { valid: true, state: 'complete_verified', gaps: [], declaration: {
    state: 'complete_verified', criteria: [{ id: 'delegated-review-delivered', satisfied: true, evidence: [...evidence, final.id] }], remainingWork: [], blocker: null,
  } };
}
