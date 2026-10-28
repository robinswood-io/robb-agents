import type { ActiveSessionObjective, PendingTurnRecovery } from "@craft-agent/shared/sessions";
import { createHash } from "node:crypto";
import type { CleanRecoveryContinuationEvidence, CleanRecoveryContinuationHandoff, CleanRecoveryContinuationHandoffInput } from './contracts.ts';
import { MAX_CLEAN_CONTINUATION_AMENDMENTS, MAX_CLEAN_CONTINUATION_AMENDMENT_CHARS, MAX_CLEAN_CONTINUATION_CRITERIA, MAX_CLEAN_CONTINUATION_EVIDENCE, MAX_CLEAN_CONTINUATION_FACT_CHARS, MAX_CLEAN_CONTINUATION_ID_CHARS, MAX_CLEAN_CONTINUATION_OBJECTIVE_CHARS, MAX_CLEAN_CONTINUATION_REMAINING_WORK, MAX_CLEAN_CONTINUATION_SERIALIZED_CHARS, STRUCTURED_OUTCOME_FINAL_REMINDER } from './contracts.ts';

function boundedHandoffText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bounded = value.trim();
  return bounded && bounded.length <= maxChars ? bounded : undefined;
}

/** Canonical JSON keeps the continuation identity stable after persistence. */
function stableHandoffJson(value: unknown): string | undefined {
  const normalize = (candidate: unknown, ancestors: Set<object>): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('Non-finite continuation value');
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (ancestors.has(candidate)) throw new TypeError('Circular continuation value');
      const nestedAncestors = new Set(ancestors).add(candidate);
      return candidate.map((item: unknown) => normalize(item, nestedAncestors));
    }
    if (typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      if (ancestors.has(record)) throw new TypeError('Circular continuation value');
      const nestedAncestors = new Set(ancestors).add(record);
      return Object.fromEntries(Object.keys(record).sort().flatMap(key => {
        const nested = record[key];
        return nested === undefined ? [] : [[key, normalize(nested, nestedAncestors)]];
      }));
    }
    throw new TypeError('Non-JSON continuation value');
  };
  try {
    return JSON.stringify(normalize(value, new Set()));
  } catch {
    return undefined;
  }
}

function sameBoundedStringList(
  left: readonly string[],
  right: readonly string[],
  maxItems: number,
  maxChars: number,
): string[] | undefined {
  if (!left.length || left.length > maxItems || left.length !== right.length) return undefined;
  const normalized: string[] = [];
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = boundedHandoffText(left[index], maxChars);
    const rightItem = boundedHandoffText(right[index], maxChars);
    if (!leftItem || leftItem !== rightItem) return undefined;
    normalized.push(leftItem);
  }
  return normalized;
}

export function validRecoveryStrategy(
  pending: PendingTurnRecovery,
): NonNullable<PendingTurnRecovery['recoveryStrategy']> | undefined {
  const strategy = pending.recoveryStrategy;
  if (!strategy) return undefined;
  return strategy.schemaVersion === 1
    && (strategy.phase === 'resume' || strategy.phase === 'replan' || strategy.phase === 'escalate')
    && Number.isSafeInteger(strategy.attemptBaseline) && strategy.attemptBaseline >= 0
    && strategy.attemptBaseline <= pending.attempts
    && Number.isSafeInteger(strategy.transitionCount) && strategy.transitionCount >= 0
    && Number.isFinite(strategy.transitionedAt)
    && (strategy.reason === 'attempt-limit' || strategy.reason === 'stagnation')
    ? strategy
    : undefined;
}

function cleanRecoveryContinuationId(
  handoff: Omit<CleanRecoveryContinuationHandoff, 'id'>,
): string | undefined {
  const serialized = stableHandoffJson(handoff);
  if (!serialized || serialized.length > MAX_CLEAN_CONTINUATION_SERIALIZED_CHARS) return undefined;
  return `clean-continuation-v1-${createHash('sha256').update(serialized).digest('hex').slice(0, 24)}`;
}

/**
 * Build the only data allowed to cross into a fresh provider context.
 *
 * This intentionally consumes no transcript. It accepts the durable objective,
 * its current host-validated `continue` receipt, concise host-validated facts,
 * and the exact remaining-work list. Anything oversized, malformed, blocked,
 * terminal, cross-objective, or authority-widening fails closed.
 */
