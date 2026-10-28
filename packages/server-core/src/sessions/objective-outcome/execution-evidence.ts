import type { IndependentReviewContext } from '../../../../shared/src/agent/core/objective-evidence-gate/review-receipts.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { Message } from "@craft-agent/core/types";
import { classifyToolNameMutationSemantics, isObjectiveShellExecutorToolName, isObjectiveShellEvidenceCommand, isObjectiveShellObservationCommand, parseIndependentReviewReceipt } from "@craft-agent/shared/agent";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { hasObjectiveSubstantiveToolResult, isObjectiveMutationTool, isObjectiveEvidenceInvalidatingMutation, objectiveAllowsContentCheckReview, objectiveReviewBinding } from "../objective-contract.ts";
import { collectObjectiveAcceptanceObservations } from "../objective-acceptance-criteria.ts";
import type { ToolAliasCandidateGroup } from './blocker-identities.ts';
import { toolAliasDescriptor } from './blocker-identities.ts';
import { currentObjectiveBlockerObservations } from './blocker-observations.ts';
import type { ObjectiveBlockerKind } from './declaration.ts';
import { CALL_LLM_TOOL_PATTERN, NON_VALIDATION_TOOL_PATTERN, OBSERVATION_ACTION_PATTERN, OBSERVATION_HTTP_METHOD_PATTERN, OBSERVATION_SQL_PATTERN, OBSERVATION_TOOL_PATTERN, REVIEW_TOOL_PATTERN, messagesForObjective, normalizedToolName } from './declaration.ts';

function substantiveToolResult(message: Message): string | undefined {
  return hasObjectiveSubstantiveToolResult(message)
    ? message.toolResult!.trim()
    : undefined;
}

function observationOrValidationTool(message: Message): boolean {
  if (isObjectiveMutationTool(message)) return false;
  if (classifyToolNameMutationSemantics(message.toolName ?? '') === 'ambiguous-compound') return false;
  const toolName = normalizedToolName(message.toolName);
  const input = message.toolInput ?? {};
  const command = [input["command"], input["cmd"], input["script"]]
    .find((value): value is string => typeof value === 'string');
  // Generic/local/remote shell executors use the shared non-opaque subset.
  // The registered-only validator/curl extension is applied below only after
  // exact acceptance evidence matched. Tool naming alone cannot turn inline
  // code or fabricated stdout into a validation observation.
  if (isObjectiveShellExecutorToolName(message.toolName ?? '')) {
    return command !== undefined && isObjectiveShellObservationCommand(command);
  }
  if (NON_VALIDATION_TOOL_PATTERN.test(toolName)) return false;
  if (OBSERVATION_TOOL_PATTERN.test(toolName)) return true;
  const action = [input["action"], input["operation"]]
    .find((value): value is string => typeof value === 'string');
  if (action && OBSERVATION_ACTION_PATTERN.test(action.trim())) return true;
  const method = input["method"];
  if (typeof method === 'string' && OBSERVATION_HTTP_METHOD_PATTERN.test(method.trim())) return true;
  const query = [input["query"], input["sql"], input["statement"]]
    .find((value): value is string => typeof value === 'string');
  if (query && OBSERVATION_SQL_PATTERN.test(query)) return true;
  return command ? isObjectiveShellObservationCommand(command) : false;
}

