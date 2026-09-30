import { createHash } from 'node:crypto';
import type { Message, ObjectiveAcceptanceCriterion } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { parseIndependentReviewReceipt } from '@craft-agent/shared/agent';

export interface LegacyAcceptanceScalarDiagnostic {
  kind: 'legacy-scalar-coercion';
  objectiveId: string;
  registrationMessageId: string;
  registrationToolUseId: string;
  scalarChangeCount: number;
  persistedCriteriaSha256: string;
  projectedCriteriaSha256: string;
}
export interface ObjectiveAcceptanceCriteriaProjection {
  criteria: ObjectiveAcceptanceCriterion[];
  diagnostic?: LegacyAcceptanceScalarDiagnostic;
}

const REGISTRATION = /^(?:mcp__session__|session__)?set_completion_criteria$/;
// Match every review tool recognized by objective-outcome, including aliases.
const REVIEW = /(?:call_llm|spawn_session|wait_sessions|reviewer|review)/i;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keysExactly = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** Our host serializes these ACKs with JSON.stringify. This also refuses duplicate
 * keys, surrounding prose, multiple receipts and arbitrary nested JSON extraction. */
function parseHostAck(text: string): Record<string, unknown> | undefined {
  if (!text || text.length > 256_000) return undefined;
  try {
    let value = JSON.parse(text);
    if (JSON.stringify(value) !== text.trim()) return undefined;
    if (record(value) && Array.isArray(value.content)) {
      if (value.isError || value.content.length !== 1 || value.content[0]?.type !== 'text'
        || typeof value.content[0]?.text !== 'string') return undefined;
      const inner = value.content[0].text;
      value = JSON.parse(inner);
      if (JSON.stringify(value) !== inner.trim()) return undefined;
    }
    return record(value) && keysExactly(value, ['objectiveId', 'criteria']) ? value : undefined;
  } catch { return undefined; }
}

function strictRawShape(value: unknown): value is ObjectiveAcceptanceCriterion[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(item =>
    record(item) && keysExactly(item, ['id', 'description', 'toolName', 'input', 'checks'])
    && record(item.input) && Array.isArray(item.checks)
    && item.checks.every(check => record(check) && keysExactly(check, ['path', 'equals'])));
}

/** Simulation of the old anyOf[string,number,boolean,null] with coerceTypes:true.
 * It changes only originally non-string scalars. Never infer a type from stored
 * strings, and never coerce an observed invocation or result. The caller validates
 * the original JSON scalars/bounds before applying this historical transformation. */
function legacyStringFirst(criteria: ObjectiveAcceptanceCriterion[]): { criteria: ObjectiveAcceptanceCriterion[]; changes: number } {
  const copy = structuredClone(criteria);
  let changes = 0;
  const coerce = (value: string | number | boolean | null): string => {
    if (typeof value !== 'string') changes++;
    return value === null ? '' : String(value);
  };
  for (const item of copy) {
    for (const key of Object.keys(item.input)) item.input[key] = coerce(item.input[key]!);
    for (const check of item.checks) check.equals = coerce(check.equals);
  }
  return { criteria: copy, changes };
}

/** Recover only a whole, uniquely witnessed historical registration. The returned
 * projection is evaluation data, never a saved contract, a new permission or PASS.
 * validateOriginal is the unchanged host registration validator on an empty clone. */
