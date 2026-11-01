import { describe, expect, it } from "bun:test";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { isPrecisionOrCompletenessChallenge, transitionObjectiveContract } from "./objective-contract.ts";

describe('durable objective contract', () => {
  it('starts a new objective for a fresh request after completion', () => {
    const completed = {
      ...transitionObjectiveContract({ messageId: 'root', text: 'Prépare le PDF demandé.' }),
      terminalState: 'complete_verified' as const,
    };
    const next = transitionObjectiveContract({
      existing: completed, messageId: 'new-request', text: 'Prépare le budget marketing 2027.', lifetimeCostUsd: 40,
    });
    expect(next.userMessageId).toBe('new-request');
    expect(next.budgetBaselineUsd).toBe(40);
    expect(next.continuationCount).toBe(0);
  });

  it('reopens a terminal email objective when the user corrects only its execution channel', () => {
    const original = {
      ...transitionObjectiveContract({
        messageId: 'email-root',
        text: 'Envoie l’email demandé à Franck puis vérifie sa présence dans les éléments envoyés.',
        lifetimeCostUsd: 12,
        lifetimeTokens: 100,
        nowMs: 1,
      }),
      terminalState: 'exhausted' as const,
      completedAt: 2,
      acceptanceCriteria: [{
        id: 'email-sent',
        description: 'Message vérifié dans les éléments envoyés',
        toolName: 'mcp__gmail__search_emails',
        input: { query: 'in:sent to:franck@example.com' },
        checks: [{ path: 'messages.0.to', equals: 'franck@example.com' }],
      }],
      acceptanceRegisteredAt: 2,
    };

    for (const [index, text] of [
      "Tu n'a pas le droit d'utiliser le navigateur pour envoyer des emails, tu dois utiliser l'API et la source.",
      "Tu as obligation d'utiliser l'API et non l'interface",
      "Utilise l'API et non l'interface",
      'Use the API connector, not the browser UI.',
      "Non, utilise l'API, pas le navigateur.",
    ].entries()) {
      const continued = transitionObjectiveContract({
        existing: original,
        messageId: `channel-correction-${index}`,
        text,
        lifetimeCostUsd: 40,
        lifetimeTokens: 500,
        nowMs: 3,
      });
      expect(continued).toMatchObject({
        userMessageId: 'email-root',
        objectiveId: 'email-root',
        lastUserMessageId: `channel-correction-${index}`,
        originalText: original.originalText,
        terminalState: 'active',
        budgetBaselineUsd: 12,
        tokenBaseline: 100,
        acceptanceCriteria: original.acceptanceCriteria,
        acceptanceRegisteredAt: 2,
        continuationCount: 1,
      });
      expect(continued.completedAt).toBeUndefined();
      expect(continued.amendments?.at(-1)).toMatchObject({
        messageId: `channel-correction-${index}`,
        text,
      });
    }

    const unrelatedChannelMentions: Array<{ text: string; requiresExecutionEvidence: boolean }> = [
      { text: 'Rédige une documentation expliquant que l’interface UI n’utilise pas l’API du serveur avec OAuth.', requiresExecutionEvidence: true },
      { text: 'Non, compare l’interface UI avec l’API du serveur.', requiresExecutionEvidence: false },
      { text: 'The documentation says: the browser UI does not use the API connector.', requiresExecutionEvidence: false },
      { text: 'Documentation example. Use the API connector, not the browser UI.', requiresExecutionEvidence: false },
      { text: 'Compare these options: use the API connector, not the browser UI.', requiresExecutionEvidence: false },
      { text: 'Use the API, not the browser UI and send X.', requiresExecutionEvidence: true },
      { text: 'Use the API not the browser UI and delete the account.', requiresExecutionEvidence: true },
      { text: 'Utilise l’API, pas le navigateur et envoie X.', requiresExecutionEvidence: true },
      { text: 'Utilise l’API, pas le navigateur et supprime le compte.', requiresExecutionEvidence: true },
    ];
    for (const [index, { text, requiresExecutionEvidence }] of unrelatedChannelMentions.entries()) {
      const unrelated = transitionObjectiveContract({
        existing: original,
        messageId: `unrelated-channel-mention-${index}`,
        text,
        lifetimeCostUsd: 40,
        lifetimeTokens: 500,
        nowMs: 3,
      });
      expect(unrelated).toMatchObject({
        userMessageId: `unrelated-channel-mention-${index}`,
        objectiveId: `unrelated-channel-mention-${index}`,
        originalText: text,
        terminalState: 'active',
        budgetBaselineUsd: 40,
        tokenBaseline: 500,
        continuationCount: 0,
      });
      expect(unrelated.requiresExecutionEvidence === true).toBe(requiresExecutionEvidence);
      expect(unrelated.amendments).toBeUndefined();
    }
  });

  it('keeps the exhausted Forms/SharePoint root for the exact API-first operating rule only', () => {
    const originalText = "Documente les données reçues puis crée le formulaire automatisé et stocke les réponses dans la liste SharePoint RH.";
    const root = {
      ...transitionObjectiveContract({
        messageId: 'forms-sharepoint-root', text: originalText,
        lifetimeCostUsd: 17, lifetimeTokens: 3_400, nowMs: 1,
      }),
      terminalState: 'exhausted' as const,
      completedAt: 2,
      acceptanceCriteria: [{
        id: 'forms-sharepoint-verified',
        description: 'Le formulaire et sa liste SharePoint sont vérifiés',
        toolName: 'mcp__microsoft365__get_form',
        input: { name: 'Entretiens Example Org' },
        checks: [{ path: 'sharePointList', equals: 'Entretiens individuels' }],
      }],
      acceptanceRegisteredAt: 2,
    } satisfies ActiveSessionObjective;
    const correction = 'Tu as pour règle de passer par l’API';
    const continued = transitionObjectiveContract({
      existing: root,
      messageId: 'forms-api-rule',
      text: correction,
      lifetimeCostUsd: 91,
      lifetimeTokens: 51_000,
      nowMs: 3,
    });

    expect(continued).toMatchObject({
      objectiveId: 'forms-sharepoint-root',
      userMessageId: 'forms-sharepoint-root',
      lastUserMessageId: 'forms-api-rule',
      originalText,
      terminalState: 'active',
      budgetBaselineUsd: 17,
      tokenBaseline: 3_400,
      acceptanceCriteria: root.acceptanceCriteria,
      acceptanceRegisteredAt: 2,
      continuationCount: 1,
    });
    expect(continued.completedAt).toBeUndefined();
    expect(continued.amendments).toEqual([{
      messageId: 'forms-api-rule', text: correction, timestamp: 3,
    }]);
    const formalCorrection = 'Vous avez pour règle d’utiliser l’API';
    const formallyContinued = transitionObjectiveContract({
      existing: root,
      messageId: 'forms-api-rule-formal',
      text: formalCorrection,
      nowMs: 3,
    });
    expect(formallyContinued.objectiveId).toBe('forms-sharepoint-root');
    expect(formallyContinued.amendments?.at(-1)).toMatchObject({
      messageId: 'forms-api-rule-formal', text: formalCorrection,
    });

    const verified = transitionObjectiveContract({
      existing: { ...root, terminalState: 'complete_verified', completedAt: 2 },
      messageId: 'forms-api-rule-after-completion',
      text: correction,
      lifetimeCostUsd: 91,
      lifetimeTokens: 51_000,
      nowMs: 3,
    });
    expect(verified).toMatchObject({
      objectiveId: 'forms-api-rule-after-completion',
      userMessageId: 'forms-api-rule-after-completion',
      originalText: correction,
      continuationCount: 0,
    });
    expect(verified.amendments).toBeUndefined();

    for (const [index, text] of [
      'Tu as pour règle de passer par l’API et supprime le compte.',
      'Vous avez pour règle d’utiliser l’API puis déployez le connecteur.',
      'Documentation :\nTu as pour règle de passer par l’API',
      'Exemple : Tu as pour règle de passer par l’API',
    ].entries()) {
      const unrelated = transitionObjectiveContract({
        existing: root,
        messageId: `forms-api-rule-adversarial-${index}`,
        text,
        lifetimeCostUsd: 91,
        lifetimeTokens: 51_000,
        nowMs: 3,
      });
      expect(unrelated.objectiveId).toBe(`forms-api-rule-adversarial-${index}`);
      expect(unrelated.userMessageId).toBe(`forms-api-rule-adversarial-${index}`);
      expect(unrelated.continuationCount).toBe(0);
      expect(unrelated.amendments).toBeUndefined();
    }
  });

  it('keeps the exhausted Zero root for the exact deictic private-IP repair only', () => {
    const originalText = 'Réactive le login de développement Zero sur l’IP privée attribuée puis vérifie sa connexion.';
    const root = {
      ...transitionObjectiveContract({
        messageId: 'zero-dev-login-root', text: originalText,
        lifetimeCostUsd: 23, lifetimeTokens: 5_600, nowMs: 1,
      }),
      terminalState: 'exhausted' as const,
      completedAt: 2,
      acceptanceCriteria: [{
        id: 'zero-login-verified',
        description: 'Le login Zero fonctionne sur l’IP privée attribuée',
        toolName: 'mcp__zero__check_login',
        input: { channel: 'private-ip' },
        checks: [{ path: 'authenticated', equals: true }],
      }],
      acceptanceRegisteredAt: 2,
    } satisfies ActiveSessionObjective;
    const correction = 'Répare ça devrait marché on est bien sur l’IP Privée attritrée';
    const continued = transitionObjectiveContract({
      existing: root,
      messageId: 'zero-private-ip-repair',
      text: correction,
      lifetimeCostUsd: 95,
      lifetimeTokens: 60_000,
      nowMs: 3,
    });

    expect(continued).toMatchObject({
      objectiveId: 'zero-dev-login-root',
      userMessageId: 'zero-dev-login-root',
      lastUserMessageId: 'zero-private-ip-repair',
      originalText,
      terminalState: 'active',
      budgetBaselineUsd: 23,
      tokenBaseline: 5_600,
      acceptanceCriteria: root.acceptanceCriteria,
      acceptanceRegisteredAt: 2,
      continuationCount: 1,
    });
    expect(continued.completedAt).toBeUndefined();
    expect(continued.amendments).toEqual([{
      messageId: 'zero-private-ip-repair', text: correction, timestamp: 3,
    }]);

    const verified = transitionObjectiveContract({
      existing: { ...root, terminalState: 'complete_verified', completedAt: 2 },
      messageId: 'zero-private-ip-repair-after-completion',
      text: correction,
      lifetimeCostUsd: 95,
      lifetimeTokens: 60_000,
      nowMs: 3,
    });
    expect(verified).toMatchObject({
      objectiveId: 'zero-private-ip-repair-after-completion',
      userMessageId: 'zero-private-ip-repair-after-completion',
      originalText: correction,
      continuationCount: 0,
    });
    expect(verified.amendments).toBeUndefined();

    for (const [index, text] of [
      'Répare ça puis déploie le connecteur.',
      'Répare ça puis supprime le compte.',
      'Répare ça devrait marcher sur le compte client.',
      'Exemple : Répare ça devrait marché on est bien sur l’IP Privée attritrée',
    ].entries()) {
      const unrelated = transitionObjectiveContract({
        existing: root,
        messageId: `zero-repair-adversarial-${index}`,
        text,
        lifetimeCostUsd: 95,
        lifetimeTokens: 60_000,
        nowMs: 3,
      });
      expect(unrelated.objectiveId).toBe(`zero-repair-adversarial-${index}`);
      expect(unrelated.userMessageId).toBe(`zero-repair-adversarial-${index}`);
      expect(unrelated.continuationCount).toBe(0);
      expect(unrelated.amendments).toBeUndefined();
    }
  });

  it('keeps the live Nimble email root when a short channel correction arrives while active or exhausted', () => {
    const originalText = "Envoi l'e-mail à Benoît, une seule fois après le préflight, puis vérifie le messageId.";
    const root = {
      ...transitionObjectiveContract({
        messageId: 'nimble-email-root', text: originalText,
        lifetimeCostUsd: 18, lifetimeTokens: 4_200, nowMs: 1,
      }),
      acceptanceCriteria: [{
        id: 'gmail-message-id',
        description: 'Le message envoyé possède un messageId',
        toolName: 'mcp__google-contacts__gmail_list_messages',
        input: { query: 'in:sent to:benoit@example.test' },
        checks: [{ path: 'messages.0.id', equals: 'gmail-message-id' }],
      }],
      acceptanceRegisteredAt: 2,
    } satisfies ActiveSessionObjective;

    for (const terminalState of ['active', 'exhausted'] as const) {
      const before = terminalState === 'active' ? root : {
        ...root, terminalState, completedAt: 3,
      };
      const correction = "Tu as obligation d'utiliser l'API et non l'interface";
      const continued = transitionObjectiveContract({
        existing: before,
        messageId: `nimble-api-${terminalState}`,
        text: correction,
        lifetimeCostUsd: 90,
        lifetimeTokens: 50_000,
        nowMs: 4,
      });

      expect(continued).toMatchObject({
        objectiveId: 'nimble-email-root',
        userMessageId: 'nimble-email-root',
        lastUserMessageId: `nimble-api-${terminalState}`,
        originalText,
        terminalState: 'active',
        budgetBaselineUsd: 18,
        tokenBaseline: 4_200,
        acceptanceCriteria: root.acceptanceCriteria,
        acceptanceRegisteredAt: 2,
        continuationCount: 1,
      });
      expect(continued.amendments).toEqual([{
        messageId: `nimble-api-${terminalState}`,
        text: correction,
        timestamp: 4,
      }]);
      expect(continued.completedAt).toBeUndefined();
    }
  });

  it('never revives a verified objective from a channel-only correction', () => {
    const originalText = "Envoi l'e-mail à Benoît, une seule fois après le préflight, puis vérifie le messageId.";
    const root = {
      ...transitionObjectiveContract({
        messageId: 'verified-email-root', text: originalText,
        lifetimeCostUsd: 18, lifetimeTokens: 4_200, nowMs: 1,
      }),
      terminalState: 'complete_verified' as const,
      completedAt: 2,
    };
    const correction = "Tu as obligation d'utiliser l'API et non l'interface";
    const next = transitionObjectiveContract({
      existing: root,
      messageId: 'post-completion-channel-correction',
      text: correction,
      lifetimeCostUsd: 90,
      lifetimeTokens: 50_000,
      nowMs: 3,
    });

    expect(next).toMatchObject({
      objectiveId: 'post-completion-channel-correction',
      userMessageId: 'post-completion-channel-correction',
      lastUserMessageId: 'post-completion-channel-correction',
      originalText: correction,
      terminalState: 'active',
      budgetBaselineUsd: 90,
      tokenBaseline: 50_000,
      continuationCount: 0,
    });
    expect(next.amendments).toBeUndefined();
    expect(next.requiresExecutionEvidence).toBeUndefined();
  });

  it('recognizes precision and completeness challenge phrases', () => {
    for (const phrase of [
      'Avec précision',
      'Sois plus précis',
      'Plus de précision',
      'C’est incomplet',
      'Incomplet',
      'Ce n’est pas complet',
      'Ce n’est pas suffisant',
      'Il manque des informations',
      'Tu as oublié les accès hébergement',
      'Tu as omis les identifiants',
      'Tu as zappé les accès',
      'Be more precise',
      'Incomplete',
      'Missing information',
      'Approfondis',
      'Ce n’est pas exhaustif',
      'Pas exhaustif',
      'Trop superficiel',
      'Trop court',
      'Creuse davantage',
      'Où sont les accès ?',
      'Not exhaustive',
      'Dig deeper',
      'Where are the credentials?',
    ]) {
      expect(isPrecisionOrCompletenessChallenge(phrase)).toBe(true);
    }

    for (const nonChallenge of [
      'Merci.',
      'Bonjour',
      'Oui',
      'D’accord',
      'Fais le',
    ]) {
      expect(isPrecisionOrCompletenessChallenge(nonChallenge)).toBe(false);
    }
  });
});
