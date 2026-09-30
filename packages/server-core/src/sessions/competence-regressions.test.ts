import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from '@craft-agent/core/types';
import { pickSessionFields, type ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { BUSINESS_PROCEDURES } from './business-procedures.ts';
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';
import { transitionObjectiveContract, buildObjectiveContractPrompt } from './objective-contract.ts';
import { validateObjectiveOutcome } from './objective-outcome.ts';
import { DelegationBudget, DELEGATION_LIMITS, type DelegationSession } from './delegation-budget.ts';

// Sanitized behavioral cases from 2026-09-08, not replays of private transcripts.
const root: Message = { id: 'request', role: 'user', content: 'Prépare puis envoie le dossier complet.', timestamp: 1 };
const base = () => transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
const check = (requirementId: string): ObjectiveAcceptanceCriterion => ({
  id: requirementId, requirementId, description: `Verify ${requirementId} against the exact package`,
  toolName: 'mcp__documents__inspect_package', input: { packageId: 'package-v2' },
  checks: [{ path: requirementId, equals: true }],
});
function receipt(objective: ActiveSessionObjective): ObjectiveOutcomeDeclaration {
  return { state: 'complete_verified', blocker: null, remainingWork: [],
    criteria: [...objective.completionCriteria, ...(objective.acceptanceCriteria ?? []).map(item => item.id)]
      .map(id => ({ id, satisfied: true, evidence: ['inspect'] })),
  };
}
const observation: Message = { id: 'inspect', toolUseId: 'inspect', role: 'tool', content: '', timestamp: 4,
  toolName: 'mcp__documents__inspect_package', toolInput: { packageId: 'package-v2' },
  toolStatus: 'completed', toolExecuted: true,
  toolResult: JSON.stringify(Object.fromEntries(BUSINESS_PROCEDURES['document-delivery'].requirements.map(item => [item.id, true]))),
};

describe('September 8 competence regressions — business outcome', () => {
  it('refuses a sent receipt alone when the dossier inventory, completeness and readability are missing', () => {
    const objective = registerObjectiveAcceptanceCriteria(base(), [check('delivery-receipt')], 2, 'document-delivery');
    const gaps = validateObjectiveAcceptanceCriteria(objective, [root, observation], receipt(objective));
    expect(gaps).toHaveLength(3);
    expect(gaps.join(' ')).toContain('content-completeness');
    expect(gaps.join(' ')).toContain('recipient-usability');
  });
  it('accepts complete observed coverage, rejecting omissions, wrong artifact and pre-registration receipts', () => {
    const checks = BUSINESS_PROCEDURES['document-delivery'].requirements.map(item => check(item.id));
    const objective = registerObjectiveAcceptanceCriteria(base(), checks, 2, 'document-delivery');
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], receipt(objective))).toEqual([]);
    for (const changed of [
      { toolInput: { packageId: 'package-v1' } }, { timestamp: 0 },
      { toolResult: observation.toolResult!.replace('"content-completeness":true', '"content-completeness":false') },
      { toolResult: 'The dossier is complete and readable.' }, { toolExecuted: false },
    ]) expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, ...changed }], receipt(objective)).length).toBeGreaterThan(0);
  });
  it('does not allow a procedure or requirement to be weakened after registration', () => {
    const objective = registerObjectiveAcceptanceCriteria(base(), [check('delivery-receipt')], 2, 'document-delivery');
    expect(() => registerObjectiveAcceptanceCriteria(objective, [check('source-inventory')], 3, 'document-package')).toThrow();
    expect(() => registerObjectiveAcceptanceCriteria(objective, [{ ...check('source-inventory'), id: 'delivery-receipt' }], 3)).toThrow();
    expect(() => registerObjectiveAcceptanceCriteria(base(), [check('arbitrary-pass')], 2, 'document-delivery')).toThrow();
  });
  it('keeps the user correction and original acceptance target through persistence and continuation', () => {
    const objective = registerObjectiveAcceptanceCriteria(base(), [check('delivery-receipt')], 2, 'document-delivery');
    const amended = transitionObjectiveContract({ existing: objective, messageId: 'correction', text: 'Il manque les annexes et le PDF est illisible.', nowMs: 10 });
    const persisted = JSON.parse(JSON.stringify(pickSessionFields({ id: 'session', activeObjective: amended }))).activeObjective;
    expect(persisted.objectiveId).toBe(root.id);
    expect(persisted.acceptanceCriteria).toEqual(objective.acceptanceCriteria);
    expect(buildObjectiveContractPrompt(persisted)).toContain('Il manque les annexes');
    expect(persisted.procedure.id).toBe('document-delivery');
  });
  it('makes an independent security review terminal without granting mutation authority or demanding another review', () => {
    const objective = transitionObjectiveContract({ messageId: root.id, text: 'Audit sécurité : vérifie les correctifs et le déploiement.', delegatedRole: 'reviewer', nowMs: 1 });
    expect(objective.requiresExecutionEvidence).not.toBe(true);
    expect(objective.completionCriteria).not.toContain('independent-review-passed');
    expect(buildObjectiveContractPrompt(objective)).not.toContain('High-stakes evidence gate:');
    expect(buildObjectiveContractPrompt(objective)).toContain('A correct FAIL is a successful review');
    const ownCheck = { ...check('source-inventory'), requirementId: undefined };
    const registered = registerObjectiveAcceptanceCriteria(objective, [ownCheck], 2);
    // A real observation can complete the review task even when its substantive finding is FAIL.
    const report: Message = { id: 'review-report', role: 'assistant', content: 'FAIL: the requested patch is absent from the deployed revision.', timestamp: 5 };
    expect(validateObjectiveOutcome(receipt(registered), { objective: registered, messages: [root, observation, report] }).valid).toBe(true);
  });
  it('enforces the technical-handover business procedure: requires all 4 criteria and rejects invalid requirements', () => {
    expect(BUSINESS_PROCEDURES['technical-handover'].requirements).toHaveLength(4);
    const expectedIds = ['infrastructure-inventory', 'service-and-data-access', 'credentials-and-continuity', 'handover-dossier'];
    expect(BUSINESS_PROCEDURES['technical-handover'].requirements.map(r => r.id)).toEqual(expectedIds);

    // Reject unknown requirement for technical-handover
    expect(() => registerObjectiveAcceptanceCriteria(base(), [check('invalid-req')], 2, 'technical-handover')).toThrow();

    // Incomplete registration has gaps
    const partialObjective = registerObjectiveAcceptanceCriteria(base(), [check('infrastructure-inventory')], 2, 'technical-handover');
    const partialObservation: Message = {
      ...observation,
      toolResult: JSON.stringify({ 'infrastructure-inventory': true }),
    };
    const gaps = validateObjectiveAcceptanceCriteria(partialObjective, [root, partialObservation], receipt(partialObjective));
    expect(gaps).toHaveLength(3);
    expect(gaps.join(' ')).toContain('service-and-data-access');
    expect(gaps.join(' ')).toContain('credentials-and-continuity');
    expect(gaps.join(' ')).toContain('handover-dossier');

    // Complete registration with all 4 requirements passes validation
    const fullChecks = BUSINESS_PROCEDURES['technical-handover'].requirements.map(item => check(item.id));
    const fullObjective = registerObjectiveAcceptanceCriteria(base(), fullChecks, 2, 'technical-handover');
    const fullObservation: Message = {
      ...observation,
      toolResult: JSON.stringify(Object.fromEntries(expectedIds.map(id => [id, true]))),
    };
    expect(validateObjectiveAcceptanceCriteria(fullObjective, [root, fullObservation], receipt(fullObjective))).toEqual([]);
  });
});

