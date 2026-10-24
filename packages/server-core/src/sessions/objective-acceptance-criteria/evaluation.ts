import type { Message, ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { BUSINESS_PROCEDURES, businessProcedureCoverage } from "../business-procedures.ts";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { isObjectiveCoordinationTool, isObjectiveToolExecutedSuccessfully, isObjectiveMutationTool } from "../objective-contract.ts";
import { matchesLegacyGscSiteInput, matchesLegacyGscSiteResult } from "../legacy-gsc-site-identity.ts";
import { canonicalToolName, referencesToolAlias } from './criterion-identities.ts';
import { projectObjectiveAcceptanceCriteria } from './criterion-registration-validate-and-merge-objective-acceptance-criteria.ts';
import { exactGmailCompletionCriterionGap } from './gmail-completion-contract.ts';
import { criterionInputMatchesToolInput } from './gmail-preflight.ts';
import { mutationMayAffectCriterion, observationBoundary, observationIsAfterBoundary } from './observation-boundary.ts';
import { matchesAcceptanceResultCheck } from './result-checks.ts';
import { resultProjection } from './result-projection.ts';

function evaluateObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  messages: Message[],
  declaration: ObjectiveOutcomeDeclaration,
  expectedSessionId?: string,
): { gaps: string[]; evidenceRefs: Set<string> } {
  const evidenceRefs = new Set<string>();
  if (objective.acceptanceNeedsReview) return { evidenceRefs, gaps: ['User requirements changed: re-register the full acceptance contract and observe the current target before completion'] };
  if (objective.procedure && (objective.procedure.version !== 1 || !Object.hasOwn(BUSINESS_PROCEDURES, objective.procedure.id))) {
    return { evidenceRefs, gaps: ['Business procedure version is unavailable; requalification is required'] };
  }
  if (!objective.acceptanceCriteria?.length) return { evidenceRefs, gaps: objective.requiresAcceptanceCriteria
    ? ['Register target-bound acceptance checks with set_completion_criteria before claiming completion'] : [] };
  const rootIndex = messages.findIndex(message => message.id === objective.userMessageId);
  if (rootIndex < 0) return { evidenceRefs, gaps: ['Objective transcript provenance is unavailable'] };
  const scoped = messages.slice(rootIndex + 1);
  const projection = projectObjectiveAcceptanceCriteria(objective, messages);
  const exactGmailGap = exactGmailCompletionCriterionGap(objective, projection.criteria);
  const gaps = [
    ...(exactGmailGap ? [exactGmailGap] : []),
    ...projection.criteria.flatMap(criterion => {
    const binding = projection.gscSiteIdentity?.criterionId === criterion.id ? projection.gscSiteIdentity : undefined;
    const observedAfter = observationBoundary(objective, binding, messages, rootIndex);
    let lastRelevantMutation = -1;
    scoped.forEach((message, index) => {
      if (message.role === 'tool' && message.toolExecuted !== false
        && mutationMayAffectCriterion(message, criterion, projection.criteria)) lastRelevantMutation = index;
    });
    // Only a completed business observation supersedes an earlier one. A
    // transport error, refused invocation or checkpoint contains no newer
    // state and must not erase an exact successful observation. A completed
    // empty or negative result is selected and therefore invalidates a PASS.
    const latestObservation = scoped.findLast((message, index) => message.role === 'tool'
      && !!message.toolName && canonicalToolName(message.toolName) === canonicalToolName(criterion.toolName)
      && observationIsAfterBoundary(message, rootIndex + 1 + index, observedAfter)
      && isObjectiveToolExecutedSuccessfully(message) && !isObjectiveCoordinationTool(message)
      && !isObjectiveMutationTool(message)
      && (binding ? matchesLegacyGscSiteInput(binding, message.toolInput)
        : criterionInputMatchesToolInput(criterion, message.toolInput)));
    const claim = declaration.criteria.find(item => item.id === criterion.id);
    // A tool-name reference is only a compact alias. Resolve it inside this
    // criterion's exact target and chronology, and accept it only when one
    // successful non-mutating invocation is eligible. Exact invocation IDs
    // remain valid when several observations used the same tool.
    const aliasCandidates = claim?.satisfied && claim.evidence.some(ref => ref.startsWith('tool:'))
      ? scoped.filter((message, index) => index > lastRelevantMutation
        && message.role === 'tool' && !!message.toolName
        && canonicalToolName(message.toolName) === canonicalToolName(criterion.toolName)
        && observationIsAfterBoundary(message, rootIndex + 1 + index, observedAfter)
        && isObjectiveToolExecutedSuccessfully(message) && !isObjectiveCoordinationTool(message)
        && !isObjectiveMutationTool(message) && message.toolResult !== undefined
        && (binding ? matchesLegacyGscSiteInput(binding, message.toolInput)
          : criterionInputMatchesToolInput(criterion, message.toolInput))
        && referencesToolAlias(claim.evidence, message.toolName))
      : [];
    const matched = claim?.satisfied ? scoped.filter((message, index) => {
      const directlyReferenced = claim.evidence.includes(message.id)
        || !!message.toolUseId && claim.evidence.includes(message.toolUseId);
      // Repeating the exact immutable invocation refreshes its observation.
      // Resolve a tool alias to that one latest target-bound result rather than
      // rejecting it merely because an older snapshot of the same target exists.
      const uniquelyResolvedAlias = message === latestObservation
        && aliasCandidates.includes(message)
        && !!message.toolName
        && referencesToolAlias(claim.evidence, message.toolName);
      if (message !== latestObservation || index <= lastRelevantMutation
        || !observationIsAfterBoundary(message, rootIndex + 1 + index, observedAfter)
        || !message.toolName || canonicalToolName(message.toolName) !== canonicalToolName(criterion.toolName)
        || !isObjectiveToolExecutedSuccessfully(message) || isObjectiveCoordinationTool(message)
        || isObjectiveMutationTool(message) || message.toolResult === undefined
        || !(directlyReferenced || uniquelyResolvedAlias)) return false;
      if (binding ? !matchesLegacyGscSiteInput(binding, message.toolInput)
        : !criterionInputMatchesToolInput(criterion, message.toolInput)) return false;
      if (binding) return message.toolExecuted === true && !!message.toolUseId
        && scoped.filter(item => item.id === message.id).length === 1
        && scoped.filter(item => item.toolUseId === message.toolUseId).length === 1
        && matchesLegacyGscSiteResult(binding, message.toolResult);
      const result = resultProjection(message, true, expectedSessionId);
      return criterion.checks.every(check => matchesAcceptanceResultCheck(message, result, check));
    }) : [];
    for (const message of matched) {
      evidenceRefs.add(message.id);
      if (message.toolUseId) evidenceRefs.add(message.toolUseId);
    }
    return matched.length ? [] : [`Business criterion lacks matching post-action evidence: ${criterion.id}`];
    }),
  ];
  if (objective.procedure) gaps.push(...businessProcedureCoverage(objective.procedure.id, objective.acceptanceCriteria)
    .map(id => `Business procedure lacks outcome coverage: ${id}`));
  return { gaps, evidenceRefs };
}

