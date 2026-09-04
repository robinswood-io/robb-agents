import { describe, expect, test } from 'bun:test';
import type { LlmConnection } from './llm-connections.ts';
import {
  decideAgentCostControl,
  isBrowserFallbackEligibleTool,
  resolveEffectiveAgentContextLimits,
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

  test('routes a completion-only review handoff to the cheapest model', () => {
    const decision = decideAgentCostControl({
      text: 'Reprends uniquement depuis le dernier état vérifié. Vérifie si l’objectif initial est déjà achevé. S’il l’est, ne relance aucun audit ni appel réseau, résume brièvement puis place le chat en needs-review.',
      connection,
      currentModel: 'pi/gpt-5.6-sol',
      turnKind: 'direct',
      contextTokens: 20_000,
    });

    expect(decision.completionReviewOnly).toBe(true);
    expect(decision.difficulty).toBe('simple');
    expect(decision.model).toBe('pi/gpt-5.6-luna');
    expect(decision.thinkingLevel).toBe('low');
    expect(decision.explanation).toContain('cost:completion-review-only');
  });

  test('keeps a sensitive completion-only review handoff on the balanced model', () => {
    const decision = decideAgentCostControl({
      text: 'Vérifie si l’objectif est déjà terminé, sans aucun audit ni effet externe, puis place le chat en needs-review.',
      riskContext: 'Déploiement de production et migration de sécurité',
      connection,
      currentModel: 'pi/gpt-5.6-sol',
      turnKind: 'direct',
    });

    expect(decision.completionReviewOnly).toBe(true);
    expect(decision.readOnlyRisk).toBe(true);
    expect(decision.model).toBe('pi/gpt-5.6-terra');
    expect(decision.thinkingLevel).toBe('medium');
  });

  test('does not downgrade a review handoff that also requests a mutation', () => {
    const decision = decideAgentCostControl({
      text: 'Vérifie si l’objectif est déjà terminé, sans aucun audit ni effet externe, puis supprime les données et place le chat en needs-review.',
      connection,
      turnKind: 'direct',
    });

    expect(decision.completionReviewOnly).toBe(false);
    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('xhigh');
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
    expect(decision.criticalRisk).toBe(true);
  });

  test('does not confuse a business production category with a production environment', () => {
    const decision = decideAgentCostControl({
      text: 'Rassemble les réponses par Marketing / Production / Support avec les pourcentages.',
      riskContext: 'Analyse anonyme des usages de l’IA en entreprise.',
      connection,
      turnKind: 'direct',
    });

    expect(decision.highRisk).toBe(false);
    expect(decision.criticalRisk).toBe(false);
    expect(decision.model).toBe('pi/gpt-5.6-luna');
    expect(decision.thinkingLevel).toBe('low');
  });

  test('still protects an action targeting a production environment', () => {
    const decision = decideAgentCostControl({
      text: 'Redémarre le serveur de production puis vérifie le service.',
      connection,
      turnKind: 'direct',
    });

    expect(decision.highRisk).toBe(true);
    expect(decision.criticalRisk).toBe(true);
    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('xhigh');
  });

  test('routes NDA drafting as critical legal work', () => {
    const decision = decideAgentCostControl({
      text: 'Fais évoluer notre NDA pour une présentation à des investisseurs.',
      connection,
      turnKind: 'direct',
    });

    expect(decision.highRisk).toBe(true);
    expect(decision.criticalRisk).toBe(true);
    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('xhigh');
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

  test('inherits complex task difficulty for a terse direct continuation', () => {
    const decision = decideAgentCostControl({
      text: 'Fais-le avec précision.',
      riskContext: 'Diagnostic approfondi d’un import API bloqué, analyse du runtime et correction multi-étapes.',
      turnKind: 'direct',
      connection,
    });

    expect(decision.difficulty).toBe('complex');
    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('high');
  });

  test('does not inherit historical complexity for an unrelated short acknowledgement', () => {
    const decision = decideAgentCostControl({
      text: 'Merci.',
      riskContext: 'Diagnostic approfondi d’un import API bloqué, analyse du runtime et correction multi-étapes.',
      turnKind: 'direct',
      connection,
    });

    expect(decision.difficulty).toBe('simple');
    expect(decision.model).toBe('pi/gpt-5.6-luna');
    expect(decision.thinkingLevel).toBe('low');
  });

  test('does not route a technical automatic recovery as routine work', () => {
    const decision = decideAgentCostControl({
      text: '<automatic_turn_recovery attempt="1">Continue the interrupted task.</automatic_turn_recovery>',
      riskContext: 'Diagnostic approfondi d’un processus API bloqué, analyse du runtime et correction multi-étapes.',
      turnKind: 'automatic-recovery',
      connection,
    });

    expect(decision.difficulty).toBe('complex');
    expect(decision.model).toBe('pi/gpt-5.6-terra');
    expect(decision.thinkingLevel).toBe('medium');
  });

  test('escalates a second automatic recovery to the senior model despite the session budget', () => {
    const decision = decideAgentCostControl({
      text: '<automatic_turn_recovery attempt="2">Continue with a materially different hypothesis.</automatic_turn_recovery>',
      riskContext: 'Diagnostic approfondi d’un processus API bloqué, analyse du runtime et correction multi-étapes.',
      turnKind: 'automatic-recovery',
      connection,
      sessionCostUsd: 80,
    });

    expect(decision.budgetState).toBe('hard-limit');
    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('high');
    expect(decision.explanation).toContain('recovery:senior-attempt-2');
  });

  test('keeps a high-risk automatic recovery at the maximum safety reasoning', () => {
    const decision = decideAgentCostControl({
      text: '<automatic_turn_recovery attempt="2">Continue the production deployment recovery.</automatic_turn_recovery>',
      riskContext: 'Migration destructive en production.',
      turnKind: 'automatic-recovery',
      connection,
      sessionCostUsd: 80,
    });

    expect(decision.model).toBe('pi/gpt-5.6-sol');
    expect(decision.thinkingLevel).toBe('xhigh');
  });

  test('uses the balanced model with high thinking for a reversible permission change', () => {
    const decision = decideAgentCostControl({
      text: 'Autorise les membres existants à publier dans ce groupe, puis vérifie le réglage.',
      riskContext: 'Configuration de sécurité et permissions Google Groups',
      turnKind: 'direct',
      connection,
    });

    expect(decision.highRisk).toBe(true);
    expect(decision.criticalRisk).toBe(false);
    expect(decision.readOnlyRisk).toBe(false);
    expect(decision.model).toBe('pi/gpt-5.6-terra');
    expect(decision.thinkingLevel).toBe('high');
    expect(decision.explanation).toContain('safety:guarded-high-risk');
  });

  test('uses the balanced model for an explicitly read-only sensitive audit', () => {
    const decision = decideAgentCostControl({
      text: 'Reprends en lecture seule, sans aucune mutation ni écriture.',
      riskContext: 'Revue comptable Inqom et lettrage des écritures',
      turnKind: 'direct',
      connection,
    });

    expect(decision.highRisk).toBe(true);
    expect(decision.criticalRisk).toBe(false);
    expect(decision.readOnlyRisk).toBe(true);
    expect(decision.model).toBe('pi/gpt-5.6-terra');
    expect(decision.thinkingLevel).toBe('medium');
    expect(decision.explanation).toContain('safety:explicit-read-only');
  });

  test('does not mistake the noun paiement in a read-only prohibition for an imperative', () => {
    const decision = decideAgentCostControl({
      text: 'Reprends en lecture seule, sans aucune souscription, modification contractuelle, paiement ni engagement.',
      riskContext: 'Choix de couverture assurance',
      turnKind: 'direct',
      connection,
    });

    expect(decision.criticalRisk).toBe(true);
    expect(decision.readOnlyRisk).toBe(true);
    expect(decision.model).toBe('pi/gpt-5.6-terra');
    expect(decision.thinkingLevel).toBe('medium');
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

  test('clamps context limits to smaller model windows', () => {
    const limits = resolveEffectiveAgentContextLimits(
      resolveAgentCostControlPolicy().context,
      64_000,
    );

    expect(limits).toEqual({ compactAtTokens: 44_800, hardLimitTokens: 54_400 });
    expect(decideAgentCostControl({
      text: 'Continue.',
      connection,
      contextTokens: 50_000,
      contextWindow: 64_000,
    }).shouldCompact).toBe(true);
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
    expect(decision.shouldCompact).toBe(false);
  });

  test('does not compact a small context solely because the dollar budget is exceeded', () => {
    const decision = decideAgentCostControl({
      text: 'Résume ce point.',
      connection,
      contextTokens: 4_000,
      sessionCostUsd: 30,
    });

    expect(decision.budgetState).toBe('hard-limit');
    expect(decision.shouldCompact).toBe(false);
  });

  test('normalizes invalid numeric boundaries', () => {
    const resolved = resolveAgentCostControlPolicy({
      context: { compactAtTokens: 20_000, hardLimitTokens: 10_000 },
      budgets: { softSessionUsd: 7, hardSessionUsd: 3 },
    });

    expect(resolved.context.hardLimitTokens).toBe(20_000);
    expect(resolved.budgets.hardSessionUsd).toBe(7);
    expect(resolved.recovery.maxAutomaticAttempts).toBe(3);
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
