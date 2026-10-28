import type { Message, ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { currentExplicitReadOnlyAuthorityBoundary, isObjectiveMutationTool, objectiveRequiresExecutionEvidence, findObjectiveText, transitionObjectiveContract } from "../objective-contract.ts";
import { collectObjectiveAcceptanceObservations, projectObjectiveAcceptanceCriteria } from "../objective-acceptance-criteria.ts";
import { AUTHORITY_DEPENDENCY_PATTERN, AUTHORITY_ENVIRONMENT_PATTERNS, AUTHORITY_MUTATION_ACTION_PATTERNS, AUTHORITY_ONLY_MUTATION_PATTERN, AUTHORITY_TARGET_GENERIC_TOKENS, SAFE_REMAINING_WORK_PATTERN } from './execution-evidence.ts';

function normalizedAuthorityText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLowerCase();
}

function authorityMutationActionIndexes(text: string): Set<number> {
  const normalized = normalizedAuthorityText(text);
  return new Set(AUTHORITY_MUTATION_ACTION_PATTERNS.flatMap((pattern, index) => (
    pattern.test(normalized) ? [index] : []
  )));
}

function authorityEnvironmentIndexes(text: string): Set<number> {
  const normalized = normalizedAuthorityText(text);
  return new Set(AUTHORITY_ENVIRONMENT_PATTERNS.flatMap((pattern, index) => (
    pattern.test(normalized) ? [index] : []
  )));
}

function authorityTargetTerms(text: string): Set<string> {
  const normalized = normalizedAuthorityText(text);
  return new Set((normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter(token => (
    !AUTHORITY_TARGET_GENERIC_TOKENS.has(token)
    && !AUTHORITY_MUTATION_ACTION_PATTERNS.some(pattern => pattern.test(token))
    && !AUTHORITY_ENVIRONMENT_PATTERNS.some(pattern => pattern.test(token))
  )));
}

function remainingAuthorityTargetMatches(originalObjectiveText: string, remainingWork: string): boolean {
  const originalEnvironments = authorityEnvironmentIndexes(originalObjectiveText);
  const remainingEnvironments = authorityEnvironmentIndexes(remainingWork);
  if (originalEnvironments.size > 0 && remainingEnvironments.size > 0
    && ![...remainingEnvironments].some(environment => originalEnvironments.has(environment))) return false;
  const originalTerms = authorityTargetTerms(originalObjectiveText);
  const remainingTerms = authorityTargetTerms(remainingWork);
  if (remainingTerms.size > 0) return [...remainingTerms].every(term => originalTerms.has(term));
  if (originalTerms.size > 0) return false;
  return [...remainingEnvironments].some(environment => originalEnvironments.has(environment));
}

function authorityOnlyRemainingWork(remainingWork: readonly string[], originalObjectiveText: string): boolean {
  const originalActions = authorityMutationActionIndexes(originalObjectiveText);
  if (remainingWork.length === 0 || originalActions.size === 0) return false;
  return remainingWork.every(item => {
    const normalized = normalizedAuthorityText(item);
    if (SAFE_REMAINING_WORK_PATTERN.test(normalized)) return false;
    const remainingActions = authorityMutationActionIndexes(normalized);
    return (AUTHORITY_ONLY_MUTATION_PATTERN.test(normalized)
        || AUTHORITY_DEPENDENCY_PATTERN.test(normalized))
      && remainingActions.size > 0
      && [...remainingActions].some(action => originalActions.has(action))
      && remainingAuthorityTargetMatches(originalObjectiveText, normalized);
  });
}

/**
 * A direct user can intentionally withhold authority in a later amendment to
 * an earlier mutation mission. A read-only root is never such a handoff, and
 * the remaining action and target must still bind to that original mission.
 * Admit the handoff only when every immutable, target-bound preflight criterion
 * has a fresh passing observation. Mutations before the boundary remain
 * covered by those later checks; a mutation in the read-only phase rejects the
 * handoff. This prevents prose plus an unrelated read from inventing a blocker.
 */
export function explicitReadOnlyAuthorityBlocker(
  declaration: ObjectiveOutcomeDeclaration,
  objective: ActiveSessionObjective,
  messages: Message[],
  expectedSessionId?: string,
): boolean {
  if (declaration.state !== 'blocked_human'
    || declaration.blocker?.kind !== 'external_authorization') return false;
  const boundary = currentExplicitReadOnlyAuthorityBoundary(objective, messages);
  const originalObjectiveText = findObjectiveText(messages, objective);
  if (!boundary || boundary.messageId === objective.userMessageId || !originalObjectiveText?.trim()) return false;
  const originalObjective = transitionObjectiveContract({
    messageId: objective.userMessageId,
    text: originalObjectiveText,
    ...(objective.delegatedRole !== undefined ? { delegatedRole: objective.delegatedRole } : {}),
    nowMs: objective.startedAt,
  });
  if (!objectiveRequiresExecutionEvidence(originalObjective, originalObjectiveText)
    || objectiveRequiresExecutionEvidence(objective, originalObjectiveText)
    || !authorityOnlyRemainingWork(declaration.remainingWork, originalObjectiveText)) return false;
  if (!declaration.blocker.evidence.includes(boundary.messageId)) return false;
  const rootIndex = messages.findIndex(message => message.id === objective.userMessageId && message.role === 'user');
  const boundaryIndexes = messages.flatMap((message, index) => message.id === boundary.messageId
    && message.role === 'user' && !message.hidden && !message.internalOrigin
    && !message.agentDelivery && !message.isQueued && !message.isPending ? [index] : []);
  if (rootIndex < 0 || boundaryIndexes.length !== 1 || boundaryIndexes[0]! <= rootIndex) return false;
  const boundaryIndex = boundaryIndexes[0]!;
  const readOnlyPhase = messages.slice(boundaryIndex + 1);
  if (readOnlyPhase.some(message => message.role === 'tool' && message.toolExecuted !== false
    && isObjectiveMutationTool(message))) return false;
  if (objective.acceptanceNeedsReview) return false;
  const criteria = projectObjectiveAcceptanceCriteria(objective, messages).criteria;
  if (criteria.length === 0) return false;
  const observations = collectObjectiveAcceptanceObservations(objective, messages, expectedSessionId)
    .filter(observation => observation.passed && messages.indexOf(observation.message) > boundaryIndex);
  return criteria.every(criterion => observations.some(observation => observation.criterionId === criterion.id));
}