export function validateObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  messages: Message[],
  declaration: ObjectiveOutcomeDeclaration,
  expectedSessionId?: string,
): string[] {
  return evaluateObjectiveAcceptanceCriteria(objective, messages, declaration, expectedSessionId).gaps;
}

/** Concrete invocation refs only, verified against the complete registered target-bound check. */
export function collectObjectiveAcceptanceEvidenceRefs(
  objective: ActiveSessionObjective,
  messages: Message[],
  declaration: ObjectiveOutcomeDeclaration,
  expectedSessionId?: string,
): Set<string> {
  return evaluateObjectiveAcceptanceCriteria(objective, messages, declaration, expectedSessionId).evidenceRefs;
}

/**
 * Observations for a delegated audit, including a real negative result. This
 * does not validate business acceptance: the normal validator above still
 * requires every expected value to pass. Only the last invocation of each
 * exact registered target is returned. A newer completed business result
 * supersedes an older snapshot; transport failures and checkpoints do not.
 */
export function collectObjectiveAcceptanceObservations(
  objective: ActiveSessionObjective,
  messages: Message[],
  expectedSessionId?: string,
): Array<{ criterionId: string; message: Message; passed: boolean }> {
  const rootIndex = messages.findIndex(message => message.role === 'user' && message.id === objective.userMessageId);
  if (rootIndex < 0) return [];
  const projection = projectObjectiveAcceptanceCriteria(objective, messages);
  const scoped = messages.slice(rootIndex + 1);
  return projection.criteria.flatMap(criterion => {
    const binding = projection.gscSiteIdentity?.criterionId === criterion.id ? projection.gscSiteIdentity : undefined;
    const observedAfter = observationBoundary(objective, binding, messages, rootIndex);
    let lastRelevantMutation = -1;
    let latest: Message | undefined;
    for (const [index, message] of scoped.entries()) {
      if (message.role === 'tool' && message.toolExecuted !== false
        && mutationMayAffectCriterion(message, criterion, projection.criteria)) lastRelevantMutation = index;
      if (!observationIsAfterBoundary(message, rootIndex + 1 + index, observedAfter)
        || !message.toolName || canonicalToolName(message.toolName) !== canonicalToolName(criterion.toolName)
        || message.role !== 'tool' || !isObjectiveToolExecutedSuccessfully(message)
        || isObjectiveCoordinationTool(message) || isObjectiveMutationTool(message)) continue;
      if (binding ? matchesLegacyGscSiteInput(binding, message.toolInput)
        : criterionInputMatchesToolInput(criterion, message.toolInput)) latest = message;
    }
    const latestIndex = latest ? scoped.indexOf(latest) : -1;
    if (!latest || latestIndex <= lastRelevantMutation || latest.toolResult === undefined) return [];
    const result = resultProjection(latest, true, expectedSessionId);
    // Invalid structured output is not an observation of the requested fields.
    if (criterion.checks.some(check => check.path !== '$text') && result === undefined) return [];
    if (binding && (latest.toolExecuted !== true || !latest.toolUseId || messages.filter(item => item.id === latest!.id).length !== 1
      || messages.filter(item => item.toolUseId === latest!.toolUseId).length !== 1)) return [];
    const passed = binding ? matchesLegacyGscSiteResult(binding, latest.toolResult!)
      : criterion.checks.every(check => matchesAcceptanceResultCheck(latest!, result, check));
    return [{ criterionId: criterion.id, message: latest, passed }];
  });
}

/**
 * True only when every registered acceptance target has a current positive
 * host observation. Unlike the broad execution-presence signal, this cannot
 * be satisfied by an unrelated write elsewhere in the objective transcript.
 */
export function hasTargetBoundObjectiveExecutionEvidence(
  objective: ActiveSessionObjective,
  messages: Message[],
  expectedSessionId?: string,
): boolean {
  if (objective.acceptanceNeedsReview) return false;
  const criteria = projectObjectiveAcceptanceCriteria(objective, messages).criteria;
  if (criteria.length === 0) return false;
  const passed = new Set(collectObjectiveAcceptanceObservations(
    objective,
    messages,
    expectedSessionId,
  ).filter(observation => observation.passed).map(observation => observation.criterionId));
  return criteria.every(criterion => passed.has(criterion.id));
}
