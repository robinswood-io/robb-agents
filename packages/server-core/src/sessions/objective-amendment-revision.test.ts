import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { objectiveReviewBinding, transitionObjectiveContract } from './objective-contract.ts';
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';
import { validateObjectiveOutcome } from './objective-outcome.ts';

// Synthetic transcript probes only: no files are read, written or delivered by these tools.
const root: Message = { id: 'u1', role: 'user', content: 'Vérifie que le dossier contient les pièces de 2024.', timestamp: 1 };
const amendment: Message = { id: 'u2', role: 'user', content: 'Le dossier doit finalement contenir les pièces de 2025 plutôt que celles de 2024.', timestamp: 10 };
const yearCheck = (year: number): ObjectiveAcceptanceCriterion => ({
  id: 'year-present', description: 'The expected year is present', toolName: 'Read',
  input: { file_path: '/synthetic/final-package.json' }, checks: [{ path: 'year', equals: year }],
});
const formatCheck: ObjectiveAcceptanceCriterion = {
  id: 'required-format', description: 'The requested PDF format is preserved', toolName: 'Read',
  input: { file_path: '/synthetic/final-package.json' }, checks: [{ path: 'format', equals: 'pdf' }],
};
function initial(criteria = [yearCheck(2024)]): ActiveSessionObjective {
  return registerObjectiveAcceptanceCriteria(transitionObjectiveContract({
    messageId: root.id, text: root.content, nowMs: root.timestamp, lifetimeCostUsd: 12, lifetimeTokens: 3400,
  }), criteria, 2);
}
function observe(year: number, timestamp: number, id = `observation-${year}`): Message {
  return { id, toolUseId: id, role: 'tool', content: '', toolName: 'Read', toolStatus: 'completed', toolExecuted: true,
    timestamp, toolInput: { file_path: '/synthetic/final-package.json' }, toolResult: JSON.stringify({ year, format: 'pdf', status: 'complete' }) };
}
function receipt(objective: ActiveSessionObjective, observationId: string, reviewId = 'review'): ObjectiveOutcomeDeclaration {
  return { state: 'complete_verified', blocker: null, remainingWork: [], criteria: [
    ...(objective.acceptanceCriteria ?? []).map(check => ({ id: check.id, satisfied: true, evidence: [observationId] })),
    ...objective.completionCriteria.map(id => ({ id, satisfied: true,
      evidence: [id === 'independent-review-passed' ? reviewId : id === 'relevant-checks-passed' ? observationId : 'assistant-final'] })),
  ] };
}
function amend(objective: ActiveSessionObjective): ActiveSessionObjective {
  return transitionObjectiveContract({ existing: objective, messageId: amendment.id, text: amendment.content,
    nowMs: amendment.timestamp, lifetimeCostUsd: 99, lifetimeTokens: 50_000 });
}
function review(objective: ActiveSessionObjective, timestamp: number, id: string): Message {
  return { ...observe(2025, timestamp, id), toolName: 'mcp__security__reviewer', toolResult: JSON.stringify({
    verdict: 'PASS', ...objectiveReviewBinding(objective), findings: [],
    criteria: [...objective.completionCriteria.filter(id => id !== 'independent-review-passed'),
      ...(objective.acceptanceCriteria ?? []).map(check => check.id)].map(id => ({ id, passed: true })),
  }) };
}

