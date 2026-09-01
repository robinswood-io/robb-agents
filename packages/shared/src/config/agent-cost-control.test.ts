import { describe, expect, test } from 'bun:test';
import type { LlmConnection } from './llm-connections.ts';
import {
  decideAgentCostControl,
  isBrowserFallbackEligibleTool,
  resolveAgentCostControlPolicy,
} from './agent-cost-control.ts';

const connection: Pick<LlmConnection, 'models' | 'defaultModel'> = {
  models: ['pi/gpt-5.6-sol', 'pi/gpt-5.6-terra', 'pi/gpt-5.6-luna'],
  defaultModel: 'pi/gpt-5.6-sol',
};

describe('decideAgentCostControl', () => {
  test('routes a routine internal message to the cheapest model and low thinking', () => {
    const decision = decideAgentCostControl({
      text: 'Le contrôle est terminé.',
      connection,
      currentModel: 'pi/gpt-5.6-sol',
      turnKind: 'agent-message',
    });

    expect(decision.model).toBe('pi/gpt-5.6-luna');
    expect(decision.thinkingLevel).toBe('low');
    expect(decision.shouldCompact).toBe(false);
  });

  test('keeps a high-risk production action on the strongest model', () => {
    const decision = decideAgentCostControl({
      text: 'Déploie cette migration destructive en production.',
      connection,
      turnKind: 'direct',
    });

    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('xhigh');
    expect(decision.highRisk).toBe(true);
  });

  test('keeps a terse continuation on the strongest model when the historical objective is sensitive', () => {
    const decision = decideAgentCostControl({
      text: 'Poursuis.',
      riskContext: 'Revue comptable Inqom et lettrage des écritures',
      turnKind: 'automatic-recovery',
      connection,
      sessionCostUsd: 80,
    });

    expect(decision.highRisk).toBe(true);
    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('xhigh');
  });

  test('uses the balanced model for an explicitly read-only sensitive audit', () => {
    const decision = decideAgentCostControl({
      text: 'Reprends en lecture seule, sans aucune mutation ni écriture.',
      riskContext: 'Revue comptable Inqom et lettrage des écritures',
      turnKind: 'direct',
      connection,
    });

    expect(decision.highRisk).toBe(true);
    expect(decision.readOnlyRisk).toBe(true);
    expect(decision.model).toBe('pi/gpt-5.6-terra');
    expect(decision.thinkingLevel).toBe('medium');
    expect(decision.explanation).toContain('safety:explicit-read-only');
  });

  test('does not accept a read-only phrase that also requests a mutation', () => {
    const decision = decideAgentCostControl({
      text: 'Vérifie en lecture seule puis applique la correction en production.',
      connection,
    });

    expect(decision.readOnlyRisk).toBe(false);
    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('xhigh');
  });

  test('compacts at 80k and treats 100k as the hard context boundary', () => {
    expect(decideAgentCostControl({ text: 'Continue.', connection, contextTokens: 80_000 }).shouldCompact).toBe(true);
    expect(decideAgentCostControl({ text: 'Continue.', connection, contextTokens: 99_999 }).hardContextLimitReached).toBe(false);
    expect(decideAgentCostControl({ text: 'Continue.', connection, contextTokens: 100_000 }).hardContextLimitReached).toBe(true);
  });

  test('downgrades non-risk work after the hard session budget', () => {
    const decision = decideAgentCostControl({
      text: 'Analyse les résultats et prépare une synthèse détaillée.',
      connection,
      currentModel: 'pi/gpt-5.6-sol',
      sessionCostUsd: 25,
    });

    expect(decision.model).toBe('pi/gpt-5.6-luna');
    expect(decision.budgetState).toBe('hard-limit');
    expect(decision.shouldCompact).toBe(true);
  });

  test('normalizes invalid numeric boundaries', () => {
    const resolved = resolveAgentCostControlPolicy({
      context: { compactAtTokens: 20_000, hardLimitTokens: 10_000 },
      budgets: { softSessionUsd: 7, hardSessionUsd: 3 },
    });

    expect(resolved.context.hardLimitTokens).toBe(20_000);
    expect(resolved.budgets.hardSessionUsd).toBe(7);
  });

  test('fails safe to defaults for malformed persisted fields', () => {
    const resolved = resolveAgentCostControlPolicy({
      enabled: 'yes',
      routing: {
        routineModelPatterns: 5,
        routineThinking: 'unbounded',
      },
      recovery: { browserFallbackToolPatterns: ['web', 5] },
    } as unknown as Parameters<typeof resolveAgentCostControlPolicy>[0]);

    expect(resolved.enabled).toBe(true);
    expect(resolved.routing.routineModelPatterns).toContain('gpt-5.6-luna');
    expect(resolved.routing.routineThinking).toBe('low');
    expect(resolved.recovery.browserFallbackToolPatterns).toContain('browser');
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
