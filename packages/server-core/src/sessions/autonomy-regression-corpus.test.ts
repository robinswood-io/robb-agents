import { describe, expect, it } from 'bun:test';
import { isContextDependentDirectTurn } from '@craft-agent/shared/config/agent-cost-control';
import { AUTONOMY_REGRESSION_CORPUS } from './autonomy-regression-corpus.ts';
import {
  classifyObjectiveTerminalState,
  looksLikePrematureFinalAssistant,
} from './turn-completion.ts';

describe('72-hour autonomy regression corpus', () => {
  it('recovers every observed explicit unfinished final', () => {
    for (const sample of AUTONOMY_REGRESSION_CORPUS.prematureFinals) {
      expect(looksLikePrematureFinalAssistant(sample)).toBe(true);
      expect(classifyObjectiveTerminalState(sample)).toBe('continue');
    }
  });

  it('inherits context for every observed terse continuation', () => {
    for (const sample of AUTONOMY_REGRESSION_CORPUS.continuationTurns) {
      expect(isContextDependentDirectTurn(sample)).toBe(true);
    }
  });

  it('preserves genuine human-only blockers', () => {
    for (const sample of AUTONOMY_REGRESSION_CORPUS.legitimateHumanBlocks) {
      expect(classifyObjectiveTerminalState(sample)).toBe('blocked_human');
    }
  });
});