describe('September 8 competence regressions — bounded delegation', () => {
  const parent = (): DelegationSession => ({ id: 'root', isProcessing: true, activeObjective: base() });
  it('reserves parallel creations atomically and releases failed attempts', () => {
    const budget = new DelegationBudget(); const p = parent();
    const reservations = Array.from({ length: DELEGATION_LIMITS.maxConcurrent }, () => budget.reserve(p, [p]));
    expect(() => budget.reserve(p, [p])).toThrow('Concurrent');
    reservations[0]!.release();
    expect(budget.reserve(p, [p]).delegation.depth).toBe(1);
  });
  it('restores a family budget from persisted lineage, including dispatched children without objectives', () => {
    const p = parent(); const budget = new DelegationBudget();
    const children = Array.from({ length: 4 }, (_, i) => {
      const reserved = budget.reserve(p, [p]); reserved.release();
      return { ...JSON.parse(JSON.stringify(pickSessionFields({ id: `child-${i}`, delegation: reserved.delegation }))), isProcessing: false } as DelegationSession;
    });
    expect(() => new DelegationBudget().reserve(p, [p, ...children])).toThrow('Concurrent');
    children[0]!.activeObjective = { ...base(), terminalState: 'complete_verified' };
    expect(new DelegationBudget().reserve(p, [p, ...children]).delegation.rootObjectiveId).toBe(root.id);
  });
  it('counts finished children toward the total and rejects recursive reviewers, deep chains and stale objectives', () => {
    const p = parent(); const budget = new DelegationBudget();
    const child = budget.reserve(p, [p], 'reviewer'); child.release();
    const reviewer = { id: 'reviewer', delegation: child.delegation, isProcessing: true };
    expect(() => budget.reserve(reviewer, [p, reviewer])).toThrow('reviewer');
    const deep = { ...reviewer, delegation: { ...child.delegation, role: 'worker' as const, depth: 3 } };
    expect(() => budget.reserve(deep, [p, deep])).toThrow('depth');
    const stale = { ...p, activeObjective: { ...base(), objectiveId: 'new-goal' } };
    expect(() => budget.reserve(deep, [stale, deep])).toThrow('no longer current');
    const completed = Array.from({ length: 32 }, (_, i) => ({ id: `done-${i}`, isProcessing: false,
      delegation: { ...child.delegation, role: 'worker' as const }, activeObjective: { ...base(), terminalState: 'complete_verified' as const } }));
    expect(() => budget.reserve(p, [p, ...completed])).toThrow('child-session budget');
  });
});