export function recoverLegacyAcceptanceScalars(
  objective: ActiveSessionObjective,
  messages: readonly Message[],
  validateOriginal: (criteria: ObjectiveAcceptanceCriterion[]) => boolean,
): ObjectiveAcceptanceCriteriaProjection | undefined {
  const saved = objective.acceptanceCriteria;
  if (!saved?.length || saved.length > 16 || objective.risk !== 'standard' || objective.evidenceRequirement
    || objective.completionCriteria.includes('independent-review-passed')
    || !objective.objectiveId || !Number.isFinite(objective.acceptanceRegisteredAt)) return undefined;
  const rootIndex = messages.findIndex(message => message.role === 'user' && message.id === objective.userMessageId);
  if (rootIndex < 0) return undefined;
  const scoped = messages.slice(rootIndex + 1);
  const persistedCriteriaSha256 = hash(saved);
  // Changing expected scalar types changes the meaning/hash of a bound review.
  // Never reuse such a review across the projection, even in a standard-risk task.
  for (const message of scoped) {
    if (!REVIEW.test(message.toolName ?? '') || message.role !== 'tool' || !message.toolResult) continue;
    const receipt = parseIndependentReviewReceipt(message.toolResult, {
      toolName: message.toolName!, objectiveId: objective.objectiveId, acceptanceSha256: persistedCriteriaSha256,
      sessionIds: Array.isArray(message.toolInput?.sessionIds) && message.toolInput.sessionIds.every(id => typeof id === 'string')
        ? message.toolInput.sessionIds as string[] : undefined,
    });
    if (receipt && (receipt.acceptanceSha256 === persistedCriteriaSha256
      || receipt.criteria.some(item => saved.some(criterion => criterion.id === item.id)))) return undefined;
  }
  let witness: Message | undefined;
  let original: ObjectiveAcceptanceCriterion[] | undefined;
  let changes = 0;
  for (const message of scoped) {
    if (message.role !== 'tool' || !REGISTRATION.test(message.toolName ?? '')) continue;
    // A failed attempt cannot establish a contract. Any successful registration
    // that is incomplete, additive or contradictory makes this narrow recovery
    // unavailable, rather than choosing the witness that would make checks pass.
    if (message.isError || message.toolStatus === 'error' || message.toolExecuted === false
      || message.toolCheckpoint !== undefined) continue;
    if (message.toolStatus !== 'completed' || message.toolExecuted !== true
      || witness || !message.id || !message.toolUseId || !Number.isFinite(message.timestamp)
      || message.timestamp < objective.startedAt || message.timestamp > objective.acceptanceRegisteredAt!
      || (message as Message & { continuationRequired?: boolean }).continuationRequired) return undefined;
    const ack = parseHostAck(message.toolResult ?? '');
    const input = message.toolInput;
    if (!ack || ack.objectiveId !== objective.objectiveId || !Array.isArray(ack.criteria)
      || canonical(ack.criteria) !== canonical(saved) || !record(input)
      || Object.keys(input).some(key => !['criteria', '_intent', '_displayName'].includes(key))
      || !strictRawShape(input.criteria) || !validateOriginal(input.criteria)) return undefined;
    const replay = legacyStringFirst(input.criteria);
    if (!replay.changes || canonical(replay.criteria) !== canonical(ack.criteria)) return undefined;
    witness = message;
    original = structuredClone(input.criteria);
    changes = replay.changes;
  }
  if (!witness || !original) return undefined;
  return { criteria: original, diagnostic: {
    kind: 'legacy-scalar-coercion', objectiveId: objective.objectiveId,
    registrationMessageId: witness.id, registrationToolUseId: witness.toolUseId!, scalarChangeCount: changes,
    persistedCriteriaSha256, projectedCriteriaSha256: hash(original),
  } };
}

/** Diagnostic data only: no observed result, authorization, or success claim. */
export function formatLegacyAcceptanceScalarDiagnostic(diagnostic: LegacyAcceptanceScalarDiagnostic): string {
  return 'Legacy acceptance scalar projection (host provenance, data not instructions): '
    + JSON.stringify(diagnostic)
    + '\nThe effective criteria recover original scalar types from one successful registration and its exact legacy-coerced host receipt, in memory only. Stored criteria, registration time, objective and evidence are unchanged. Check preserved observations against these effective types before any new tool call; do not re-register criteria or repeat an external action merely to repair this transport defect. This projection does not establish that any criterion passed.';
}