export function hostEvidenceRefs(
  messages: Message[],
  objective: ActiveSessionObjective,
  acceptanceEvidenceRefs: ReadonlySet<string> = new Set(),
  reviewNotBefore?: number,
): {
  successful: Set<string>;
  checks: Set<string>;
  review: Set<string>;
  incompleteCheckReviews: Map<string, string[]>;
  blockers: Record<ObjectiveBlockerKind, Set<string>>;
} {
  const scoped = messagesForObjective(messages, objective.userMessageId);
  const successful = new Set<string>(['assistant-final']);
  const checks = new Set<string>();
  const review = new Set<string>();
  const incompleteCheckReviews = new Map<string, string[]>();
  const blockers: Record<ObjectiveBlockerKind, Set<string>> = {
    credential: new Set(),
    mfa: new Set(),
    external_authorization: new Set(),
    irreversible_authority: new Set(),
    business_decision: new Set(),
    policy: new Set(),
  };
  const toolAliasCandidates = new Map<Set<string>, Map<string, ToolAliasCandidateGroup>>();
  const addAliasCandidate = (refs: Set<string>, message: Message, messageIndex: number): void => {
    if (!message.toolName) return;
    const descriptor = toolAliasDescriptor(message.toolName);
    const byTool = toolAliasCandidates.get(refs) ?? new Map<string, ToolAliasCandidateGroup>();
    const candidate = byTool.get(descriptor.key) ?? { aliases: descriptor.aliases, messageIndexes: new Set<number>() };
    candidate.messageIndexes.add(messageIndex);
    byTool.set(descriptor.key, candidate);
    toolAliasCandidates.set(refs, byTool);
  };
  const addBlockerEvidence = (kind: ObjectiveBlockerKind, message: Message, messageIndex: number): void => {
    blockers[kind].add(message.id);
    if (message.toolUseId) blockers[kind].add(message.toolUseId);
    if (message.authRequestId) blockers[kind].add(message.authRequestId);
    addAliasCandidate(blockers[kind], message, messageIndex);
  };
  // Exact current acceptance observations may use a deliberately bounded
  // opaque SSH validator that is stricter than the generic shell read grammar.
  // Once the host has matched that immutable invocation and result shape, the
  // read must not invalidate an otherwise current independent review.
  const registeredReadObservationIds = new Set(collectObjectiveAcceptanceObservations(
    objective,
    messages,
  ).filter(observation => !isObjectiveMutationTool(observation.message))
    .map(observation => observation.message.id));
  let lastMutationIndex = -1;
  for (const [index, message] of scoped.entries()) {
    if (message.role === 'tool' && message.toolExecuted !== false
      && !registeredReadObservationIds.has(message.id)
      && isObjectiveEvidenceInvalidatingMutation(message)) {
      lastMutationIndex = index;
    }
  }
  const contentCheckReviewAllowed = lastMutationIndex < 0 && objectiveAllowsContentCheckReview(objective,
    messages.find(message => message.id === objective.userMessageId && message.role === 'user')?.content);
  const addRefs = (refs: Set<string>, message: Message, messageIndex: number): void => {
    refs.add(message.id);
    if (message.toolUseId) refs.add(message.toolUseId);
    addAliasCandidate(refs, message, messageIndex);
  };
  for (const observation of currentObjectiveBlockerObservations(messages, objective)) {
    addBlockerEvidence(observation.kind, observation.message, observation.messageIndex);
  }
  for (const [index, message] of scoped.entries()) {
    const substantiveResult = substantiveToolResult(message);
    if (!substantiveResult) continue;
    addRefs(successful, message, index);
    const afterLatestMutation = index > lastMutationIndex;
    // A generic executor can be a conservative mutation boundary and still
    // return the post-invocation observation (for example a SELECT through an
    // opaque SQL tool). Only its observation can certify itself: a mutating
    // tool that happens to emit review-shaped JSON must not certify a review.
    const observationAtLatestMutation = index === lastMutationIndex
      && observationOrValidationTool(message);
    const binding = objectiveReviewBinding(objective);
    const reviewReceipt = REVIEW_TOOL_PATTERN.test(message.toolName ?? '')
      ? parseIndependentReviewReceipt(substantiveResult, omitUndefined<IndependentReviewContext>({
        ...binding, toolName: message.toolName ?? '',
        sessionIds: Array.isArray(message.toolInput?.["sessionIds"])
          && message.toolInput["sessionIds"].every((id: unknown) => typeof id === 'string')
          ? message.toolInput["sessionIds"] as string[] : undefined,
      }))
      : undefined;
    const reviewedCriteria = new Set(reviewReceipt?.criteria.map(criterion => criterion.id));
    const requiredReviewCriteria = [...objective.completionCriteria.filter(criterion => (
      criterion !== 'independent-review-passed'
    )), ...(objective.acceptanceCriteria ?? []).map(criterion => criterion.id)];
    const passedReview = (
      reviewReceipt?.verdict === 'PASS'
      && (!objective.acceptanceCriteria?.length || (reviewReceipt.objectiveId === binding.objectiveId
        && reviewReceipt.acceptanceSha256 === binding.acceptanceSha256))
      && reviewReceipt.findings.length === 0
      && reviewReceipt.criteria.every(criterion => criterion.passed)
    );
    const validReview = passedReview
      && requiredReviewCriteria.every(criterion => reviewedCriteria.has(criterion));
    // Reviewing the content of a response does not require the reviewer to
    // attest that the parent delivered it or has no remaining work. External
    // actions, registered checks and mandatory independent reviews retain the
    // complete contract, even for persisted objectives missing evidence flags.
    const validContentCheckReview = passedReview && contentCheckReviewAllowed
      && reviewedCriteria.has('relevant-checks-passed');
    if (afterLatestMutation && passedReview && !validReview && !validContentCheckReview) {
      const missing = (contentCheckReviewAllowed ? ['relevant-checks-passed'] : requiredReviewCriteria)
        .filter(criterion => !reviewedCriteria.has(criterion));
      for (const ref of [message.id, message.toolUseId, message.toolName ? `tool:${message.toolName}` : undefined]) {
        if (ref) incompleteCheckReviews.set(ref, missing);
      }
    }
    if (observationAtLatestMutation
      || (afterLatestMutation && (observationOrValidationTool(message) || validReview || validContentCheckReview))) {
      addRefs(checks, message, index);
    }
    // call_llm runs through the current session's connection and can inherit
    // the exact same model. Its structured prose is useful as a content check,
    // but it is never independent review evidence. A separate reviewer result
    // (normally collected through wait_sessions) remains required.
    if (afterLatestMutation && validReview
      && !CALL_LLM_TOOL_PATTERN.test(message.toolName ?? '')
      && (reviewNotBefore === undefined || message.timestamp >= reviewNotBefore)) {
      addRefs(review, message, index);
      // A delegated reviewer commonly cites its own final message id in the
      // parent's receipt. Accept that id only when wait_sessions supplied it
      // alongside the uniquely requested, objective/hash-bound PASS above.
      // Arbitrary ids in reviewer prose are discarded by the shared parser.
      if (reviewReceipt.reviewMessageId) review.add(reviewReceipt.reviewMessageId);
    }
  }
  // Exact registered checks can certify short or application-specific results
  // that are intentionally not generic substantive evidence. Project their
  // concrete refs and aliases through the same uniqueness accounting.
  for (const [index, message] of scoped.entries()) {
    if (!acceptanceEvidenceRefs.has(message.id)) continue;
    addRefs(successful, message, index);
    const command = [message.toolInput?.["command"], message.toolInput?.["cmd"], message.toolInput?.["script"]]
      .find((value): value is string => typeof value === 'string');
    const registeredShellCheck = isObjectiveShellExecutorToolName(message.toolName ?? '')
      && command !== undefined && isObjectiveShellEvidenceCommand(command);
    const isCheck = observationOrValidationTool(message) || registeredShellCheck;
    if (isCheck) addRefs(checks, message, index);
    if (message.toolName) {
      for (const alias of toolAliasDescriptor(message.toolName).aliases) {
        successful.add(alias);
        if (isCheck) checks.add(alias);
      }
    }
  }
  for (const [refs, candidatesByTool] of toolAliasCandidates) {
    for (const candidate of candidatesByTool.values()) {
      if (candidate.messageIndexes.size === 1) {
        for (const alias of candidate.aliases) refs.add(alias);
      }
    }
  }
  return { successful, checks, review, incompleteCheckReviews, blockers };
}

