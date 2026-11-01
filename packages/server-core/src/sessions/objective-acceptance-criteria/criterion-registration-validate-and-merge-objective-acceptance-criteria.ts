import { completionCriterionPathKeys as pathKeys } from "@craft-agent/session-tools-core";
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveProcedureId } from "@craft-agent/core/types";
import { BUSINESS_PROCEDURES } from "../business-procedures.ts";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { isObjectiveCoordinationTool, isObjectiveToolExecutedSuccessfully } from "../objective-contract.ts";
import { recoverLegacyAcceptanceScalars, type ObjectiveAcceptanceCriteriaProjection } from "../legacy-acceptance-scalars.ts";
import { recoverLegacyGscSiteIdentity, type LegacyGscSiteIdentity } from "../legacy-gsc-site-identity.ts";
import { atPath, canonicalToolName, criterionIdentity, isCriterionInputScalar, isScalar, selectorIdentity } from './criterion-identities.ts';
import { criterionInputMatchesToolInput } from './gmail-preflight.ts';
import { criterionRegisteredAt } from './result-checks.ts';
import { resultProjection } from './result-projection.ts';

/** Shared syntax/immutability validation, also used to inspect historical ACKs. */
export function validateAndMergeObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  criteria: ObjectiveAcceptanceCriterion[],
  now = Date.now(),
  procedureId?: ObjectiveProcedureId,
): ActiveSessionObjective {
  if (objective.terminalState !== 'active') throw new Error('No active objective');
  if (procedureId && !Object.hasOwn(BUSINESS_PROCEDURES, procedureId)) throw new Error('Unknown business procedure');
  if (objective.procedure && (objective.procedure.version !== 1 || (procedureId && objective.procedure.id !== procedureId))) {
    throw new Error('The registered business procedure cannot be replaced');
  }
  const procedure = objective.procedure ?? (procedureId ? { id: procedureId, version: 1 as const } : undefined);
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 16) throw new Error('Expected 1–16 criteria');
  if (objective.acceptanceNeedsReview) {
    const incoming = new Set(criteria.map(item => item.id));
    const missing = (objective.acceptanceCriteria ?? []).filter(item => !incoming.has(item.id));
    if (missing.length) throw new Error(`Re-register the full amended contract, including existing criterion IDs: ${missing.map(item => item.id).join(', ')}`);
  }
  const byId = new Map((objective.acceptanceNeedsReview ? [] : objective.acceptanceCriteria ?? []).map(item => [item.id, item]));
  const incomingIds = new Set<string>();
  for (const item of criteria) {
    if (item?.requirementId && !procedure) {
      throw new Error(`requirementId "${item.requirementId}" requires a selected business procedure; select procedure or omit requirementId`);
    }
    if (item?.requirementId && procedure) {
      const allowed = BUSINESS_PROCEDURES[procedure.id].requirements.map(requirement => requirement.id);
      if (!allowed.includes(item.requirementId)) {
        throw new Error(`Unknown requirementId "${item.requirementId}" for business procedure "${procedure.id}". Allowed requirementId values: ${allowed.join(', ')}`);
      }
    }
    if (!item || typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id)) {
      throw new Error('Invalid or duplicate criterion id');
    }
    if (item.supersedes !== undefined
      && (typeof item.supersedes !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.supersedes))) {
      throw new Error('Invalid superseded criterion id');
    }
    if (objective.completionCriteria.includes(item.id as never)) {
      throw new Error(`Criterion id "${item.id}" is reserved by the host completion contract; choose a different criterion id`);
    }
    if (incomingIds.has(item.id)) throw new Error('Invalid or duplicate criterion id');
    incomingIds.add(item.id);
    if (typeof item.description !== 'string' || !item.description.trim() || item.description.length > 1000
      || typeof item.toolName !== 'string' || !item.toolName.trim()
      || item.toolName.length > 256 || !item.input || typeof item.input !== 'object' || Array.isArray(item.input)
      || Object.keys(item.input).length < 1
      || Object.keys(item.input).length > 16 || !Array.isArray(item.checks)
      || item.checks.length < 1 || item.checks.length > 16) throw new Error('Incomplete criterion');
    const inputSelectors = new Set<string>();
    for (const [path, value] of Object.entries(item.input)) {
      if (!pathKeys(path)?.length || !isCriterionInputScalar(item.toolName, path, value)
        || inputSelectors.has(selectorIdentity(path))) {
        throw new Error('Invalid JSON selector or scalar');
      }
      inputSelectors.add(selectorIdentity(path));
    }
    const resultSelectors = new Set<string>();
    for (const check of item.checks) {
      if (!check || (check.path !== '$text' && pathKeys(check.path) === undefined)
        || (check.path === '$text' && typeof check.equals !== 'string')
        || !isScalar(check.equals) || resultSelectors.has(selectorIdentity(check.path))) {
        throw new Error('Invalid JSON selector or scalar');
      }
      resultSelectors.add(selectorIdentity(check.path));
    }
    const previous = byId.get(item.id);
    if (previous && criterionIdentity(previous) !== criterionIdentity(item)) throw new Error('Registered criteria cannot be weakened or replaced');
    // Preserve serialized criteria and their review hash on equivalent re-registration.
    if (!previous) byId.set(item.id, structuredClone(item));
  }
  if (byId.size > 16) throw new Error('At most 16 criteria per objective');
  // An equivalent retry changes no contract, review hash or evidence boundary.
  // Returning the same object also lets the host avoid a redundant disk flush.
  if (!objective.acceptanceNeedsReview && byId.size === objective.acceptanceCriteria?.length
    && procedure?.id === objective.procedure?.id && procedure?.version === objective.procedure?.version) return objective;
  const previousIds = new Set((objective.acceptanceCriteria ?? []).map(item => item.id));
  return {
    ...objective,
    ...(procedure ? { procedure } : {}),
    acceptanceCriteria: [...byId.values()],
    acceptanceRegisteredRevision: objective.acceptanceRevision ?? objective.userMessageId,
    ...(objective.acceptanceNeedsReview ? {
      acceptanceNeedsReview: false,
      acceptanceHistory: [...(objective.acceptanceHistory ?? []), {
        revision: objective.acceptanceRegisteredRevision ?? objective.userMessageId,
        criteria: structuredClone(objective.acceptanceCriteria ?? []),
        ...(objective.acceptanceRegisteredAt !== undefined ? { registeredAt: objective.acceptanceRegisteredAt } : {}),
        registeredAtById: Object.fromEntries((objective.acceptanceCriteria ?? []).map(item => [
          item.id, criterionRegisteredAt(objective, item.id),
        ])),
      }],
    } : {}),
    acceptanceRegisteredAt: now,
    // Keep registration timestamps as immutable contract provenance. Evidence
    // evaluation uses the objective boundary plus target-relevant mutations,
    // so registering an exact predicate never forces a duplicate observation.
    acceptanceRegisteredAtById: Object.fromEntries([...byId.keys()].map(id => [
      id, !objective.acceptanceNeedsReview && previousIds.has(id) ? criterionRegisteredAt(objective, id) : now,
    ])),
  };
}

