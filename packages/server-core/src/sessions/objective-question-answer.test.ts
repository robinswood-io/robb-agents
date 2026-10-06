import { describe, expect, it } from 'bun:test';
import {
  buildObjectiveContractPrompt,
  objectiveRequiresExecutionEvidence,
  transitionObjectiveContract,
} from './objective-contract.ts';
import { classifyObjectiveTerminalState } from './turn-completion.ts';
import { requiresStructuredObjectiveOutcome } from './objective-completion-policy.ts';

const french = 'Contrôle local des questions : utilise request_user_input pour me demander une seule couleur, avec les choix Bleu et Vert. Attends ma réponse, puis réponds simplement QUESTION-C0F40645 suivi de la couleur choisie. Aucune action externe, aucun fichier, aucune autre tâche.';
const english = 'Use request_user_input to ask me one preference with two choices. Wait for my answer, then respond only with my chosen answer. No external actions, no files, no other tasks.';
const nativeScript = 'Test technique de non-régression UI db4df1c6. Pose exactement une question avec l’outil de question utilisateur : « Couleur du contrôle de reprise ? », choix Bleu ou Vert. Attends ma réponse. Dès que je réponds, termine avec une seule phrase : « REPRISE-DB4DF1C6 : <couleur choisie> ». Aucun fichier à modifier, aucune action externe, aucun sous-agent, aucune autre demande.';
const native668 = 'Nouvel objectif : contrôle UI-668eba84. Utilise request_user_input pour me demander « Couleur du contrôle ? », avec Bleu et Vert. Attends ma réponse. Puis réponds uniquement « UI-668eba84 : [couleur choisie] ». Aucun fichier, aucune action externe, aucun sous-agent.';
const native3af = 'Nouvel objectif : contrôle natif UI-3af573b1. Utilise request_user_input pour me demander « Couleur du contrôle UI-3af573b1 ? », avec Bleu et Vert. Attends ma réponse. Puis réponds uniquement « UI-3af573b1 : [couleur choisie] ». Aucun fichier, aucune action externe, aucun sous-agent.';

