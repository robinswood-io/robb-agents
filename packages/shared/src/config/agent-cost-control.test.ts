import { describe, expect, test } from 'bun:test';
import {
  isContextDependentDirectTurn,
  isBrowserFallbackEligibleTool,
  resolveEffectiveAgentContextLimits,
  resolveAgentCostControlPolicy,
} from './agent-cost-control.ts';

describe('public agent context and recovery controls', () => {
  test('preserves bounded context, recovery and coordination defaults', () => {
    const resolved = resolveAgentCostControlPolicy();
    expect(resolved.context).toEqual({ compactAtTokens: 80_000, hardLimitTokens: 100_000 });
    expect(resolved.recovery.maxAutomaticAttempts).toBe(8);
    expect(resolved.recovery.maxNoProgressAttempts).toBe(2);
    expect(resolved.coordination.maxQueuedMessages).toBe(8);
  });

  test('ignores legacy automatic model settings without rejecting an existing workspace', () => {
    const legacy = {
      context: { compactAtTokens: 40_000 },
      routing: { enabled: true, routineModelPatterns: ['legacy-model'], routineThinking: 'low' },
    };
    const resolved = resolveAgentCostControlPolicy(legacy);
    expect(resolved.context.compactAtTokens).toBe(40_000);
    expect('routing' in resolved).toBe(false);
    expect('model' in resolved).toBe(false);
    expect('thinkingLevel' in resolved).toBe(false);
  });

  test('clamps context limits to smaller model windows', () => {
    expect(resolveEffectiveAgentContextLimits(resolveAgentCostControlPolicy().context, 64_000))
      .toEqual({ compactAtTokens: 44_800, hardLimitTokens: 54_400 });
  });

  test('retains limits when the active context window is unknown or malformed', () => {
    const context = resolveAgentCostControlPolicy().context;
    for (const window of [undefined, Number.NaN, 0, 2_000]) {
      expect(resolveEffectiveAgentContextLimits(context, window)).toEqual(context);
    }
  });

  test('normalizes invalid numeric boundaries', () => {
    const resolved = resolveAgentCostControlPolicy({
      context: { compactAtTokens: 20_000, hardLimitTokens: 10_000 },
      budgets: { softSessionUsd: 7, hardSessionUsd: 3 },
      recovery: { maxAutomaticAttempts: -2, maxNoProgressAttempts: 0 },
      coordination: { maxQueuedMessages: 0 },
    });
    expect(resolved.context.hardLimitTokens).toBe(20_000);
    expect(resolved.budgets.hardSessionUsd).toBe(7);
    expect(resolved.recovery.maxAutomaticAttempts).toBe(0);
    expect(resolved.recovery.maxNoProgressAttempts).toBe(1);
    expect(resolved.coordination.maxQueuedMessages).toBe(1);
  });

  test('fails safe to defaults for malformed persisted fields', () => {
    const resolved = resolveAgentCostControlPolicy({
      enabled: 'yes',
      recovery: { browserFallbackToolPatterns: ['web', 5] },
    } as unknown as Parameters<typeof resolveAgentCostControlPolicy>[0]);
    expect(resolved.enabled).toBe(true);
    expect(resolved.recovery.browserFallbackToolPatterns).toContain('browser');
  });

  test('recognizes terse objective continuations without selecting a model', () => {
    for (const text of ['Fais le', 'Fais le avec précision', 'Go', 'Ok go', 'OK, fais le', 'Poursuit', 'Reprends']) {
      expect(isContextDependentDirectTurn(text)).toBe(true);
    }
    expect(isContextDependentDirectTurn('Merci.')).toBe(false);
  });
});

describe('isBrowserFallbackEligibleTool', () => {
  test('allows semantically browser-equivalent connectors', () => {
    expect(isBrowserFallbackEligibleTool('mcp__github__search_code')).toBe(true);
    expect(isBrowserFallbackEligibleTool('web_fetch')).toBe(true);
  });

  test('rejects local and coordination tools', () => {
    expect(isBrowserFallbackEligibleTool('Bash')).toBe(false);
    expect(isBrowserFallbackEligibleTool('Read')).toBe(false);
    expect(isBrowserFallbackEligibleTool('send_agent_message')).toBe(false);
  });
});
