import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { buildObjectiveContractPrompt, currentExplicitReadOnlyAuthorityBoundary, objectiveCostUsd, objectiveRequiresExecutionEvidence, reconstructObjectiveForBranch, transitionObjectiveContract } from "./objective-contract.ts";

describe('durable objective contract', () => {
  it('keeps bare acknowledgments inert but lets contentful continuations retarget a terminal contract', () => {
    const base = transitionObjectiveContract({
      messageId: 'continued-base', text: 'Explique le périmètre de TRAID.', nowMs: 1,
    });
    const reconciled: ActiveSessionObjective = {
      ...base,
      terminalReconciliation: { messageId: 'terminal-marker', timestamp: 2 },
    };
    for (const [index, text] of [
      'Poursuit', 'Continue.', 'OK, poursuis.', 'Yes, continue.',
    ].entries()) {
      const acknowledged = transitionObjectiveContract({
        existing: reconciled, messageId: `continued-ack-${index}`, text, nowMs: 3 + index,
      });
      expect(acknowledged.terminalReconciliation).toEqual(reconciled.terminalReconciliation);
      expect(acknowledged.requiresExecutionEvidence).toBeUndefined();
      expect(acknowledged.amendments).toBeUndefined();
    }

    for (const [index, text] of [
      'Poursuit le développement et les améliorations de TRAID et ses fonctionnalités...',
      'Continue improving TRAID.',
      'poursuit l’analyse et l’optimisation',
      'Réalyse une nouvelle alanlyse et optimsation.',
    ].entries()) {
      const retargeted = transitionObjectiveContract({
        existing: reconciled, messageId: `continued-retarget-${index}`, text, nowMs: 10 + index,
      });
      expect(retargeted.terminalReconciliation).toBeUndefined();
      expect(retargeted.requiresExecutionEvidence).toBe(true);
      expect(retargeted.requiresAcceptanceCriteria).toBe(true);
      expect(retargeted.amendments?.at(-1)).toMatchObject({
        messageId: `continued-retarget-${index}`, text,
      });
    }
  });

  it('does not promote analysis, recommendations, questions or citations about improvements', () => {
    for (const text of [
      'Analyse et recommande des améliorations de TRAID.',
      'Analyse les améliorations possibles de TRAID.',
      'Poursuis l’analyse des améliorations possibles de TRAID.',
      'Poursuit l’alanlyse des optimsations possibles de TRAID.',
      'Continue the analysis of possible optimizations for TRAID.',
      'Poursuit l’analyse des corrections possibles.',
      'Continue the analysis of possible fixes.',
      'Devrait-on poursuivre l’analyse et l’optimisation ?',
      'Poursuivre l’analyse et l’optimisation ?',
      'Devrait-on poursuivre le développement de TRAID ?',
      'Should we continue developing TRAID?',
      'Devrait-on analyser puis améliorer TRAID ?',
      'Faut-il analyser et ensuite améliorer TRAID ?',
      'Should we analyze and then improve TRAID?',
      'Would it be better to improve TRAID?',
      'Do you recommend improving TRAID?',
      'Le rapport recommande : Poursuit le développement de TRAID.',
      'The report recommends: Continue developing TRAID.',
      'Citation : Améliore TRAID.',
      'Example: Improve TRAID.',
      'Analyse : améliore TRAID.',
      'Analysis: improve TRAID.',
      'Recommandation : améliore TRAID.',
      'Recommendation: improve TRAID.',
      'Exemple d’instruction : améliore TRAID.',
      'Example instruction: improve TRAID.',
      'Analyse cette instruction :\nContinue developing TRAID.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: `continued-negative-${text}`, text });
      expect(objective.requiresExecutionEvidence).not.toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(false);
    }
  });

  it('keeps a bare Reprend acknowledgment on the active objective without inventing new authority', () => {
    const observational = transitionObjectiveContract({
      messageId: 'reprise-root', text: 'Explique le périmètre de TRAID.', nowMs: 1,
    });
    for (const text of ['Reprend', 'Reprends', 'Reprendre']) {
      const resumed = transitionObjectiveContract({
        existing: observational, messageId: `reprise-${text}`, text, nowMs: 2,
      });
      expect(resumed.objectiveId).toBe(observational.objectiveId);
      expect(resumed.userMessageId).toBe(observational.userMessageId);
      expect(resumed.lastUserMessageId).toBe(`reprise-${text}`);
      expect(resumed.amendments).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence(resumed)).toBe(false);
    }

    const executable = transitionObjectiveContract({
      messageId: 'reprise-exec-root', text: 'Améliore TRAID.', nowMs: 1,
    });
    const resumedExecutable = transitionObjectiveContract({
      existing: executable, messageId: 'reprise-exec', text: 'Reprend', nowMs: 2,
    });
    expect(resumedExecutable.objectiveId).toBe(executable.objectiveId);
    expect(resumedExecutable.amendments).toBeUndefined();
    expect(objectiveRequiresExecutionEvidence(resumedExecutable)).toBe(true);
  });

  it('reclassifies amendments without reviving negated legacy work and promotes sensitive writes to missions', () => {
    const initial = transitionObjectiveContract({ messageId: 'root', text: 'Explique simplement ce terme.' });
    for (const text of [
      'Do not modify the security settings; only explain them.',
      'Ne modifie rien, explique seulement la configuration.',
      'The plan says delete the legal records. Explain whether it is safe.',
      'Le rapport recommande de copier les données clients. Analyse seulement la proposition.',
    ]) {
      const amended = transitionObjectiveContract({
        existing: { ...initial, requiresExecutionEvidence: true },
        messageId: `negative-${text}`, text,
      });
      expect(amended.requiresExecutionEvidence).not.toBe(true);
      expect(amended.evidenceRequirement).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence(amended)).toBe(false);
    }

    const amended = transitionObjectiveContract({
      existing: initial, messageId: 'positive-amendment',
      text: 'Copie maintenant les données clients dans Dropbox.',
    });
    expect(amended).toMatchObject({
      risk: 'high-stakes', orchestrationMode: 'mission', requiresExecutionEvidence: true,
    });
    expect(amended.evidenceRequirement).toBeUndefined();
    expect(amended.evidenceDomain).toBeUndefined();
    expect(amended.completionCriteria).toContain('independent-review-passed');
  });

  it('revokes inherited local mutation authority until a later explicit positive amendment', () => {
    const root = transitionObjectiveContract({
      messageId: 'mutation-root', text: 'Corrige le fichier /tmp/a.',
    });
    expect(objectiveRequiresExecutionEvidence(root)).toBe(true);

    for (const [index, text] of [
      'Arrête, ne modifie plus rien.',
      'Ne modifie plus rien.',
      'Stop now. Do not change anything else.',
      'Passe désormais en lecture seule.',
    ].entries()) {
      const revoked = transitionObjectiveContract({
        existing: root, messageId: `revocation-${index}`, text,
      });
      expect(revoked.requiresExecutionEvidence).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence(revoked)).toBe(false);

      const neutral = transitionObjectiveContract({
        existing: revoked, messageId: `neutral-${index}`, text: 'Donne-moi simplement le statut.',
      });
      expect(objectiveRequiresExecutionEvidence(neutral)).toBe(false);

      const resumed = transitionObjectiveContract({
        existing: neutral, messageId: `resume-${index}`,
        text: 'Reprends et corrige explicitement le fichier /tmp/a.',
      });
      expect(resumed.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(resumed)).toBe(true);
    }
  });

  it('keeps inherited mutation authority when a prohibition is only a safety precondition', () => {
    const root = transitionObjectiveContract({
      messageId: 'conditional-mutation-root',
      text: 'Corrige puis déploie le service Orion.',
    });

    for (const [index, text] of [
      "N’effectue aucune modification sans vérifier les tests avant.",
      'Aucune modification avant de valider la sauvegarde.',
      'No changes before the tests pass.',
      'Do not modify anything without checking the backup first.',
    ].entries()) {
      const guarded = transitionObjectiveContract({
        existing: root,
        messageId: `conditional-mutation-guard-${index}`,
        text,
      });
      expect(guarded.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(guarded)).toBe(true);
    }

    const revoked = transitionObjectiveContract({
      existing: root,
      messageId: 'unconditional-mutation-revocation',
      text: 'N’effectue aucune mutation distante et ne déploie rien.',
    });
    expect(objectiveRequiresExecutionEvidence(revoked)).toBe(false);

    for (const [index, text] of [
      "N’effectue aucune mutation même après avoir vérifié les tests.",
      'Do not modify anything, even after the tests pass.',
      'Aucune modification après vérification des tests.',
      'N’effectue aucune mutation sans validation explicite de ma part.',
      'Do not modify anything without my validation.',
      'Do not modify anything without my review.',
      'Aucune modification avant le contrôle humain.',
      'No changes until human review.',
    ].entries()) {
      const afterConditionStillRevokes = transitionObjectiveContract({
        existing: root,
        messageId: `post-check-revocation-${index}`,
        text,
      });
      expect(objectiveRequiresExecutionEvidence(afterConditionStillRevokes)).toBe(false);
    }
  });

  it('treats an exclusive read-only preflight as a current mutation-authority boundary', () => {
    const rootText = 'Déploie la version sur le serveur de staging puis vérifie-la.';
    const restriction = 'Effectue uniquement le préflight en lecture seule. N’effectue aucune mutation distante et ne déploie rien.';
    const root = transitionObjectiveContract({ messageId: 'preflight-root', text: rootText, nowMs: 1 });
    const restricted = transitionObjectiveContract({
      existing: root, messageId: 'preflight-only', text: restriction, nowMs: 2,
    });
    const transcript: Message[] = [
      { id: 'preflight-root', role: 'user', content: rootText, timestamp: 1 },
      { id: 'preflight-only', role: 'user', content: restriction, timestamp: 2 },
    ];
    expect(objectiveRequiresExecutionEvidence(restricted)).toBe(false);
    expect(currentExplicitReadOnlyAuthorityBoundary(restricted, transcript)).toEqual({
      messageId: 'preflight-only', text: restriction, timestamp: 2,
    });
    expect(buildObjectiveContractPrompt(restricted, transcript)).toContain(
      'Only then may blocked_human with kind external_authorization cite that exact user message ID',
    );

    const resumedText = 'Déploie maintenant explicitement la version sur le serveur de staging.';
    const resumed = transitionObjectiveContract({
      existing: restricted, messageId: 'preflight-resumed', text: resumedText, nowMs: 3,
    });
    expect(objectiveRequiresExecutionEvidence(resumed)).toBe(true);
    expect(currentExplicitReadOnlyAuthorityBoundary(resumed, [...transcript, {
      id: 'preflight-resumed', role: 'user', content: resumedText, timestamp: 3,
    }])).toBeUndefined();

    const deploymentOnlyLimit = transitionObjectiveContract({
      existing: root, messageId: 'no-deploy-only',
      text: 'Corrige localement le service, mais ne déploie rien.', nowMs: 4,
    });
    expect(objectiveRequiresExecutionEvidence(deploymentOnlyLimit)).toBe(true);
    expect(currentExplicitReadOnlyAuthorityBoundary(deploymentOnlyLimit, [transcript[0]!, {
      id: 'no-deploy-only', role: 'user', content: 'Corrige localement le service, mais ne déploie rien.', timestamp: 4,
    }])).toBeUndefined();
  });

  it('keeps the objective and budget baseline for terse continuation variants', () => {
    const initial = transitionObjectiveContract({
      messageId: 'u1', text: 'Diagnostique et corrige ce problème complexe.', lifetimeCostUsd: 20,
    });
    const continued = transitionObjectiveContract({
      existing: initial, messageId: 'u2', text: 'Fais le avec précision', lifetimeCostUsd: 80,
    });
    expect(continued.userMessageId).toBe('u1');
    expect(continued.budgetBaselineUsd).toBe(20);
    expect(continued.continuationCount).toBe(1);
    expect(objectiveCostUsd(continued, 24)).toBe(4);
  });

  it('preserves root identity and budget across colloquial and misspelled French resumptions', () => {
    const initial = {
      ...transitionObjectiveContract({
        messageId: 'root-user',
        text: 'Implémente la synchronisation puis vérifie le résultat.',
        lifetimeCostUsd: 20,
        nowMs: 10,
      }),
      terminalState: 'complete_verified' as const,
      completedAt: 20,
    };

    for (const [index, text] of [
      'Bah poursuit alors',
      'alors continue',
      'Reprned exactement où tu en étais',
      "Il faut qu'il s'occupe aussi du dépôt",
      "Non, ce n'est pas terminé",
    ].entries()) {
      const continued = transitionObjectiveContract({
        existing: initial,
        messageId: `follow-up-${index}`,
        text,
        lifetimeCostUsd: 90,
      });
      expect(continued.objectiveId).toBe('root-user');
      expect(continued.userMessageId).toBe('root-user');
      expect(continued.lastUserMessageId).toBe(`follow-up-${index}`);
      expect(continued.budgetBaselineUsd).toBe(20);
      expect(continued.terminalState).toBe('active');
      expect(continued.completedAt).toBeUndefined();
    }
  });

  it('starts a fresh budget for an unrelated new objective', () => {
    const first = transitionObjectiveContract({ messageId: 'u1', text: 'Corrige le bug.', lifetimeCostUsd: 12 });
    const second = transitionObjectiveContract({
      existing: first, messageId: 'u2', text: 'Nouvelle demande : résume ce document.', lifetimeCostUsd: 40,
    });
    expect(second.userMessageId).toBe('u2');
    expect(second.objectiveId).toBe('u2');
    expect(second.lastUserMessageId).toBe('u2');
    expect(second.budgetBaselineUsd).toBe(40);
  });

  it('reconstructs a branch objective only from messages visible at its anchor', () => {
    const root: Message = {
      id: 'root', role: 'user', timestamp: 1,
      content: 'Implémente la migration dans tous les paquets puis vérifie les tests.',
    };
    const rootReply: Message = { id: 'reply', role: 'assistant', timestamp: 2, content: 'En cours.' };
    const future: Message = {
      id: 'future', role: 'user', timestamp: 3,
      content: 'Nouvel objectif : résume seulement le README.',
    };
    const sourceObjective = transitionObjectiveContract({
      messageId: future.id, text: future.content, nowMs: future.timestamp,
    });
    const branched = reconstructObjectiveForBranch({
      messages: [root, rootReply],
      sourceObjective,
      completeSourceHistory: false,
    });
    expect(branched).toMatchObject({
      userMessageId: root.id,
      originalText: root.content,
      requiresExecutionEvidence: true,
      requiresObservationEvidence: true,
      requiresAcceptanceCriteria: true,
    });
    const continued = transitionObjectiveContract({
      existing: branched, messageId: 'continue', text: 'Continue.', nowMs: 4,
    });
    expect(continued.userMessageId).toBe(root.id);
    expect(continued.requiresExecutionEvidence).toBe(true);
  });

  it('keeps active mission steps until the user explicitly changes objectives', () => {
    const first = transitionObjectiveContract({
      messageId: 'u1', text: 'Analyse et corrige la campagne.', lifetimeCostUsd: 12,
    });
    const scopedFollowUp = transitionObjectiveContract({
      existing: first,
      messageId: 'u2',
      text: 'Vérifie maintenant les sociétés restantes.',
      lifetimeCostUsd: 30,
    });
    expect(scopedFollowUp.userMessageId).toBe('u1');
    const nextStep = transitionObjectiveContract({
      existing: scopedFollowUp,
      messageId: 'u-independent',
      text: 'Prépare le budget marketing 2027 à partir du tableur joint.',
      lifetimeCostUsd: 30.5,
    });
    expect(nextStep.userMessageId).toBe('u1');
    const replacement = transitionObjectiveContract({
      existing: scopedFollowUp,
      messageId: 'u3',
      text: 'Nouvel objectif : prépare un autre dossier.',
      lifetimeCostUsd: 31,
    });
    expect(replacement.userMessageId).toBe('u3');
    expect(replacement.budgetBaselineUsd).toBe(31);
  });

  it('retains the original acceptance contract and accounting across active clarifications', () => {
    const original = {
      ...transitionObjectiveContract({
        messageId: 'root', text: 'Prépare le PDF demandé puis vérifie son rendu.',
        lifetimeCostUsd: 12, lifetimeTokens: 100, nowMs: 1,
      }),
      acceptanceCriteria: [{ id: 'pdf-render', description: 'PDF rendu', toolName: 'Read',
        input: { file_path: '/tmp/report.pdf' }, checks: [{ path: 'valid', equals: true }] }],
      acceptanceRegisteredAt: 2,
    };
    for (const text of [
      'le PDF reste illisible',
      'utilise plutôt le navigateur',
      'ce sont les données de 2025',
      'Le nouveau document reste illisible, utilise plutôt le navigateur.',
      'Le nouveau fichier est bien créé mais les formules sont fausses.',
      'N’envoie pas un autre document, vérifie celui qui existe.',
      'Ne change pas de sujet, vérifie le fichier.',
      'Je ne veux pas une nouvelle mission, termine celle-ci.',
      'N’abandonne pas cette mission.',
      'Don’t start a new task; verify the existing file.',
      'The new document is still unreadable.',
    ]) {
      const continued = transitionObjectiveContract({
        existing: original, messageId: 'feedback', text, lifetimeCostUsd: 40, lifetimeTokens: 500, nowMs: 3,
      });
      expect(continued).toMatchObject({
        userMessageId: 'root', objectiveId: 'root', lastUserMessageId: 'feedback',
        originalText: original.originalText, startedAt: 1, budgetBaselineUsd: 12, tokenBaseline: 100,
        acceptanceRegisteredAt: 2, acceptanceCriteria: original.acceptanceCriteria,
        completionCriteria: original.completionCriteria, continuationCount: 1,
      });
      expect(objectiveCostUsd(continued, 40)).toBe(28);
    }
  });

  it('resets the contract only for explicit new missions or abandonment instructions', () => {
    const original = {
      ...transitionObjectiveContract({ messageId: 'root', text: 'Corrige le rapport.', lifetimeCostUsd: 12 }),
      acceptanceCriteria: [{ id: 'report-valid', description: 'Rapport vérifié', toolName: 'Read',
        input: { file_path: '/tmp/report.pdf' }, checks: [{ path: 'valid', equals: true }] }],
    };
    for (const text of [
      'Nouvel objectif : prépare un autre dossier.',
      'Maintenant, nouvelle mission : résume le document.',
      'Je veux une nouvelle mission : analyse la campagne.',
      'Changeons de sujet : prépare le budget.',
      'Change d’objectif : prépare le budget.',
      'Passons à un autre sujet : les factures.',
      'Abandonne cette mission et prépare le budget.',
      'Annule l’objectif précédent et résume le dossier.',
      'New task: inspect the repository.',
      'Switch to a new objective: prepare the budget.',
      'Cancel the current task and inspect the repository.',
    ]) {
      const replacement = transitionObjectiveContract({
        existing: original, messageId: 'new-mission', text, lifetimeCostUsd: 40,
      });
      expect(replacement.userMessageId).toBe('new-mission');
      expect(replacement.originalText).toBe(text);
      expect(replacement.budgetBaselineUsd).toBe(40);
      expect(replacement.acceptanceCriteria).toBeUndefined();
      expect(replacement.continuationCount).toBe(0);
    }
  });
});
