import { describe, expect, it } from 'bun:test';
import { SESSION_PERSISTENT_FIELDS, type ActiveSessionObjective } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: active objective', () => {
  it('preserves the durable objective contract and isolated budget baseline', () => {
    const activeObjective: ActiveSessionObjective = {
      schemaVersion: 1,
      userMessageId: 'user-original',
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
    };

    expect(SESSION_PERSISTENT_FIELDS).toContain('activeObjective');
    expect(pickSessionFields({ id: 'session-1', activeObjective })).toEqual({
      id: 'session-1',
      activeObjective,
    });
  });
});