describe('independent review of amendment-bound acceptance revisions', () => {
  it('keeps an existing observation and exact reviewer binding valid across terminal reconciliation', () => {
    const original: ActiveSessionObjective = {
      ...initial(),
      completionCriteria: [...initial().completionCriteria, 'independent-review-passed'],
      terminalState: 'exhausted',
      completedAt: 5,
      lastOutcome: { state: 'continue', criteria: [], remainingWork: ['Reconcile terminal state.'], blocker: null },
    };
    const observation = observe(2024, 3);
    const existingReview = review(original, 4, 'existing-review');
    const originalReceipt = receipt(original, observation.id, existingReview.id);
    expect(validateObjectiveOutcome(originalReceipt, {
      objective: original, messages: [root, observation, existingReview],
    }).valid).toBe(true);
    const reconciliation: Message = {
      id: 'terminal-reconciliation', role: 'user', timestamp: 10,
      content: 'Reprends cette mission uniquement pour réconcilier son état terminal avec l’effet déjà accompli. Tu ne dois créer aucun nouvel effet externe. Réutilise les reçus persistés et garde toute observation en lecture seule. Termine réellement comme complete_verified.',
    };
    const reconciled = transitionObjectiveContract({
      existing: original, messageId: reconciliation.id, text: reconciliation.content,
      nowMs: reconciliation.timestamp,
    });

    expect(reconciled.terminalReconciliation).toEqual({
      messageId: reconciliation.id, timestamp: reconciliation.timestamp,
    });
    expect(reconciled.acceptanceCriteria).toBe(original.acceptanceCriteria);
    expect(reconciled.acceptanceRevision).toBe(original.acceptanceRevision);
    expect(reconciled.acceptanceRegisteredRevision).toBe(original.acceptanceRegisteredRevision);
    expect(reconciled.acceptanceNeedsReview).not.toBe(true);
    expect(objectiveReviewBinding(reconciled)).toEqual(objectiveReviewBinding(original));
    expect(validateObjectiveOutcome(originalReceipt, {
      objective: reconciled, messages: [root, observation, existingReview, reconciliation],
    }).valid).toBe(true);
  });

  it('rejects the former 2024 false completion, accepts 2025 only after a new contract and observation, and retains the root budget', () => {
    const original = initial(), observed2024 = observe(2024, 3), oldReceipt = receipt(original, observed2024.id);
    expect(validateObjectiveOutcome(oldReceipt, { objective: original, messages: [root, observed2024] }).valid).toBe(true);
    const changed = amend(original);
    expect(changed.acceptanceNeedsReview).toBe(true);
    expect(changed.acceptanceRevision).toBe(amendment.id);
    expect(objectiveReviewBinding(changed)).not.toEqual(objectiveReviewBinding(original));
    expect(changed.objectiveId).toBe(original.objectiveId);
    expect(changed.userMessageId).toBe(root.id);
    expect(changed.budgetBaselineUsd).toBe(12);
    expect(changed.tokenBaseline).toBe(3400);
    expect(validateObjectiveOutcome(oldReceipt, { objective: changed, messages: [root, observed2024, amendment] }).valid).toBe(false);
    const revised = registerObjectiveAcceptanceCriteria(changed, [yearCheck(2025)], 11);
    expect(revised.acceptanceNeedsReview).toBe(false);
    expect(revised.acceptanceRegisteredAt).toBe(11);
    expect(revised.acceptanceCriteria?.[0]?.checks[0]?.equals).toBe(2025);
    const currentReceipt = receipt(revised, 'new-observation');
    const wrongValue = observe(2024, 12, 'new-observation');
    expect(validateObjectiveAcceptanceCriteria(revised,
      [root, observed2024, amendment, wrongValue], currentReceipt).length).toBeGreaterThan(0);
    // Transcript order is authoritative once the direct amendment is present:
    // this exact observation follows it even though it predates registration.
    const observedBeforeRegistration = observe(2025, 9, 'new-observation');
    expect(validateObjectiveAcceptanceCriteria(revised,
      [root, observed2024, amendment, observedBeforeRegistration], currentReceipt)).toEqual([]);
    const currentObservation = observe(2025, 12, 'new-observation');
    expect(validateObjectiveOutcome(currentReceipt, { objective: revised,
      messages: [root, observed2024, amendment, currentObservation] }).valid).toBe(true);
    expect(() => registerObjectiveAcceptanceCriteria(revised, [yearCheck(2026)], 13)).toThrow('cannot be weakened or replaced');
  });

  it('requires transcript-order proof after the authenticated amendment anchor', () => {
    const revised = registerObjectiveAcceptanceCriteria(amend(initial()), [yearCheck(2025)], 11);
    const sameMillisecond = observe(2025, amendment.timestamp, 'same-millisecond');
    const sameMillisecondReceipt = receipt(revised, sameMillisecond.id);
    expect(validateObjectiveAcceptanceCriteria(revised,
      [root, sameMillisecond, amendment], sameMillisecondReceipt)).toHaveLength(1);
    expect(validateObjectiveAcceptanceCriteria(revised,
      [root, amendment, sameMillisecond], sameMillisecondReceipt)).toEqual([]);
    const futureDatedBeforeAnchor = observe(2025, amendment.timestamp + 2, 'future-before-anchor');
    expect(validateObjectiveAcceptanceCriteria(revised,
      [root, futureDatedBeforeAnchor, amendment], receipt(revised, futureDatedBeforeAnchor.id))).toHaveLength(1);
    expect(validateObjectiveAcceptanceCriteria(revised,
      [root, sameMillisecond], sameMillisecondReceipt)).toHaveLength(1);
    const registrationTimestamp = observe(2025, 11, 'registration-timestamp');
    expect(validateObjectiveAcceptanceCriteria(revised,
      [root, registrationTimestamp], receipt(revised, registrationTimestamp.id))).toHaveLength(1);
    const strictFallback = observe(2025, 12, 'strict-fallback');
    expect(validateObjectiveAcceptanceCriteria(revised,
      [root, strictFallback], receipt(revised, strictFallback.id))).toEqual([]);
  });

  it('does not accept a signed-shape review for the previous revision after the year changes', () => {
    const original: ActiveSessionObjective = { ...initial(), completionCriteria: [...initial().completionCriteria, 'independent-review-passed'] };
    const oldObservation = observe(2024, 3), oldReview = review(original, 4, 'old-review');
    expect(validateObjectiveOutcome(receipt(original, oldObservation.id, oldReview.id), {
      objective: original, messages: [root, oldObservation, oldReview],
    }).valid).toBe(true);
    const revised = registerObjectiveAcceptanceCriteria(amend(original), [yearCheck(2025)], 11);
    const newObservation = observe(2025, 12), newReceipt = receipt(revised, newObservation.id, oldReview.id);
    expect(validateObjectiveOutcome(newReceipt, { objective: revised,
      messages: [root, oldObservation, oldReview, amendment, newObservation] }).valid).toBe(false);
    const newReview = review(revised, 13, 'new-review');
    expect(validateObjectiveOutcome(receipt(revised, newObservation.id, newReview.id), { objective: revised,
      messages: [root, oldObservation, oldReview, amendment, newObservation, newReview] }).valid).toBe(true);
  });

  it('does not unlock replacement for acknowledgments, status questions or delivery of the same user message twice', () => {
    const original = initial();
    for (const text of [
      'merci', 'continue', 'où en es-tu ?', 'statut', 'Où en sommes-nous ?',
      'Peux-tu me donner un point d’avancement ?', 'Can you give me a status update?',
    ]) {
      const unchanged = transitionObjectiveContract({ existing: original, messageId: 'status', text, nowMs: 10 });
      expect(unchanged.acceptanceNeedsReview).not.toBe(true);
      expect(objectiveReviewBinding(unchanged)).toEqual(objectiveReviewBinding(original));
      expect(() => registerObjectiveAcceptanceCriteria(unchanged, [yearCheck(2025)], 11)).toThrow();
    }
    const revised = registerObjectiveAcceptanceCriteria(amend(original), [yearCheck(2025)], 11);
    const redelivered = amend(revised);
    expect(redelivered.acceptanceNeedsReview).toBe(false);
    expect(objectiveReviewBinding(redelivered)).toEqual(objectiveReviewBinding(revised));
    expect(redelivered.amendments).toHaveLength(1);
  });

  it('keeps verified target criteria valid for response-presentation preferences', () => {
    const original = initial();
    const observation = observe(2024, 3);
    const originalReceipt = receipt(original, observation.id);
    for (const [index, text] of [
      'Réponds plus brièvement dans le message final.',
      'Utilise un ton plus simple.',
      'Continue en anglais.',
      'Keep the final response concise.',
    ].entries()) {
      const preference: Message = {
        id: `style-${index}`, role: 'user', content: text, timestamp: 10 + index,
      };
      const continued = transitionObjectiveContract({
        existing: original, messageId: preference.id, text, nowMs: preference.timestamp,
      });
      expect(continued.acceptanceNeedsReview).not.toBe(true);
      expect(continued.acceptanceRevision).toBe(original.acceptanceRevision);
      expect(continued.acceptanceCriteria).toEqual(original.acceptanceCriteria);
      expect(objectiveReviewBinding(continued)).toEqual(objectiveReviewBinding(original));
      expect(validateObjectiveOutcome(originalReceipt, {
        objective: continued, messages: [root, observation, preference],
      }).valid).toBe(true);
    }
  });

  it('requires the full contract when a year amendment leaves other original requirements unchanged', () => {
    const changed = amend({ ...initial([yearCheck(2024), formatCheck]),
      originalText: `${root.content} Le format demandé est PDF.`,
    });
    // Revising the year does not authorize silently dropping the requested format.
    expect(() => registerObjectiveAcceptanceCriteria(changed, [yearCheck(2025)], 11)).toThrow();
    const revised = registerObjectiveAcceptanceCriteria(changed, [yearCheck(2025), formatCheck], 11);
    expect(revised.acceptanceCriteria?.map(check => check.id)).toEqual(['year-present', 'required-format']);
  });

  it('does not reopen a consumed amendment when its delivery is retried after a status message', () => {
    const revised = registerObjectiveAcceptanceCriteria(amend(initial()), [yearCheck(2025)], 11);
    const afterStatus = transitionObjectiveContract({ existing: revised, messageId: 'u3', text: 'statut', nowMs: 12 });
    const replayed = transitionObjectiveContract({ existing: afterStatus, messageId: amendment.id, text: amendment.content, nowMs: 13 });
    expect(replayed.acceptanceNeedsReview).toBe(false);
    expect(objectiveReviewBinding(replayed)).toEqual(objectiveReviewBinding(revised));
    expect(replayed.amendments?.filter(item => item.messageId === amendment.id)).toHaveLength(1);
  });

  it('attributes archived criteria to their original revision, not the amendment that supersedes them', () => {
    const revised = registerObjectiveAcceptanceCriteria(amend(initial()), [yearCheck(2025)], 11);
    expect(revised.acceptanceHistory?.[0]).toMatchObject({ revision: root.id, registeredAt: 2, criteria: [yearCheck(2024)] });
    const secondAmendment = transitionObjectiveContract({ existing: revised, messageId: 'u3',
      text: 'Finalement il faut les pièces de 2026.', nowMs: 20 });
    const secondRevision = registerObjectiveAcceptanceCriteria(secondAmendment, [yearCheck(2026)], 21);
    expect(secondRevision.acceptanceHistory).toHaveLength(2);
    expect(secondRevision.acceptanceHistory?.[1]).toMatchObject({ revision: amendment.id, registeredAt: 11, criteria: [yearCheck(2025)] });
  });

  it('preserves each extension boundary, then archives and renews every boundary for a human revision', () => {
    const original = initial();
    const extended = registerObjectiveAcceptanceCriteria(original, [formatCheck], 5);
    const snapshot = JSON.stringify(extended);
    expect(extended.acceptanceRegisteredAtById).toEqual({ 'year-present': 2, 'required-format': 5 });
    expect(registerObjectiveAcceptanceCriteria(extended, [yearCheck(2024), formatCheck], 6)).toBe(extended);
    const revised = registerObjectiveAcceptanceCriteria(amend(extended), [yearCheck(2025), formatCheck], 11);
    expect(revised.acceptanceRegisteredAtById).toEqual({ 'year-present': 11, 'required-format': 11 });
    expect(revised.acceptanceHistory?.[0]).toMatchObject({
      revision: root.id, registeredAt: 5,
      registeredAtById: { 'year-present': 2, 'required-format': 5 },
    });
    expect(JSON.stringify(extended)).toBe(snapshot);
    expect(revised.budgetBaselineUsd).toBe(12);
    expect(revised.tokenBaseline).toBe(3400);
    expect(revised.userMessageId).toBe(root.id);
    expect(registerObjectiveAcceptanceCriteria(revised, [yearCheck(2025), formatCheck], 12)).toBe(revised);
    const restored = JSON.parse(JSON.stringify(revised)) as ActiveSessionObjective;
    expect(restored.acceptanceHistory).toEqual(revised.acceptanceHistory);
    const preRegistration = observe(2025, 9, 'pre-registration');
    expect(validateObjectiveAcceptanceCriteria(restored,
      [root, preRegistration, amendment], receipt(restored, preRegistration.id))).toHaveLength(2);
    expect(validateObjectiveAcceptanceCriteria(restored,
      [root, amendment, preRegistration], receipt(restored, preRegistration.id))).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(restored, [root, amendment, observe(2025, 12, 'fresh')], receipt(restored, 'fresh'))).toEqual([]);
  });

  it('rejects contradictory equalities in a complete human revision without changing the old contract', () => {
    const original = initial([yearCheck(2024), { ...yearCheck(2024), id: 'duplicate-year' }]);
    const changed = amend(original);
    const snapshot = JSON.stringify(changed);
    expect(() => registerObjectiveAcceptanceCriteria(changed, [yearCheck(2025), { ...yearCheck(2026), id: 'duplicate-year' }], 11))
      .toThrow('Incompatible registered equality');
    expect(JSON.stringify(changed)).toBe(snapshot);
    const revised = registerObjectiveAcceptanceCriteria(changed, [yearCheck(2025), { ...yearCheck(2025), id: 'duplicate-year' }], 11);
    expect(revised.acceptanceNeedsReview).toBe(false);
    expect(revised.acceptanceCriteria?.map(item => item.checks[0]?.equals)).toEqual([2025, 2025]);
  });

  it('can repair historical contradictory values only after a human amendment preserves every criterion ID', () => {
    const old: ActiveSessionObjective = { ...initial(),
      acceptanceCriteria: [yearCheck(2024), { ...yearCheck(2023), id: 'duplicate-year' }],
    };
    // An ordinary retry neither rewrites nor silently readmits historical obligations.
    expect(registerObjectiveAcceptanceCriteria(old, old.acceptanceCriteria!, 5)).toBe(old);
    expect(() => registerObjectiveAcceptanceCriteria(old, [yearCheck(2025)], 6)).toThrow('cannot be weakened');
    const changed = amend(old);
    expect(() => registerObjectiveAcceptanceCriteria(changed, [yearCheck(2025)], 11)).toThrow('full amended contract');
    const revised = registerObjectiveAcceptanceCriteria(changed, [yearCheck(2025), { ...yearCheck(2025), id: 'duplicate-year' }], 11);
    expect(revised.acceptanceHistory?.[0]?.criteria).toEqual(old.acceptanceCriteria!);
    expect(validateObjectiveAcceptanceCriteria(revised, [root, amendment, observe(2025, 12)], receipt(revised, 'observation-2025'))).toEqual([]);
  });

  it('binds a newly selected procedure even when the existing check count is unchanged', () => {
    const original = initial();
    const selected = registerObjectiveAcceptanceCriteria(original, [yearCheck(2024)], 5, 'document-package');
    expect(selected.procedure).toEqual({ id: 'document-package', version: 1 });
    expect(selected.acceptanceRegisteredAt).toBe(5);
    expect(selected.acceptanceRegisteredAtById).toEqual({ 'year-present': 2 });
    expect(registerObjectiveAcceptanceCriteria(selected, [yearCheck(2024)], 6, 'document-package')).toBe(selected);
    expect(validateObjectiveAcceptanceCriteria(selected, [root, observe(2024, 3)], receipt(selected, 'observation-2024')))
      .toHaveLength(3);
  });
});