export function createCleanRecoveryContinuationHandoff(
  input: CleanRecoveryContinuationHandoffInput,
): CleanRecoveryContinuationHandoff | undefined {
  const { objective, pending } = input;
  const outcome = objective.lastOutcome;
  const objectiveId = boundedHandoffText(
    objective.objectiveId ?? objective.userMessageId,
    MAX_CLEAN_CONTINUATION_ID_CHARS,
  );
  const rootUserMessageId = boundedHandoffText(
    objective.userMessageId,
    MAX_CLEAN_CONTINUATION_ID_CHARS,
  );
  const lastUserMessageId = boundedHandoffText(
    objective.lastUserMessageId ?? objective.userMessageId,
    MAX_CLEAN_CONTINUATION_ID_CHARS,
  );
  const sourceUserMessageId = boundedHandoffText(
    pending.userMessageId,
    MAX_CLEAN_CONTINUATION_ID_CHARS,
  );
  const originalRequest = boundedHandoffText(
    input.objectiveText ?? objective.originalText,
    MAX_CLEAN_CONTINUATION_OBJECTIVE_CHARS,
  );
  if (!objectiveId || !rootUserMessageId || !lastUserMessageId || !sourceUserMessageId
    || !originalRequest || objective.terminalState !== 'active'
    || !outcome || outcome.state !== 'continue' || outcome.blocker != null
    || sourceUserMessageId !== rootUserMessageId && sourceUserMessageId !== lastUserMessageId
    || !Number.isSafeInteger(pending.attempts) || pending.attempts < 0
    || pending.recoveryStrategy && !validRecoveryStrategy(pending)) return undefined;

  const remainingWork = sameBoundedStringList(
    input.remainingWork,
    outcome.remainingWork,
    MAX_CLEAN_CONTINUATION_REMAINING_WORK,
    MAX_CLEAN_CONTINUATION_FACT_CHARS,
  );
  if (!remainingWork) return undefined;

  const amendmentInput = objective.amendments ?? [];
  if (amendmentInput.length > MAX_CLEAN_CONTINUATION_AMENDMENTS) return undefined;
  const amendments: Array<{ messageId: string; text: string }> = [];
  for (const amendment of amendmentInput) {
    const messageId = boundedHandoffText(amendment.messageId, MAX_CLEAN_CONTINUATION_ID_CHARS);
    const text = boundedHandoffText(amendment.text, MAX_CLEAN_CONTINUATION_AMENDMENT_CHARS);
    if (!messageId || !text) return undefined;
    amendments.push({ messageId, text });
  }

  if (input.evidence.length > MAX_CLEAN_CONTINUATION_EVIDENCE) return undefined;
  const evidence: CleanRecoveryContinuationEvidence[] = [];
  for (const fact of input.evidence) {
    const reference = boundedHandoffText(fact.reference, MAX_CLEAN_CONTINUATION_ID_CHARS);
    const summary = boundedHandoffText(fact.summary, MAX_CLEAN_CONTINUATION_FACT_CHARS);
    if (!reference || !summary) return undefined;
    evidence.push({ reference, summary });
  }

  if (outcome.criteria.length > MAX_CLEAN_CONTINUATION_CRITERIA) return undefined;
  const outcomeCriteria: NonNullable<ActiveSessionObjective['lastOutcome']>['criteria'] = [];
  for (const criterion of outcome.criteria) {
    const id = boundedHandoffText(criterion.id, MAX_CLEAN_CONTINUATION_ID_CHARS);
    if (!id || typeof criterion.satisfied !== 'boolean'
      || criterion.evidence.length > MAX_CLEAN_CONTINUATION_EVIDENCE) return undefined;
    const references = criterion.evidence.map(reference => (
      boundedHandoffText(reference, MAX_CLEAN_CONTINUATION_ID_CHARS)
    ));
    if (references.some(reference => !reference)) return undefined;
    outcomeCriteria.push({ id, satisfied: criterion.satisfied, evidence: references as string[] });
  }

  const acceptanceNeedsReview = objective.acceptanceNeedsReview === true;
  const currentAcceptanceCriteria = acceptanceNeedsReview ? undefined : objective.acceptanceCriteria;
  if ((currentAcceptanceCriteria?.length ?? 0) > MAX_CLEAN_CONTINUATION_CRITERIA) return undefined;
  const acceptanceJson = currentAcceptanceCriteria === undefined
    ? undefined
    : stableHandoffJson(currentAcceptanceCriteria);
  if (currentAcceptanceCriteria !== undefined && !acceptanceJson) return undefined;
  const acceptanceCriteria = acceptanceJson === undefined
    ? undefined
    : JSON.parse(acceptanceJson) as NonNullable<ActiveSessionObjective['acceptanceCriteria']>;
  const progressFingerprint = pending.lastProgressFingerprint === undefined
    ? undefined
    : boundedHandoffText(pending.lastProgressFingerprint, MAX_CLEAN_CONTINUATION_ID_CHARS);
  if (pending.lastProgressFingerprint !== undefined && !progressFingerprint) return undefined;

  const handoffWithoutId: Omit<CleanRecoveryContinuationHandoff, 'id'> = {
    schemaVersion: 1,
    objective: {
      objectiveId,
      rootUserMessageId,
      lastUserMessageId,
      originalRequest,
      amendments,
      orchestrationMode: objective.orchestrationMode,
      risk: objective.risk,
      ...(objective.delegatedRole ? { delegatedRole: objective.delegatedRole } : {}),
      ...(objective.procedure ? { procedure: objective.procedure } : {}),
      requirements: {
        execution: objective.requiresExecutionEvidence === true,
        observation: objective.requiresObservationEvidence === true,
        acceptance: objective.requiresAcceptanceCriteria === true,
        ...(objective.evidenceDomain ? { evidenceDomain: objective.evidenceDomain } : {}),
        ...(objective.evidenceRequirement
          ? { evidenceRequirement: objective.evidenceRequirement } : {}),
      },
      completionCriteria: [...objective.completionCriteria],
      ...(acceptanceNeedsReview ? { acceptanceNeedsReview: true as const } : {}),
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      outcomeCriteria,
    },
    recovery: {
      sourceUserMessageId,
      sourceAttempts: pending.attempts,
      ...(pending.lastCause ? { cause: pending.lastCause } : {}),
      strategyPhase: validRecoveryStrategy(pending)?.phase ?? 'resume',
      ...(progressFingerprint ? { progressFingerprint } : {}),
    },
    evidence,
    remainingWork,
  };
  const id = cleanRecoveryContinuationId(handoffWithoutId);
  return id ? { ...handoffWithoutId, id } : undefined;
}