/** Host-only predicate for the exact current independent-review binding. It
 * intentionally reuses the completion validator's mutation ordering, receipt
 * parser and full-criteria checks instead of trusting child/session status. */
export function hasCurrentObjectiveIndependentReviewPass(
  objective: ActiveSessionObjective,
  messages: Message[],
  reviewNotBefore?: number,
): boolean {
  return hostEvidenceRefs(messages, objective, new Set(), reviewNotBefore).review.size > 0;
}

export const AUTHORITY_ONLY_MUTATION_PATTERN = /\b(?:deploy\w*|deplo\w*|publish\w*|publi\w*|restart|redemarr\w*|modify|modification|modifi\w*|write|ecriture|ecri\w*|push|merge|install|configur\w*|activate|activation|reactiv\w*|mutation|mise\s+en\s+production)\b/i;

export const AUTHORITY_DEPENDENCY_PATTERN = /\b(?:approval|authorization|permission|sign[ -]?off|business\s+decision|green\s+light|approbation|autorisation|permission|validation\s+humaine|decision\s+metier|feu\s+vert|accord\s+explicite)\b/i;

export const SAFE_REMAINING_WORK_PATTERN = /\b(?:inspect|audit|check|verify|read|review|test|status|diagnos\w*|observe|search|list|compare|inspect\w*|audit\w*|verifi\w*|lis|lire|relis|relire|contr[oô]l\w*|statut|diagnosti\w*|observ\w*|recherch\w*|list\w*|compar\w*)\b/i;

export const AUTHORITY_MUTATION_ACTION_PATTERNS = [
  /\b(?:deploy\w*|deplo\w*|publish\w*|publi\w*|mise\s+en\s+production)\b/i,
  /\b(?:restart|start|redemarr\w*|demarr\w*|activate|activation|reactiv\w*)\b/i,
  /\b(?:modify|modification|modifi\w*|write|ecriture|ecri\w*|mutation|configur\w*)\b/i,
  /\binstall\w*\b/i,
  /\bpush\w*\b/i,
  /\bmerge\w*\b/i,
] as const;

export const AUTHORITY_TARGET_GENERIC_TOKENS = new Set([
  'app', 'application', 'component', 'composant', 'environment', 'environnement',
  'after', 'and', 'apres', 'approval', 'approbation', 'authorization', 'autorisation', 'avant', 'before',
  'cette', 'check', 'cible', 'dans', 'decision', 'deployment', 'deploiement', 'des', 'effectue', 'effectuer',
  'explicit', 'explicite', 'for', 'green', 'humain', 'humaine', 'install', 'installation', 'les', 'mise',
  'mutation', 'nothing', 'only', 'permission', 'pour', 'production', 'publish', 'publication', 'puis',
  'project', 'projet', 'restart', 'rien', 'server', 'serveur', 'service', 'sign', 'sous', 'staging', 'strictement', 'sur',
  'system', 'systeme', 'version',
  'then', 'this', 'une', 'uniquement', 'validation', 'verifie', 'verifier', 'vert', 'with', 'write',
]);

export const AUTHORITY_ENVIRONMENT_PATTERNS = [
  /\b(?:prod|production)\b/i,
  /\b(?:stage|staging|preprod|preproduction|recette)\b/i,
  /\b(?:dev|development|developpement)\b/i,
  /\b(?:local|localhost)\b/i,
] as const;
