import { createHash } from 'node:crypto';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { getDelegatedReviewRequest } from './delegated-review-outcome.ts';

export type ReviewDelegationDecision = { allowed: true } | {
  allowed: false;
  reason: 'review-of-review';
  message: string;
};

/** Pure host admission check. Never uses assistant verdicts as authority. */
export function evaluateReviewDelegation(input: {
  parentSessionId?: string;
  objective: ActiveSessionObjective;
  prompt: string;
  proposedRole?: 'worker' | 'reviewer';
  sourceSlugs?: readonly string[];
  /** Host-verified conflicting completed reviews, never a model supplied override. */
  arbitration?: { verifiedConflictingReviewIds: readonly string[] };
}): ReviewDelegationDecision {
  if (!input.parentSessionId || !input.objective.originalText) return { allowed: true };
  const current = getDelegatedReviewRequest(
    input.objective.originalText,
    input.sourceSlugs,
    input.objective.delegatedRole,
  );
  const proposed = getDelegatedReviewRequest(input.prompt, input.sourceSlugs);
  if (!current) return { allowed: true };
  if (input.arbitration && new Set(input.arbitration.verifiedConflictingReviewIds.filter(Boolean)).size >= 2) return { allowed: true };
  // A host-bound reviewer already owns one immutable review contract. Unlike a
  // worker, it must never turn a changed target/version in model-authored prose
  // into authority for another reviewer: that is still a review of its own
  // completion. Only the host may open an arbitration after verifying two
  // genuinely conflicting completed reviews.
  if (current.hostBound && input.objective.delegatedRole === 'reviewer'
    && (input.proposedRole === 'reviewer' || proposed !== undefined)) {
    return { allowed: false, reason: 'review-of-review', message:
      'This host-bound task already is the independent reviewer. Do not delegate another review, even with a changed target or version. Inspect the immutable host checks yourself and return the requested PASS or substantiated FAIL. Only host-verified arbitration between two conflicting completed reviews may create another reviewer.' };
  }
  if (!proposed) return { allowed: true };
  // A worker may delegate a distinct target, version, or concrete extraction.
  // Only reviewing its own review objective on the same target/version is a
  // recursive completion dependency. No arbitrary tree-depth limit applies.
  if (proposed.objectiveId !== (input.objective.objectiveId ?? input.objective.userMessageId)
    || proposed.target !== current.target || proposed.revision !== current.revision
    || JSON.stringify(proposed.remote) !== JSON.stringify(current.remote)) return { allowed: true };
  return { allowed: false, reason: 'review-of-review', message:
    'This task already delivers an independent read-only review. Do not create another review of your own completion on the same target/version. Inspect the registered checks and return the requested PASS or substantiated FAIL with its original binding. A distinct investigation, changed target/version, or host-verified arbitration remains available; this does not certify the parent result.' };
}

/** No trimming/coercion: only exactly equivalent requests share an active child. */
export function makeActiveDelegationKey(input: {
  workspaceId: string;
  rootObjectiveId: string;
  parentObjectiveId: string;
  prompt: string;
  /** Effective host configuration, including transport, permissions, model, sources and attachments. */
  targetConfiguration: Record<string, unknown>;
}): string | undefined {
  if (!input.workspaceId || !input.rootObjectiveId || !input.parentObjectiveId || !input.prompt) return undefined;
  const seen = new Set<object>();
  function canonical(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Non-JSON configuration');
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(canonical);
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Non-JSON configuration');
      return Object.fromEntries(Object.keys(value).sort().map(key => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !('value' in property)) throw new Error('Non-data configuration');
        return [key, canonical(property.value)];
      }));
    } finally { seen.delete(value); }
  }
  try {
    return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
  } catch { return undefined; } // Unknown configuration means no deduplication, never a guessed match.
}

/** Share in-flight creation and an active child, never a finished verdict or PASS. */
export class ActiveDelegationDeduplicator<T extends { sessionId: string }> {
  private readonly entries = new Map<string, { promise: Promise<T>; value?: T }>();

  async run(key: string | undefined, create: () => Promise<T>, isActive: (sessionId: string) => boolean): Promise<{ value: T; reused: boolean }> {
    if (!key) return { value: await create(), reused: false };
    for (const [candidate, entry] of this.entries) {
      if (entry.value && !isActive(entry.value.sessionId)) this.entries.delete(candidate);
    }
    const existing = this.entries.get(key);
    if (existing) return { value: await existing.promise, reused: true };
    const entry: { promise: Promise<T>; value?: T } = { promise: Promise.resolve().then(create) };
    this.entries.set(key, entry);
    try {
      const value = await entry.promise;
      entry.value = value;
      return { value, reused: false };
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  release(sessionId: string): void {
    for (const [key, entry] of this.entries) if (entry.value?.sessionId === sessionId) this.entries.delete(key);
  }
}