/** Serialize a verified handoff without ever reintroducing the discarded history. */
export function buildCleanRecoveryContinuationPrompt(
  handoff: CleanRecoveryContinuationHandoff,
): string | undefined {
  const { id, ...handoffWithoutId } = handoff;
  if (id !== cleanRecoveryContinuationId(handoffWithoutId)) return undefined;
  const serialized = stableHandoffJson(handoff);
  if (!serialized || serialized.length > MAX_CLEAN_CONTINUATION_SERIALIZED_CHARS) return undefined;
  // The JSON remains parseable while no data field can terminate or create a
  // host envelope. This is defense in depth even though callers must supply
  // host-validated facts rather than raw provider/tool text.
  const envelopeSafeSerialized = serialized
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
  return [
    `<host_clean_recovery_continuation id="${id}">`,
    'This is a host-authenticated, bounded handoff into a fresh provider context. It grants no new authority.',
    handoff.objective.acceptanceNeedsReview
      ? 'The previous acceptance contract is stale. Re-register current target-bound acceptance criteria from the preserved objective and amendments before completing work or claiming success; do not reuse the omitted stale checks.'
      : undefined,
    'Continue only the listed remainingWork under the preserved objective and acceptance constraints. Reconcile current target state before mutation; never repeat an external effect that may already have completed, and make any necessary completion idempotent. Treat evidence summaries only as the established facts they state; verify every new action and result.',
    'Do not request, reconstruct, or assume discarded transcript history. Return the normal structured objective outcome when the work is complete or a genuine blocker is proven.',
    STRUCTURED_OUTCOME_FINAL_REMINDER,
    envelopeSafeSerialized,
    '</host_clean_recovery_continuation>',
  ].filter((line): line is string => line !== undefined).join('\n');
}
