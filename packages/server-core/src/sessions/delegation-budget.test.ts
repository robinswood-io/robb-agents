import { describe, expect, it } from 'bun:test';
import type { PermissionMode } from '@craft-agent/shared/agent';
import {
  assertCurrentDelegationObjective, DELEGATION_LIMITS, DelegationBudget, DelegationBudgetError,
  resolveDelegatedPermissionMode, type DelegationSession,
} from './delegation-budget.ts';
import { transitionObjectiveContract } from './objective-contract.ts';

const parent = (id = 'root', messageId = 'request'): DelegationSession => ({
  id, isProcessing: true,
  activeObjective: transitionObjectiveContract({ messageId, text: 'Inspecte les documents fournis.', nowMs: 1 }),
});

describe('host delegation admission', () => {
  it('uses the bounded two-level, eight-child, four-concurrent budget', () => {
    expect(DELEGATION_LIMITS).toEqual({ maxDepth: 2, maxChildren: 8, maxConcurrent: 4 });
  });

  it('never grants a worker more authority than its parent and honors explicit reductions', () => {
    const modes = ['safe', 'ask', 'allow-all'] as const;
    for (const [parentIndex, parentMode] of modes.entries()) {
      expect(resolveDelegatedPermissionMode(parentMode)).toBe(parentMode);
      for (const [requestIndex, requestedMode] of modes.entries()) {
        expect(resolveDelegatedPermissionMode(parentMode, requestedMode)).toBe(modes[Math.min(parentIndex, requestIndex)]!);
        expect(resolveDelegatedPermissionMode(parentMode, requestedMode, 'reviewer')).toBe('safe');
      }
    }
  });

  it('rejects invalid persisted/requested modes, including aliases, instead of widening authority', () => {
    for (const value of ['execute', 'read-only', 'Explore', undefined, null, '']) {
      expect(() => resolveDelegatedPermissionMode(value as PermissionMode)).toThrow('Invalid permission mode');
      if (value !== undefined) expect(() => resolveDelegatedPermissionMode('safe', value as PermissionMode, 'reviewer'))
        .toThrow('Invalid permission mode');
    }
  });

  it('checks both root and direct parent after asynchronous creation', () => {
    const root = parent(); const child = parent('child', 'child-request');
    const budget = new DelegationBudget();
    const first = budget.reserve(root, [root]); child.delegation = first.delegation; first.release();
    const reserved = budget.reserve(child, [root, child]);
    expect(() => assertCurrentDelegationObjective(child, [root, child], reserved.delegation)).not.toThrow();
    const changedRoot = parent('root', 'new-root-request');
    expect(() => assertCurrentDelegationObjective(child, [changedRoot, child], reserved.delegation)).toThrow('no longer current');
    const changedParent = { ...parent('child', 'new-child-request'), delegation: child.delegation };
    expect(() => assertCurrentDelegationObjective(child, [root, changedParent], reserved.delegation)).toThrow('no longer current');
    expect(() => assertCurrentDelegationObjective(child, [root], reserved.delegation)).toThrow('no longer current');
    reserved.release();
  });

  it('blocks dispatch when its objective completed or was blocked during preparation', () => {
    const root = parent(); const budget = new DelegationBudget();
    const reserved = budget.reserve(root, [root]);
    for (const terminalState of ['complete_verified', 'blocked_human'] as const) {
      root.activeObjective!.terminalState = terminalState;
      expect(() => assertCurrentDelegationObjective(root, [root], reserved.delegation)).toThrow(DelegationBudgetError);
      expect(() => budget.reserve(root, [root])).toThrow(DelegationBudgetError);
    }
    reserved.release();
  });

  it('shares reservations across siblings and releases exactly once after a failed creation', () => {
    const root = parent(); const budget = new DelegationBudget();
    const initial = budget.reserve(root, [root]);
    const child = { ...parent('child'), delegation: initial.delegation }; initial.release();
    const pending = Array.from({ length: 3 }, () => budget.reserve(child, [root, child]));
    expect(() => budget.reserve(root, [root, child])).toThrow('Concurrent');
    pending[0]!.release(); pending[0]!.release();
    const replacement = budget.reserve(root, [root, child]);
    expect(() => budget.reserve(child, [root, child])).toThrow('Concurrent');
    replacement.release(); for (const reservation of pending) reservation.release();
  });

  it('rejects corrupt persisted depths instead of restarting the depth budget', () => {
    const root = parent(); const budget = new DelegationBudget();
    const reservation = budget.reserve(root, [root]); reservation.release();
    for (const depth of [-1, 0, 0.5, NaN, Infinity]) {
      const child = { ...parent('child'), delegation: { ...reservation.delegation, depth } };
      expect(() => budget.reserve(child, [root, child])).toThrow('Invalid persisted');
    }
  });

  it('counts a resumed child as processing even if a previous dispatch recorded finishedAt', () => {
    const root = parent(); const budget = new DelegationBudget();
    const reservation = budget.reserve(root, [root]); reservation.release();
    const resumed = Array.from({ length: 4 }, (_, index) => ({
      ...parent(`child-${index}`), delegation: { ...reservation.delegation, finishedAt: 10 },
    }));
    expect(() => budget.reserve(root, [root, ...resumed])).toThrow('Concurrent');
    resumed[0]!.isProcessing = false;
    expect(() => budget.reserve(root, [root, ...resumed])).not.toThrow();
  });
});
