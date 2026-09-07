import { describe, expect, it } from 'bun:test';
import {
  SESSION_PERSISTENT_FIELDS,
  type ActiveSessionObjective,
  type PendingTurnRecovery,
} from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: active objective', () => {
  it('preserves the durable objective contract and isolated budget baseline', () => {
    const activeObjective: ActiveSessionObjective = {
      schemaVersion: 1,
      objectiveId: 'objective-root',
      userMessageId: 'user-original',
      lastUserMessageId: 'user-follow-up',
      startedAt: 10,
      budgetBaselineUsd: 740,
      tokenBaseline: 2_000_000,
      continuationCount: 2,
      orchestrationMode: 'mission',
      risk: 'high-stakes',
      requiresExecutionEvidence: true,
      evidenceRequirement: 'authoritative-sources-before-mutation',
      completionCriteria: [
        'requested-outcome-delivered',
        'relevant-checks-passed',
        'no-safe-work-remaining',
        'independent-review-passed',
      ],
      terminalState: 'active',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      lastOutcome: {
        state: 'continue',
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
        remainingWork: ['Finish the requested outcome'],
        blocker: null,
      },
    };

    expect(SESSION_PERSISTENT_FIELDS).toContain('activeObjective');
    expect(pickSessionFields({ id: 'session-1', activeObjective })).toEqual({
      id: 'session-1',
      activeObjective,
    });
  });

  it('persists the automatic-recovery progress and wall-clock lease', () => {
    const pendingTurnRecovery: PendingTurnRecovery = {
      userMessageId: 'user-original',
      startedAt: 10,
      leaseExpiresAt: 21_600_010,
      attempts: 24,
      lastAttemptAt: 200,
      lastProgressAt: 190,
      lastProgressFingerprint: 'semantic-proof',
      stagnantAttempts: 0,
    };

    expect(SESSION_PERSISTENT_FIELDS).toContain('pendingTurnRecovery');
    expect(pickSessionFields({ id: 'session-1', pendingTurnRecovery })).toEqual({
      id: 'session-1',
      pendingTurnRecovery,
    });
  });
});
