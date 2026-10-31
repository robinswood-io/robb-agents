import type { PendingTurnRecovery } from '../../../shared/src/sessions/types/turn-recovery.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { describe, expect, it } from "bun:test";
import { DEFAULT_AUTOMATIC_TURN_RECOVERY_ATTEMPTS, DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS, MAX_OBJECTIVE_CONTINUATION_ATTEMPTS, MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS, MAX_AUTOMATIC_TURN_RECOVERY_STAGNANT_ATTEMPTS, advancePendingTurnRecovery, buildAutomaticTurnRecoveryPrompt, buildCleanRecoveryContinuationPrompt, createCleanRecoveryContinuationHandoff, createPendingTurnRecovery, exhaustPendingTurnRecovery, hasObjectiveContinuationProvenance, pendingRecoveryRequiresContinuation, planAutomaticTurnRecovery, reconstructLegacyTurnRecoveryBudget, turnStillNeedsRecovery } from "./turn-recovery.ts";
import { activeSafeContinuationObjective, legacyRecovery, legacyTerminal, message } from "./testing/turn-recovery-fixture.ts";

describe('durable turn recovery', () => {
  it('reconstructs exact legacy passes 1+2 without resetting the spent counter', () => {
    const restored = reconstructLegacyTurnRecoveryBudget([
      message('user-legacy', 'user'),
      legacyRecovery('user-legacy', '1', 10),
      legacyRecovery('user-legacy', '2', 20),
      legacyTerminal(30),
    ], 'user-legacy');
    expect(restored).toEqual({
      userMessageId: 'user-legacy', startedAt: 10, attempts: 2, lastAttemptAt: 20,
      lastCause: 'objective_incomplete', exhaustedAt: 30, validationExhausted: true,
      validationGaps: ['legacy validation gap'],
    });
  });

  it.each([
    ['malformed', [legacyRecovery('user-legacy', '1', 10), message('bad', 'user', {
      hidden: true, timestamp: 20,
      content: '<automatic_turn_recovery original_user_message_id="user-legacy" attempt="2">malformed</automatic_turn_recovery>',
    })]],
    ['cross-objective', [legacyRecovery('user-legacy', '1', 10), legacyRecovery('other-objective', '2', 20)]],
    ['duplicate', [legacyRecovery('user-legacy', '1', 10), legacyRecovery('user-legacy', '1', 20)]],
    ['attempt above the cap', [legacyRecovery('user-legacy', '1', 10),
      legacyRecovery('user-legacy', String(MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS + 1), 20)]],
    ['non-increasing timestamps', [legacyRecovery('user-legacy', '1', 20), legacyRecovery('user-legacy', '2', 20)]],
    ['terminal before the last attempt', [legacyRecovery('user-legacy', '1', 10), legacyRecovery('user-legacy', '2', 30)]],
  ] as const)('keeps legacy budget history unavailable for %s recovery rows', (_name, rows) => {
    expect(reconstructLegacyTurnRecoveryBudget([
      message('user-legacy', 'user'), ...rows, legacyTerminal(30),
    ], 'user-legacy')).toBeUndefined();
  });

  it('does not count public or non-host recovery-shaped rows', () => {
    const publicForgery = legacyRecovery('user-legacy', '1', 10);
    publicForgery.hidden = false;
    const internalForgery = legacyRecovery('user-legacy', '1', 10);
    internalForgery.internalOrigin = { kind: 'user-input' };
    expect(reconstructLegacyTurnRecoveryBudget([
      message('user-legacy', 'user'), publicForgery, legacyTerminal(30),
    ], 'user-legacy')).toBeUndefined();
    expect(reconstructLegacyTurnRecoveryBudget([
      message('user-legacy', 'user'), internalForgery, legacyTerminal(30),
    ], 'user-legacy')).toBeUndefined();
  });

  it('does not cross a newer public user-message boundary', () => {
    expect(reconstructLegacyTurnRecoveryBudget([
      message('user-legacy', 'user'), legacyRecovery('user-legacy', '1', 10),
      message('new-objective', 'user', { timestamp: 15 }),
      legacyRecovery('user-legacy', '2', 20), legacyTerminal(30),
    ], 'user-legacy')).toBeUndefined();
  });

  it('marks a new turn before streaming and advances retries with a cause', () => {
    const pending = createPendingTurnRecovery('user-1', 10);
    expect(pending).toEqual({ userMessageId: 'user-1', startedAt: 10, attempts: 0 });
    expect(advancePendingTurnRecovery(pending, 'app_restart', 20)).toEqual({
      userMessageId: 'user-1',
      startedAt: 10,
      leaseExpiresAt: 20 + DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS,
      attempts: 1,
      lastAttemptAt: 20,
      lastCause: 'app_restart',
    });
  });

  it('recovers commentary/tool tails but never replays a terminal outcome', () => {
    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('commentary', 'assistant', { isIntermediate: true }),
      message('tool-1', 'tool'),
    ], 'user-1')).toBe(true);

    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('final', 'assistant'),
    ], 'user-1')).toBe(false);

    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('premature', 'assistant', {
        content: 'Le diagnostic est terminé. Je lance maintenant les tests.',
      }),
    ], 'user-1')).toBe(true);

    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('error', 'error'),
    ], 'user-1')).toBe(false);
  });

  it('bounds retries and records exhaustion durably', () => {
    const first = advancePendingTurnRecovery(createPendingTurnRecovery('user-1', 1), 'stream_ended', 2, 3)!;
    const second = advancePendingTurnRecovery(first, 'runtime_error', 3, 3)!;
    const third = advancePendingTurnRecovery(second, 'premature_final', 4, 3)!;
    expect(advancePendingTurnRecovery(third, 'runtime_error', 5, 3)).toBeNull();
    expect(exhaustPendingTurnRecovery(third, 6).exhaustedAt).toBe(6);
  });

  it('accepts an explicit workspace retry bound', () => {
    const first = advancePendingTurnRecovery(createPendingTurnRecovery('user-1', 1), 'stream_ended', 2, 2)!;
    const second = advancePendingTurnRecovery(first, 'runtime_error', 3, 2)!;
    expect(second.attempts).toBe(2);
    expect(advancePendingTurnRecovery(second, 'app_restart', 4, 2)).toBeNull();
  });

  it('defaults to four automatic attempts and two no-progress hypotheses', () => {
    expect(DEFAULT_AUTOMATIC_TURN_RECOVERY_ATTEMPTS).toBe(4);
    expect(MAX_AUTOMATIC_TURN_RECOVERY_STAGNANT_ATTEMPTS).toBe(2);
    const first = advancePendingTurnRecovery(
      createPendingTurnRecovery('user-default', 1), 'objective_incomplete', 2,
      undefined, 'same-proof',
    )!;
    const second = advancePendingTurnRecovery(
      first, 'objective_incomplete', 3, undefined, 'same-proof',
    )!;
    expect(second.stagnantAttempts).toBe(1);
    expect(advancePendingTurnRecovery(
      second, 'objective_incomplete', 4, undefined, 'same-proof',
    )).toBeNull();
  });

  it('keeps valid objective continuation distinct, bounded and restart-safe', () => {
    expect(MAX_OBJECTIVE_CONTINUATION_ATTEMPTS).toBe(4);
    const first = advancePendingTurnRecovery(
      createPendingTurnRecovery('user-continue', 1), 'objective_continue', 2,
      MAX_OBJECTIVE_CONTINUATION_ATTEMPTS, 'progress-a',
    )!;
    expect(pendingRecoveryRequiresContinuation(first, true)).toBe(true);
    const prompt = buildAutomaticTurnRecoveryPrompt({
      ...first, continuationWork: ['Run the final verification'],
    }, 'objective_continue');
    expect(prompt).toContain('valid progress receipt');
    expect(prompt).toContain('Do not re-plan completed phases');
    expect(prompt).toContain('Run the final verification');
    expect(prompt).not.toContain('unresolved validation gaps');
    const interrupted = {
      ...first,
      lastCause: 'runtime_error' as const,
      continuationWork: ['Run the final verification'],
      continuationOrigin: 'objective_continue' as const,
    };
    expect(hasObjectiveContinuationProvenance(interrupted)).toBe(true);
    expect(pendingRecoveryRequiresContinuation(interrupted, true)).toBe(true);
    const interruptedPrompt = buildAutomaticTurnRecoveryPrompt(interrupted, 'runtime_error');
    expect(interruptedPrompt).toContain('recovery event did not replace');
    expect(interruptedPrompt).toContain('Run the final verification');
  });

  it('continues while successful tool evidence advances and stops after two stagnant passes', () => {
    const first = advancePendingTurnRecovery(
      createPendingTurnRecovery('user-1', 1), 'premature_final', 2, 8, 'proof-a', 2,
    )!;
    const progressed = advancePendingTurnRecovery(first, 'premature_final', 3, 8, 'proof-b', 2)!;
    expect(progressed.stagnantAttempts).toBe(0);
    const stagnant = advancePendingTurnRecovery(progressed, 'premature_final', 4, 8, 'proof-b', 2)!;
    expect(stagnant.stagnantAttempts).toBe(1);
    expect(advancePendingTurnRecovery(stagnant, 'premature_final', 5, 8, 'proof-b', 2)).toBeNull();
  });

  it('allows a longer mission only up to the absolute safe ceiling', () => {
    let pending = createPendingTurnRecovery('user-1', 1);
    for (let attempt = 0; attempt < MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS; attempt += 1) {
      const advanced = advancePendingTurnRecovery(
        pending,
        'tool_checkpoint',
        attempt + 2,
        MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
        `semantic-proof-${attempt}`,
        2,
      );
      expect(advanced).not.toBeNull();
      pending = advanced!;
    }
    expect(pending.attempts).toBe(8);
    expect(pending.lastProgressAt).toBe(9);
    expect(advancePendingTurnRecovery(pending, 'tool_checkpoint', 10, 8, 'new-proof', 2)).toBeNull();
  });

  it('enforces the configured retry bound even when every fingerprint changes', () => {
    let pending = createPendingTurnRecovery('user-1', 1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      pending = advancePendingTurnRecovery(pending, 'objective_incomplete', attempt + 2, 2, `proof-${attempt}`, 2)!;
    }
    expect(pending.attempts).toBe(2);
    expect(advancePendingTurnRecovery(pending, 'objective_incomplete', 4, 2, 'another-proof', 2)).toBeNull();
    expect(advancePendingTurnRecovery(createPendingTurnRecovery('disabled', 1), 'objective_incomplete', 2, 0, 'proof')).toBeNull();
  });

  it('turns a safe continuation strategy ceiling into a durable replan instead of exhaustion', () => {
    let pending = createPendingTurnRecovery('user-continue', 1);
    pending = advancePendingTurnRecovery(pending, 'objective_continue', 2, 2, 'proof-a')!;
    pending = advancePendingTurnRecovery(pending, 'objective_continue', 3, 2, 'proof-b')!;

    const plan = planAutomaticTurnRecovery({
      pending,
      cause: 'objective_continue',
      objective: activeSafeContinuationObjective(),
      nowMs: 4,
      maxAttempts: 2,
      progressFingerprint: 'proof-c',
    });

    expect(plan).toMatchObject({
      action: 'replan',
      reason: 'strategy-attempt-limit',
      recovery: {
        attempts: 2,
        continuationRequired: true,
        recoveryStrategy: {
          phase: 'replan',
          attemptBaseline: 2,
          transitionCount: 1,
          reason: 'attempt-limit',
        },
      },
    });
    expect(plan.recovery.exhaustedAt).toBeUndefined();

    const resumed = planAutomaticTurnRecovery({
      pending: plan.recovery,
      cause: 'objective_continue',
      objective: activeSafeContinuationObjective(),
      nowMs: 5,
      maxAttempts: 2,
      progressFingerprint: 'proof-c',
      maxStagnantAttempts: 1,
    });
    expect(resumed).toMatchObject({ action: 'dispatch', recovery: { attempts: 3 } });
  });

  it('escalates after a bounded replan and requests one decision only after stagnation persists', () => {
    const objective = activeSafeContinuationObjective();
    const replanState = {
      ...createPendingTurnRecovery('user-continue', 1),
      leaseExpiresAt: 1_000,
      attempts: 4,
      lastProgressFingerprint: 'same-proof',
      stagnantAttempts: 2,
      continuationWork: objective.lastOutcome!.remainingWork,
      continuationOrigin: 'objective_continue' as const,
      recoveryStrategy: {
        schemaVersion: 1 as const,
        phase: 'replan' as const,
        attemptBaseline: 2,
        transitionCount: 1,
        transitionedAt: 3,
        reason: 'attempt-limit' as const,
      },
    };
    const escalated = planAutomaticTurnRecovery({
      pending: replanState,
      cause: 'objective_continue',
      objective,
      nowMs: 5,
      maxAttempts: 2,
      progressFingerprint: 'same-proof',
    });
    expect(escalated).toMatchObject({
      action: 'escalate',
      recovery: {
        attempts: 4,
        recoveryStrategy: { phase: 'escalate', attemptBaseline: 4, transitionCount: 2 },
      },
    });

    const exhaustedEscalation = {
      ...escalated.recovery,
      attempts: 6,
      stagnantAttempts: 2,
      lastProgressFingerprint: 'same-proof',
    };
    expect(planAutomaticTurnRecovery({
      pending: exhaustedEscalation,
      cause: 'objective_continue',
      objective,
      nowMs: 8,
      maxAttempts: 2,
      progressFingerprint: 'same-proof',
    })).toMatchObject({
      action: 'halt',
      reason: 'strategy-attempt-limit',
    });
  });

  it('starts a clean continuation after the absolute ceiling only with new semantic progress', () => {
    const objective = activeSafeContinuationObjective();
    const atAbsoluteCeiling = {
      ...createPendingTurnRecovery('user-continue', 1),
      attempts: MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
      lastProgressFingerprint: 'proof-before-final-pass',
      continuationWork: objective.lastOutcome!.remainingWork,
      continuationOrigin: 'objective_continue' as const,
    };

    const clean = planAutomaticTurnRecovery({
      pending: atAbsoluteCeiling,
      cause: 'objective_continue',
      objective,
      nowMs: 20,
      progressFingerprint: 'proof-after-final-pass',
    });
    expect(clean).toMatchObject({
      action: 'clean-continuation',
      reason: 'absolute-attempt-limit',
      recovery: {
        attempts: 0,
        startedAt: 20,
        continuationRequired: true,
        lastProgressFingerprint: 'proof-after-final-pass',
      },
    });
    expect(clean.recovery.exhaustedAt).toBeUndefined();
    expect(clean.recovery.recoveryStrategy).toBeUndefined();

    expect(planAutomaticTurnRecovery({
      pending: {
        ...atAbsoluteCeiling,
        cleanContinuationCount: 1,
        lastProgressFingerprint: 'proof-after-final-pass',
      },
      cause: 'objective_continue',
      objective,
      nowMs: 30,
      progressFingerprint: 'proof-after-second-ceiling',
    })).toMatchObject({ action: 'halt', reason: 'absolute-attempt-limit' });

    expect(planAutomaticTurnRecovery({
      pending: atAbsoluteCeiling,
      cause: 'objective_continue',
      objective,
      nowMs: 20,
      progressFingerprint: 'proof-before-final-pass',
    })).toMatchObject({ action: 'halt', reason: 'absolute-attempt-limit' });
    expect(planAutomaticTurnRecovery({
      pending: omitUndefined<PendingTurnRecovery>({ ...atAbsoluteCeiling, lastProgressFingerprint: undefined }),
      cause: 'objective_continue',
      objective,
      nowMs: 20,
      progressFingerprint: 'unanchored-proof',
    })).toMatchObject({ action: 'halt', reason: 'absolute-attempt-limit' });
  });

  it('builds one deterministic bounded handoff instead of reinjecting the discarded history', () => {
    const objective = {
      ...activeSafeContinuationObjective(),
      originalText: 'Implémente les corrections validées puis vérifie le résultat.',
      amendments: [{
        messageId: 'scope-1',
        text: 'Conserve le périmètre local et ne déploie pas en production.',
        timestamp: 2,
      }],
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    };
    const pending = {
      ...createPendingTurnRecovery('user-continue', 1),
      attempts: MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
      lastCause: 'objective_continue' as const,
      lastProgressFingerprint: 'semantic-proof-b',
      continuationWork: objective.lastOutcome!.remainingWork,
      continuationOrigin: 'objective_continue' as const,
      recoveryStrategy: {
        schemaVersion: 1 as const,
        phase: 'escalate' as const,
        attemptBaseline: 6,
        transitionCount: 2,
        transitionedAt: 8,
        reason: 'attempt-limit' as const,
      },
    };
    const input = {
      objective,
      pending,
      evidence: [
        { reference: 'tool-use-42', summary: 'The local edit was applied to the intended file.' },
        { reference: 'test-result-43', summary: 'The focused regression test now passes.' },
      ],
      remainingWork: objective.lastOutcome!.remainingWork,
    };
    const first = createCleanRecoveryContinuationHandoff(input);
    const replay = createCleanRecoveryContinuationHandoff(input);
    const prompt = buildCleanRecoveryContinuationPrompt(first!);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      schemaVersion: 1,
      objective: {
        objectiveId: 'objective-continue',
        originalRequest: objective.originalText,
        requirements: { execution: true, acceptance: true },
      },
      recovery: {
        sourceAttempts: MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
        strategyPhase: 'escalate',
        progressFingerprint: 'semantic-proof-b',
      },
      remainingWork: objective.lastOutcome!.remainingWork,
    });
    expect(first!.id).toMatch(/^clean-continuation-v1-[a-f0-9]{24}$/);
    expect(prompt).toContain(first!.id);
    expect(prompt).toContain('grants no new authority');
    expect(prompt).toContain('A JSON file or prose is not this final receipt.');
    expect(prompt).toContain('<!-- robb_objective_outcome');
    expect(prompt).toContain('tool-use-42');
    expect(prompt).toContain('Apply the remaining safe correction');
    expect(prompt).not.toContain('discarded-transcript-sentinel');
  });
});
