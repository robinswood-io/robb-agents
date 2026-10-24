import { completionCriterionPathKeys as pathKeys } from "@craft-agent/session-tools-core";
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveProcedureId } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { canonicalTerminalReconciliationToolInput, isObjectiveShellExecutorToolName } from "@craft-agent/shared/agent";
import { TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR, TERMINAL_RECONCILIATION_INITIAL_EVIDENCE_ERROR, criterionSupersessionIdentity, selectorIdentity } from './criterion-identities.ts';
import { assertObservedCriterionResultShapes, nextCriterionVersionId, validateAndMergeObjectiveAcceptanceCriteria } from './criterion-registration-validate-and-merge-objective-acceptance-criteria.ts';
import { collectObjectiveAcceptanceObservations } from './evaluation.ts';
import { assertExactGmailCompletionCriteria } from './gmail-completion-contract.ts';
import { criterionRegisteredAt, withoutFinalLineTerminator } from './result-checks.ts';
import { resultJson } from './result-projection.ts';
import { assertAdmissibleShellCriteria, assertSatisfiableShellCriteria, criterionInvocationIdentity } from './shell-contract.ts';
import { assertTerminalReconciliationAcceptanceContract } from './terminal-reconciliation.ts';

/**
 * Prepare an explicit, fail-closed rollover of a negatively observed check.
 * The successor may advance only its `_vN` identity: description, requirement,
 * tool, target input and checks remain exact. Human amendments use the separate
 * full-contract revision path when acceptance semantics genuinely change.
 */
function applyExplicitCriterionSupersessions(
  objective: ActiveSessionObjective,
  criteria: readonly ObjectiveAcceptanceCriterion[],
  messages: readonly Message[] | undefined,
  expectedSessionId: string | undefined,
): ActiveSessionObjective {
  const replacements = criteria.filter((criterion) => criterion?.supersedes !== undefined);
  if (!replacements.length) return objective;
  if (objective.acceptanceNeedsReview) {
    throw new Error('A user-amended acceptance contract must be re-registered as one complete revision; criterion supersession is only for a failed check in the unchanged objective');
  }
  if (!messages?.length) {
    throw new Error('A criterion can be superseded only after its exact failed observation is available to the host');
  }
  const registered = new Map((objective.acceptanceCriteria ?? []).map(criterion => [criterion.id, criterion]));
  const incomingIds = new Set(criteria.map(criterion => criterion.id));
  const supersededIds = new Set<string>();
  const observations = new Map(collectObjectiveAcceptanceObservations(
    objective,
    [...messages],
    expectedSessionId,
  ).map(observation => [observation.criterionId, observation]));

  for (const replacement of replacements) {
    const previousId = replacement.supersedes!;
    const previous = registered.get(previousId);
    if (!previous || supersededIds.has(previousId) || incomingIds.has(previousId)) {
      throw new Error(`Criterion ${replacement.id} must supersede exactly one existing criterion that is omitted from the new invocation`);
    }
    if (replacement.id !== nextCriterionVersionId(previousId)) {
      throw new Error(`Criterion ${replacement.id} must use the next explicit version ID ${nextCriterionVersionId(previousId)}`);
    }
    if (replacement.requirementId !== previous.requirementId) {
      throw new Error(`Criterion ${replacement.id} must preserve requirementId from ${previousId}`);
    }
    const observation = observations.get(previousId);
    const repairsUnprojectedShellTextSelector = !!observation
      && !observation.passed
      && isObjectiveShellExecutorToolName(previous.toolName)
      && resultJson(observation.message.toolResult ?? '') === undefined
      && previous.checks.length > 0
      && previous.checks.some(check => check.path !== '$text' && pathKeys(check.path)?.[0] !== 'transport')
      && criterionSupersessionIdentity({ ...replacement, checks: previous.checks }) === criterionSupersessionIdentity(previous)
      && replacement.checks.length === 1
      && replacement.checks[0]?.path === '$text'
      && typeof replacement.checks[0].equals === 'string'
      && previous.checks.every(check => typeof check.equals === 'string' && (replacement.checks[0]!.equals as string).includes(check.equals));
    if (criterionSupersessionIdentity(replacement) !== criterionSupersessionIdentity(previous)
      && !repairsUnprojectedShellTextSelector) {
      throw new Error(`Criterion ${replacement.id} must preserve the exact description, tool, target input and checks from ${previousId}; only a user amendment may change acceptance semantics`);
    }
    if (!observation || observation.passed) {
      throw new Error(`Criterion ${previousId} can be superseded only after its exact current observation completed with a negative result`);
    }
    if (!Number.isFinite(observation.message.timestamp)
      || observation.message.timestamp <= criterionRegisteredAt(objective, previousId)) {
      throw new Error(`Criterion ${previousId} must be re-observed after that exact version was registered before it can be superseded`);
    }
    supersededIds.add(previousId);
  }

  const activeCriteria = (objective.acceptanceCriteria ?? [])
    .filter(criterion => !supersededIds.has(criterion.id));
  const activeRegistrationTimes = Object.fromEntries(Object.entries(
    objective.acceptanceRegisteredAtById ?? {},
  ).filter(([id]) => !supersededIds.has(id)));
  return {
    ...objective,
    acceptanceCriteria: activeCriteria,
    acceptanceRegisteredAtById: activeRegistrationTimes,
    acceptanceHistory: [...(objective.acceptanceHistory ?? []), {
      revision: `criterion-correction:${[...supersededIds].sort().join(',')}`,
      criteria: structuredClone(objective.acceptanceCriteria ?? []),
      registeredAt: objective.acceptanceRegisteredAt,
      registeredAtById: structuredClone(objective.acceptanceRegisteredAtById ?? {}),
    }],
  };
}