export function nextCriterionVersionId(previousId: string): string {
  const versioned = /^(.*)_v([1-9]\d*)$/.exec(previousId);
  if (!versioned) return `${previousId}_v2`;
  const version = Number(versioned[2]);
  return `${versioned[1]}_v${version + 1}`;
}

export function assertObservedCriterionResultShapes(
  objective: ActiveSessionObjective,
  criteria: readonly ObjectiveAcceptanceCriterion[],
  messages: readonly Message[] | undefined,
  expectedSessionId?: string,
): void {
  if (!messages?.length) return;
  const rootIndex = messages.findIndex(message => message.role === 'user' && message.id === objective.userMessageId);
  if (rootIndex < 0) return;
  const scoped = messages.slice(rootIndex + 1);
  for (const criterion of criteria) {
    if (criterion.checks.every(check => check.path === '$text')) continue;
    const observed = scoped.findLast(message => message.role === 'tool' && !!message.toolName
      && canonicalToolName(message.toolName) === canonicalToolName(criterion.toolName)
      && criterionInputMatchesToolInput(criterion, message.toolInput)
      && isObjectiveToolExecutedSuccessfully(message) && !isObjectiveCoordinationTool(message)
      && message.toolResult !== undefined);
    const projection = observed ? resultProjection(observed, true, expectedSessionId) : undefined;
    if (observed && (projection === undefined
      || criterion.checks.some(check => check.path !== '$text' && atPath(projection, check.path) === undefined))) {
      throw new Error(`Criterion ${criterion.id} uses JSON result selectors, but the exact observed ${criterion.toolName} invocation returned text without a supported structured projection for every requested selector. Use $text for exact whole-output equality, check $.transport.code/$.transport.success for native shell transport, or make the read-only check emit valid JSON. Nothing was registered.`);
    }
  }
}

/** Evaluation-only repair with a verifiable, value-free provenance diagnostic. */
export function projectObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  messages: readonly Message[],
): ObjectiveAcceptanceCriteriaProjection & { gscSiteIdentity?: LegacyGscSiteIdentity } {
  const validateOriginal = (criteria: ObjectiveAcceptanceCriterion[]) => {
    try {
      // Historical attestation checks syntax and identity, not today's
      // admission policy. Old contradictory equalities remain contradictory.
      const historical: ActiveSessionObjective = { ...objective, terminalState: 'active' };
      delete historical.acceptanceCriteria;
      validateAndMergeObjectiveAcceptanceCriteria(historical, criteria,
        objective.acceptanceRegisteredAt);
      return true;
    } catch { return false; }
  };
  const projection = recoverLegacyAcceptanceScalars(objective, messages, validateOriginal)
    ?? { criteria: objective.acceptanceCriteria ?? [] };
  const gscSiteIdentity = recoverLegacyGscSiteIdentity(objective, messages, validateOriginal);
  return { ...projection, ...(gscSiteIdentity !== undefined ? { gscSiteIdentity } : {}) };
}