describe('explicit question/answer-only objective', () => {
  it('drops a stopped Retry snapshot when a new accepted message changes its anchor or objective', () => {
    const initial = transitionObjectiveContract({ messageId: 'stopped-root', text: native668, nowMs: 1 });
    const existing = { ...initial, interruptedTurnRecovery: {
      objectiveId: 'stopped-root', userMessageId: 'stopped-root',
      recovery: { userMessageId: 'stopped-root', startedAt: 1, attempts: 4, leaseExpiresAt: 50 },
    } };
    for (const text of ['Bleu', native3af]) {
      const next = transitionObjectiveContract({ existing, messageId: 'new-anchor', text, nowMs: 2 });
      expect(next.interruptedTurnRecovery).toBeUndefined();
      expect(next.lastUserMessageId).toBe('new-anchor');
    }
    expect(existing.interruptedTurnRecovery.recovery.attempts).toBe(4);
  });
  it('recognizes the complete native control script while retaining actions outside its literals', () => {
    const objective = transitionObjectiveContract({ messageId: 'native-3af', text: native3af, nowMs: 1 });
    expect(objective.orchestrationMode).toBe('direct');
    expect(requiresStructuredObjectiveOutcome(objective)).toBe(false);
    expect(objective.requiresAcceptanceCriteria).not.toBe(true);
    expect(objective.requiresObservationEvidence).not.toBe(true);
    for (const text of [
      `${native3af} Crée le PDF.`,
      `${native3af} Ouvre le site et vérifie le contenu.`,
      `${native3af} Déploie le service.`,
      native3af.replace('contrôle natif UI-', 'contrôle natif du site UI-'),
      native3af.replace('Attends ma réponse.', 'Attends ma réponse puis lis le fichier.'),
    ]) {
      const work = transitionObjectiveContract({ messageId: 'native-work', text });
      expect(requiresStructuredObjectiveOutcome(work)).toBe(true);
      expect(work.requiresAcceptanceCriteria).toBe(true);
    }
  });
  it('replays the native UI-668eba84 objective without inventing checks or a structured completion receipt', () => {
    for (const text of [native668,
      native668.replaceAll('« ', '“').replaceAll(' »', '”'),
      native668.replaceAll('«', '"').replaceAll('»', '"'),
      native668.replace('Nouvel objectif : ', ''),
      native668.replace('Nouvel objectif : contrôle UI-668eba84. ', ''),
      native668.replace('UI-668eba84', 'UI-abcd1234'),
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'native-control', text, nowMs: 1 });
      expect(objective.originalText).toBe(text);
      expect(objective.orchestrationMode).toBe('direct');
      expect(objective.requiresAcceptanceCriteria).not.toBe(true);
      expect(objective.requiresExecutionEvidence).not.toBe(true);
      expect(objective.requiresObservationEvidence).not.toBe(true);
      expect(requiresStructuredObjectiveOutcome(objective)).toBe(false);
      expect(buildObjectiveContractPrompt(objective)).not.toContain('The final robb_objective_outcome receipt');
      const afterAnswer = transitionObjectiveContract({ existing: objective, messageId: 'native-answer', text: 'Bleu', nowMs: 2 });
      expect(afterAnswer.userMessageId).toBe(objective.userMessageId);
      expect(afterAnswer.originalText).toBe(text);
      expect(requiresStructuredObjectiveOutcome(afterAnswer)).toBe(false);
      expect(classifyObjectiveTerminalState('UI-668eba84 : Bleu', {
        structuredOutcomeRequired: requiresStructuredObjectiveOutcome(objective),
      })).toBe('complete_verified');
    }
  });

  it('keeps real work beside the native control subject to its normal evidence obligations', () => {
    for (const text of [
      `${native668} Puis crée un PDF avec cette couleur.`,
      native668.replace('Attends ma réponse.', 'Attends ma réponse puis crée le PDF.'),
      native668.replace('contrôle UI-668eba84.', 'contrôle UI-668eba84, crée un PDF.'),
      native668.replace('Utilise request_user_input', 'Crée le PDF. Utilise request_user_input'),
      native668.replace('avec Bleu et Vert.', 'avec Bleu et Vert, puis modifie le document.'),
      native668.replace('aucun sous-agent.', 'aucun sous-agent, sauf pour créer le PDF.'),
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'real-work', text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
      expect(requiresStructuredObjectiveOutcome(objective)).toBe(true);
    }
    for (const text of [
      `${native668} Ouvre le site et vérifie son contenu.`,
      `${native668} Exécute les tests de l’application.`,
      native668.replace('Attends ma réponse.', 'Attends ma réponse puis inspecte le service.'),
      native668.replace('aucune action externe', 'aucune action externe sauf vérifier le site'),
      native668.replace('demander « Couleur du contrôle ? »', 'demander « Couleur du contrôle ? » et appelle le navigateur'),
      `Le scénario à vérifier est : « ${native668} »`,
      `« ${native668} »`,
      'Nouvel objectif : contrôle UI-668eba84. Vérifie le service.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'real-check', text });
      expect(objective.requiresObservationEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
      expect(requiresStructuredObjectiveOutcome(objective)).toBe(true);
    }
  });

  it('keeps a new bounded conversational exchange direct without inventing action checks', () => {
    for (const text of [
      french,
      french.replace('Contrôle local des questions : ', '').replace('QUESTION-C0F40645', 'Votre préférence'),
      'Utilise request_user_input pour me poser une question de préférence, avec les choix Court et Détaillé. Attends ma réponse. Réponds uniquement avec mon choix. Aucune action externe, aucun fichier, aucune autre tâche.',
      english,
      english.replace(', then respond', '. Respond'),
      nativeScript,
      nativeScript.replace('Test technique de non-régression UI db4df1c6. ', ''),
      nativeScript.replace('l’outil de question utilisateur', 'request_user_input'),
      nativeScript.replace('Couleur du contrôle de reprise ?', 'Lecture du contrôle : Bleu ou Vert ?'),
      nativeScript.replaceAll('«', '"').replaceAll('»', '"'),
      nativeScript.replace('Dès que je réponds', 'Après ma réponse').replace('termine', 'réponds'),
      nativeScript.replace('Aucun fichier à modifier, aucune action externe, aucun sous-agent, aucune autre demande.',
        'Aucune action externe, aucun fichier, aucune autre tâche.'),
      nativeScript.replace(', aucune autre demande', ''),
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'question-root', text, nowMs: 1 });
      expect(objective.orchestrationMode).toBe('direct');
      expect(objective.requiresExecutionEvidence).not.toBe(true);
      expect(objective.requiresObservationEvidence).not.toBe(true);
      expect(objective.requiresAcceptanceCriteria).not.toBe(true);
      expect(objective.completionCriteria).toEqual(['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining']);
      expect(classifyObjectiveTerminalState('QUESTION-C0F40645 Bleu', {
        structuredOutcomeRequired: objective.orchestrationMode === 'mission'
          || objective.requiresExecutionEvidence === true || objective.requiresObservationEvidence === true,
      })).toBe('complete_verified');
    }
  });

  it('does not exempt actual tests, inspection or quoted scenarios beside a literal question script', () => {
    for (const text of [
      `Inspecte le dépôt et exécute les tests. ${nativeScript}`,
      `${nativeScript} Vérifie ensuite le service.`,
      `${nativeScript} Lance réellement les tests de reprise.`,
      nativeScript.replace('Pose exactement', 'Lis le fichier de configuration. Pose exactement'),
      nativeScript.replace('choix Bleu ou Vert.', 'choix Bleu ou Vert et vérifie le service.'),
      nativeScript.replace('Attends ma réponse.', 'Attends ma réponse puis inspecte le service.'),
      nativeScript.replace('Aucun fichier à modifier', 'Aucun fichier à modifier, sauf le rapport'),
      nativeScript.replace('aucune autre demande', 'aucune autre demande, sauf lire le rapport'),
      `« ${nativeScript} »`,
      `"${nativeScript}"`,
      `Le scénario cité est « ${nativeScript} ». Vérifie son implémentation.`,
      nativeScript.replace('Aucun fichier à modifier, ', ''),
      nativeScript.replace(', aucune action externe', ''),
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'inspection', text });
      expect(objective.requiresObservationEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
    }
  });

  it('retains mutation evidence for every positive action outside the requested literal text', () => {
    for (const text of [
      `${nativeScript} Puis déploie le service.`,
      `Corrige le problème de reprise. ${nativeScript}`,
      nativeScript.replace('choix Bleu ou Vert.', 'choix Bleu ou Vert puis modifie le service.'),
      nativeScript.replace('Attends ma réponse.', 'Attends ma réponse puis crée le document.'),
      nativeScript.replace('Dès que je réponds, termine', 'Dès que je réponds, corrige le service puis termine'),
      nativeScript.replace('aucune autre demande', 'aucune autre demande sauf corriger le rapport'),
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'mutation', text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
    }
  });

  it('retains observation requirements for actual inspection, quoted instructions and extra target work', () => {
    for (const text of [
      `Inspecte le serveur. ${french}`,
      `Audit en lecture seule. ${french}`,
      french.replace('les choix Bleu et Vert', 'les choix Bleu et Vert et vérifie le service'),
      french.replace('la couleur choisie', 'la couleur choisie et lis le fichier de configuration'),
      french.replace('la couleur choisie', 'la couleur choisie et le statut du serveur'),
      french.replace('aucune autre tâche', 'aucune autre tâche, sauf lire le rapport'),
      `Le scénario cité est « ${french} ». Vérifie son implémentation.`,
      `« ${french} »`,
      english.replace('chosen answer', 'chosen answer and inspect the server'),
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'target-root', text });
      expect(objective.requiresObservationEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
    }
  });

  it('does not bypass a mutation instruction beside contradictory conversational limits', () => {
    for (const text of [
      `${french} Puis déploie le service.`,
      french.replace('la couleur choisie', 'la couleur choisie et modifie la configuration'),
      french.replace('une seule couleur', 'une seule couleur et crée un document'),
      french.replace('une seule couleur', 'une seule couleur et modifie les permissions de production'),
      english.replace('chosen answer', 'chosen answer and deploy the service'),
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'mutation-root', text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
    }
  });

  it('keeps an unscoped standalone execution prohibition globally authoritative', () => {
    const existing = transitionObjectiveContract({
      messageId: 'write-root',
      text: 'Corrige le rapport et vérifie le résultat.',
      nowMs: 1,
    });
    expect(objectiveRequiresExecutionEvidence(existing)).toBe(true);
    const stopped = transitionObjectiveContract({
      existing,
      messageId: 'stop-execution',
      text: 'Aucune action externe. Ne modifie plus rien.',
      nowMs: 2,
    });
    expect(stopped.requiresExecutionEvidence).toBeUndefined();
    expect(objectiveRequiresExecutionEvidence(stopped)).toBe(false);
  });

  it('requires the explicit bounded scope and does not reclassify existing report/audit objectives', () => {
    for (const text of [
      french.replace(' Aucune action externe, aucun fichier, aucune autre tâche.', ''),
      french.replace('aucun fichier, ', ''),
      french.replace('utilise request_user_input', 'pose une question'),
    ]) {
      expect(transitionObjectiveContract({ messageId: 'unbounded-root', text }).requiresObservationEvidence).toBe(true);
    }
    const existing = {
      ...transitionObjectiveContract({ messageId: 'audit-root', text: 'Audit du rapport : vérifie les résultats puis corrige les erreurs.', nowMs: 1,
        lifetimeCostUsd: 12, lifetimeTokens: 340 }),
      acceptanceCriteria: [{ id: 'report-ready', description: 'Requested report', toolName: 'Read', input: { path: '/report.json' }, checks: [{ path: '$.ready', equals: true }] }],
      acceptanceRegisteredAt: 2,
    };
    const before = structuredClone(existing);
    for (const text of [french, english, nativeScript, native668.replace('Nouvel objectif : ', ''), 'Bleu']) {
      const continued = transitionObjectiveContract({ existing, messageId: 'answer-message', text, nowMs: 3,
        lifetimeCostUsd: 50, lifetimeTokens: 600 });
      expect(continued.userMessageId).toBe('audit-root');
      expect(continued.originalText).toBe(existing.originalText);
      expect(continued.orchestrationMode).toBe('mission');
      expect(continued.requiresObservationEvidence).toBe(true);
      expect(continued.requiresExecutionEvidence).toBe(true);
      expect(continued.requiresAcceptanceCriteria).toBe(true);
      expect(continued.acceptanceCriteria).toEqual(existing.acceptanceCriteria);
      expect(continued.acceptanceRegisteredAt).toBe(2);
      expect(continued.budgetBaselineUsd).toBe(12);
      expect(continued.tokenBaseline).toBe(340);
    }
    expect(existing).toEqual(before);
  });

  it('does not rewrite a previously created conversational objective during a continuation', () => {
    const existing = { ...transitionObjectiveContract({ messageId: 'old-root', text: nativeScript, nowMs: 1 }),
      requiresExecutionEvidence: true, requiresObservationEvidence: true, requiresAcceptanceCriteria: true,
      acceptanceCriteria: [{ id: 'old-check', description: 'Existing check', toolName: 'Read', input: { path: '/report.json' }, checks: [{ path: '$.ready', equals: true }] }],
      acceptanceRegisteredAt: 2, budgetBaselineUsd: 7,
    };
    const before = structuredClone(existing);
    const continued = transitionObjectiveContract({ existing, messageId: 'answer', text: 'Bleu', nowMs: 3 });
    expect(continued.requiresExecutionEvidence).toBe(true);
    expect(continued.requiresObservationEvidence).toBe(true);
    expect(continued.requiresAcceptanceCriteria).toBe(true);
    expect(continued.acceptanceCriteria).toEqual(existing.acceptanceCriteria);
    expect(continued.budgetBaselineUsd).toBe(7);
    expect(existing).toEqual(before);
  });
});