/** Reject new contradictory obligations; never rewrite or re-admit old contracts. */
export function registerObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  criteria: ObjectiveAcceptanceCriterion[],
  now = Date.now(),
  procedureId?: ObjectiveProcedureId,
  messages?: readonly Message[],
  expectedSessionId?: string,
): ActiveSessionObjective {
  if (objective.terminalState !== 'active') throw new Error('No active objective');
  // A reconciliation can arrive before an objective that requires checks has
  // registered its first contract. Permit that one normal registration; once
  // any criterion exists, the resulting host binding is immutable.
  if (objective.terminalReconciliation) {
    if (objective.acceptanceCriteria?.length && !objective.acceptanceNeedsReview) {
      assertTerminalReconciliationAcceptanceContract(objective, criteria, procedureId);
      return objective;
    }
    if (objective.terminalReconciliation.initialAcceptanceRegistrationRequired !== true
      || objective.requiresAcceptanceCriteria !== true) {
      throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
    }
    if (procedureId !== objective.procedure?.id) {
      throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
    }
  }
  const registrationBase = applyExplicitCriterionSupersessions(
    objective,
    criteria,
    messages,
    expectedSessionId,
  );
  const merged = validateAndMergeObjectiveAcceptanceCriteria(registrationBase, criteria, now, procedureId);
  assertExactGmailCompletionCriteria(merged, merged.acceptanceCriteria ?? []);
  const existingIds = new Set((registrationBase.acceptanceCriteria ?? []).map(item => item.id));
  const additions = registrationBase.acceptanceNeedsReview ? merged.acceptanceCriteria!
    : merged.acceptanceCriteria!.filter(item => !existingIds.has(item.id));
  // An identical re-registration must preserve old serialized contracts,
  // hashes and timestamps, including contradictions created by older hosts.
  if (!additions.length) return merged;
  assertAdmissibleShellCriteria(additions);
  assertObservedCriterionResultShapes(objective, additions, messages, expectedSessionId);
  if (objective.terminalReconciliation
    && objective.terminalReconciliation.initialAcceptanceRegistrationRequired === true
    && (!objective.acceptanceCriteria?.length || objective.acceptanceNeedsReview === true)) {
    const markerIndexes = (messages ?? []).flatMap((message, index) => (
      message.id === objective.terminalReconciliation!.messageId
        && message.role === 'user' && !message.hidden && !message.internalOrigin
        && !message.agentDelivery && !message.isQueued && !message.isPending ? [index] : []
    ));
    if (markerIndexes.length !== 1) throw new Error(TERMINAL_RECONCILIATION_INITIAL_EVIDENCE_ERROR);
    const beforeMarker = [...messages!].slice(0, markerIndexes[0]);
    const observations = collectObjectiveAcceptanceObservations(
      merged,
      beforeMarker,
      expectedSessionId,
    );
    const satisfied = new Set(observations.flatMap(observation => (
      observation.passed && observation.message.toolName
        && canonicalTerminalReconciliationToolInput(observation.message.toolInput) !== undefined
        ? [observation.criterionId] : []
    )));
    if (additions.some(criterion => !satisfied.has(criterion.id))) {
      throw new Error(TERMINAL_RECONCILIATION_INITIAL_EVIDENCE_ERROR);
    }
  }

  const constraints = new Map<string, Map<string, Array<{ criterionId: string; value: unknown }>>>();
  const inspect = (item: ObjectiveAcceptanceCriterion, isAddition: boolean) => {
    const invocation = criterionInvocationIdentity(item);
    let selectors = constraints.get(invocation);
    if (!selectors) { selectors = new Map(); constraints.set(invocation, selectors); }
    for (const check of item.checks) {
      const selector = selectorIdentity(check.path);
      // This is the existing evaluator's equality, not coercion or trimming.
      const value = check.path === '$text' && typeof check.equals === 'string'
        ? withoutFinalLineTerminator(check.equals) : check.equals;
      const previous = selectors.get(selector) ?? [];
      const conflict = isAddition ? previous.find(entry => entry.value !== value) : undefined;
      if (conflict) throw new Error(`Incompatible registered equality: criterion ${item.id} conflicts with ${conflict.criterionId} on selector ${check.path} for the same tool and exact inputs. Registered criteria are unchanged; this rejection does not authorize replacing them or repeating external actions.`);
      previous.push({ criterionId: item.id, value });
      selectors.set(selector, previous);
    }
  };
  // A human revision replaces the old obligation set. Check the complete new
  // set against itself; old contradictory values must not prevent a repair.
  if (!registrationBase.acceptanceNeedsReview) {
    for (const item of registrationBase.acceptanceCriteria ?? []) inspect(item, false);
  }
  for (const item of additions) inspect(item, true);
  assertSatisfiableShellCriteria(merged.acceptanceCriteria!, new Set(additions.map(item => item.id)));
  return merged;
}
