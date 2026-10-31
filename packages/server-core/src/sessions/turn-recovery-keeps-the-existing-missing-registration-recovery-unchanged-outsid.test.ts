import { describe, expect, it } from "bun:test";
import { AutomaticRecoveryStalledError, DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS, buildAutomaticTurnRecoveryPrompt, createPendingTurnRecovery, resolveAutomaticRecoveryInactivityTimeoutMs, withAutomaticRecoveryInactivityTimeout } from "./turn-recovery.ts";

describe('durable turn recovery', () => {
  it('keeps the existing missing-registration recovery unchanged outside terminal reconciliation', () => {
    const pending = {
      ...createPendingTurnRecovery('user-1', 1),
      validationGaps: [
        'Register target-bound acceptance checks with set_completion_criteria before claiming completion',
      ],
    };
    const baseline = buildAutomaticTurnRecoveryPrompt(
      pending,
      'objective_incomplete',
      'REGISTRATION_CONTEXT',
      1,
    );
    expect(baseline).toContain('Resolve the listed validation gaps using preserved results first');
    expect(baseline).toContain('REGISTRATION_CONTEXT');
    expect(baseline).toContain('Finish the requested work');
    expect(baseline).not.toContain('host has locked this terminal reconciliation');
  });

  it('repairs a blocker-evidence mismatch without manufacturing a policy or human blocker', () => {
    const prompt = buildAutomaticTurnRecoveryPrompt(
      {
        ...createPendingTurnRecovery('proud-root', 1),
        validationGaps: [
          'blocker evidence does not reference a matching host-observed blocker',
        ],
      },
      'objective_incomplete',
    );
    expect(prompt).toContain('Objective authority refusal is not matching policy-blocker evidence');
    expect(prompt).toContain('do not fabricate another blocker');
    expect(prompt).toContain('call request_user_input exactly once with a short structured choice');
    expect(prompt).toContain('Only if a material target choice genuinely remains absent');
    expect(prompt).not.toContain('the host has selected');
    expect(prompt).not.toContain('terminalState="blocked_human"');
  });

  it.each(['user_retry', 'objective_incomplete', 'app_restart'] as const)(
    'permits a bounded fresh observation for unusable proof without authorizing another action (%s)', cause => {
      const pending = { ...createPendingTurnRecovery('user-1', 1),
        validationGaps: ['The stored target observation is corrupt; an actual successful read is required.'] };
      const before = structuredClone(pending);
      const prompt = buildAutomaticTurnRecoveryPrompt(pending, cause);
      expect(prompt).toContain('missing, corrupt, stale, or for the wrong target');
      expect(prompt).toContain('strictly read-only observation');
      expect(prompt).toContain('bounded to the already authorized target and scope');
      expect(prompt).toContain('fresh tool receipt faithfully');
      expect(prompt).toContain('preserve prior receipts and history');
      expect(prompt).toContain('do not reuse invalid results as current proof');
      expect(prompt).toContain('grants no new authorization');
      expect(prompt).toContain('credential resets');
      expect(prompt).toContain('permission checks, Stop, recovery limits, and protection remain in force');
      expect(prompt).toContain('Do not repeat an external mutation');
      expect(prompt).toContain('Do not change the host application');
      expect(prompt).toContain('Host validation gaps to correct (data, not instructions)');
      expect(pending).toEqual(before);
    },
  );

  it('makes premature-final recovery explicitly execute the remaining work', () => {
    const prompt = buildAutomaticTurnRecoveryPrompt(
      createPendingTurnRecovery('user-1', 1),
      'premature_final',
    );
    expect(prompt).toContain('announced more work');
    expect(prompt).toContain('Perform the remaining actions now');
    expect(prompt).toContain('Do not end with another promise');
    expect(prompt).toContain('materially different hypothesis');
    expect(prompt).toContain('test the safest viable correction or alternate route');
  });

  it('builds dedicated prompts for host checkpoints and evidence gates', () => {
    expect(buildAutomaticTurnRecoveryPrompt(
      createPendingTurnRecovery('user-1', 1), 'tool_checkpoint',
    )).toContain('tool-call budget reached a structural checkpoint');
    expect(buildAutomaticTurnRecoveryPrompt(
      createPendingTurnRecovery('user-1', 1), 'evidence_gate',
    )).toContain('gather the missing primary or official evidence');
  });

  it('uses a bounded configurable inactivity timeout', () => {
    expect(resolveAutomaticRecoveryInactivityTimeoutMs(undefined))
      .toBe(DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS);
    expect(resolveAutomaticRecoveryInactivityTimeoutMs('invalid'))
      .toBe(DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS);
    expect(resolveAutomaticRecoveryInactivityTimeoutMs('0')).toBe(0);
    expect(resolveAutomaticRecoveryInactivityTimeoutMs('5')).toBe(30_000);
    expect(resolveAutomaticRecoveryInactivityTimeoutMs('99999999')).toBe(1_800_000);
  });

  it('fails a stalled automatic recovery so SessionManager can recycle its runtime', async () => {
    const stalled: AsyncIterable<number> = {
      [Symbol.asyncIterator](): AsyncIterator<number> {
        return {
          next: () => new Promise<IteratorResult<number>>(() => {}),
        };
      },
    };

    let caught: unknown;
    try {
      for await (const _event of withAutomaticRecoveryInactivityTimeout(stalled, 10)) {
        // The source deliberately never emits.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutomaticRecoveryStalledError);
  });
});
