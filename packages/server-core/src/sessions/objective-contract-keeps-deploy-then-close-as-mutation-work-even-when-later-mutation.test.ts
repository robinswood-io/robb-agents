import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { buildObjectiveContractPrompt, isObjectiveEvidenceInvalidatingMutation, isObjectiveMutationTool, isExplicitReadOnlyClosureRequest, isExplicitReadOnlyReview, objectiveRequiresExecutionEvidence, transitionObjectiveContract } from "./objective-contract.ts";
import recursiveReviewRequests from "./__fixtures__/delegated-review-recursion-20260909.json";
import { DIRECT_MEDICAL_MUTATION_CASES, DIRECT_RBAC_MUTATION_CASES, NON_AUTHORITATIVE_SENSITIVE_LANGUAGE_CASES } from "../../../shared/src/agent/core/__tests__/sensitive-mutation-language-fixtures.ts";

describe('durable objective contract', () => {
  it('keeps deploy-then-close as mutation work even when later mutations are forbidden', () => {
    const text = 'Déploie maintenant le correctif, puis clôture réellement la mission déjà réalisée avec les preuves du chat déjà présentes. Réutilise les preuves, garde la clôture en lecture seule, et n autorise aucune mutation supplémentaire après le déploiement.';
    expect(isExplicitReadOnlyClosureRequest(text)).toBe(false);
    const objective = transitionObjectiveContract({ messageId: 'deploy-then-close', text });
    expect(objective).toMatchObject({
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
  });

  it('retains execution authority for an explicit duplicate-safe conditional API reply', () => {
    const text = "Vérifie l’absence puis, seulement s’il est absent, effectue une unique réponse API.";
    const objective = transitionObjectiveContract({ messageId: 'conditional-api-reply', text });
    expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    expect(objective).toMatchObject({
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
  });

  it.each(DIRECT_MEDICAL_MUTATION_CASES)('persists the medical language matrix as high-stakes: %s', text => {
    expect(transitionObjectiveContract({ messageId: `medical-matrix-${text}`, text })).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain: 'medical',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
  });

  it.each(DIRECT_RBAC_MUTATION_CASES)('persists the RBAC language matrix as high-stakes: %s', text => {
    expect(transitionObjectiveContract({ messageId: `rbac-matrix-${text}`, text })).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain: 'security',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
  });

  it.each(NON_AUTHORITATIVE_SENSITIVE_LANGUAGE_CASES)(
    'keeps non-authoritative sensitive language outside the evidence gate: %s',
    text => {
      const objective = transitionObjectiveContract({ messageId: `negative-matrix-${text}`, text });
      expect(objective.risk).toBe('standard');
      expect(objective.evidenceRequirement).toBeUndefined();
    },
  );

  it('keeps exact registration aliases outside target mutations without exempting external writes', () => {
    for (const toolName of ['set_completion_criteria', 'session__set_completion_criteria', 'mcp__session__set_completion_criteria']) {
      expect(isObjectiveMutationTool({ toolName } as Message)).toBe(false);
    }
    expect(isObjectiveMutationTool({ toolName: 'mcp__external__set_completion_criteria' } as Message)).toBe(true);
    expect(isObjectiveMutationTool({ id: 'write', role: 'tool', content: '', timestamp: 1, toolName: 'Write', toolInput: { path: '/tmp/target' } })).toBe(true);
  });

  it('treats only the canonical Gmail send preflight as non-executing', () => {
    const canonical = { toolName: 'mcp__google-contacts__gmail_send_preflight' } as Message;
    expect(isObjectiveMutationTool(canonical)).toBe(false);
    expect(isObjectiveEvidenceInvalidatingMutation(canonical)).toBe(false);
    for (const toolName of [
      'mcp__untrusted__gmail_send_preflight',
      'mcp__google-contacts__gmail_send_preflight_and_send',
      'mcp__google-contacts__gmail_send',
    ]) {
      const lookalike = { toolName } as Message;
      expect(isObjectiveMutationTool(lookalike)).toBe(true);
      expect(isObjectiveEvidenceInvalidatingMutation(lookalike)).toBe(true);
    }
  });

  it('recognizes strict review scopes without inventing execution for an optional read-only review', () => {
    for (const request of recursiveReviewRequests) {
      const strict = request.id !== '260909-airy-reef';
      expect(isExplicitReadOnlyReview(request.originalText)).toBe(strict);
      const objective = transitionObjectiveContract({ messageId: request.objectiveId, text: request.originalText });
      expect(objectiveRequiresExecutionEvidence({ ...objective, requiresExecutionEvidence: true })).toBe(false);
    }
    expect(isExplicitReadOnlyReview('Revue indépendante en lecture seule du dépôt /srv/app. Écris uniquement le JSON de verdict dans ta réponse, aucun fichier.')).toBe(true);
    expect(isExplicitReadOnlyReview('Effectue une revue indépendante en lecture seule du connecteur existant. Ne modifie rien.')).toBe(true);
  });

  it('does not hide positive or conditional writes behind a JSON instruction or read-only label', () => {
    for (const text of [
      'Réponds uniquement en JSON compact. Tu dois vérifier en lecture seule le dépôt /srv/review. Puis modifie la configuration.',
      'Réponds uniquement en JSON compact. Tu dois vérifier en lecture seule si possible le dépôt /srv/review.',
      'Réponds uniquement en JSON compact et corrige le service. Revue indépendante stricte, lecture seule.',
      'Réponds uniquement en JSON compact. « Revue indépendante stricte, lecture seule. » Puis installe le service.',
      'Revue indépendante stricte, lecture seule. Apporte les corrections nécessaires si possible.',
      'Revue indépendante stricte, lecture seule. Les corrections doivent être appliquées si nécessaire.',
      'Revue indépendante stricte, lecture seule. Écris uniquement le JSON de verdict dans ta réponse, aucun fichier, puis déploie.',
      'Revue indépendante stricte, lecture seule. Écris uniquement le JSON de verdict dans /srv/result.json.',
      'Effectue une revue indépendante en lecture seule du connecteur existant. Puis corrige sa configuration.',
    ]) expect(isExplicitReadOnlyReview(text)).toBe(false);
  });

  it('keeps an explicitly read-only independent review observational despite mutation context and legacy flags', () => {
    for (const text of [
      'Revue indépendante en lecture seule. Ne modifie rien. Vérifie le déploiement existant.',
      'Revue indépendante lecture seule pour le coordinateur. Plan utilisateur accepté exige correction puis déploiement observateur si autorité spécifique récente existe; aucune extension permissions. Décide si exception autoritative spécifique au seul observateur lecture seule s’applique ou conflit policy subsiste. Ne modifie rien, ne démarre rien. Prépare la procédure de release/rollback et exigences tests sans lancer.',
      'Independent read-only review. Do not modify anything. Verify the existing deployment and review the proposed correction.',
      'Tu es le relecteur indépendant final d’une campagne presse. Travaille uniquement en lecture. Le parent prépare la campagne, aucun envoi. Rapporte les résultats de validation.',
      'Tu es le relecteur indépendant final d’une campagne presse. Travaille uniquement en lecture. Exécute réellement la commande exacte python3 validate_campaign.py et lis les résultats de validation. Vérifie la correction proposée.',
      'Independent read-only review. Run the validation command and inspect the proposed correction. Do not modify anything.',
      'Tu es un second réviseur indépendant d’une mission sécurité à haut risque. Travaille STRICTEMENT EN LECTURE SEULE sur le serveur : aucune modification, aucune commande susceptible d’écrire, aucun commit/push/PR. Vérifie les corrections existantes.',
      'Revue indépendante terminale, lecture seule, du nouveau commit dans /srv/review. Vérifie les corrections. Ne modifie rien et ne lance pas de suite longue.',
      'Agis comme contre-relecteur indépendant hostile en lecture seule. Audit exact du worktree /srv/review. Vérifie les garde-fous. Ne modifie et ne déploie rien.',
      'Revue indépendante lecture seule pour le coordinateur. Plan utilisateur accepté exige correction puis déploiement. deploy/systemd/README.md documente la release existante. Ne modifie rien, ne démarre rien. Prépare la procédure de release/rollback sans lancer.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'review-root', text });
      expect(objective.requiresExecutionEvidence).not.toBe(true);
      expect(objective.requiresObservationEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
      expect(objective.completionCriteria).not.toContain('independent-review-passed');
      const prompt = buildObjectiveContractPrompt(objective);
      expect(prompt).toContain('You are a terminal independent reviewer');
      expect(prompt).not.toContain('High-stakes completion requires an independent review');
      const legacy = { ...objective, requiresExecutionEvidence: true, evidenceRequirement: 'authoritative-sources-before-mutation' as const };
      const previous = structuredClone(legacy);
      expect(objectiveRequiresExecutionEvidence(legacy)).toBe(false);
      expect(legacy).toEqual(previous);
    }
  });

  it('does not turn a deployment, quoted review or contradictory mutation request into a read-only objective', () => {
    for (const text of [
      'Déploie l’observateur lecture seule puis vérifie son état.',
      'Le message cité dit « Revue indépendante lecture seule. Ne modifie rien. ». Corrige ensuite le service.',
      '"Revue indépendante lecture seule. Ne modifie rien." Puis déploie le service.',
      'Revue indépendante lecture seule. Ne modifie rien, mais corrige la configuration.',
      'Revue indépendante lecture seule. Ne modifie rien. Puis tu peux déployer la correction.',
      'Independent read-only review. Do not modify anything, but apply the fix now.',
      'Tu es le relecteur indépendant final. Travaille uniquement en lecture. Puis publie la campagne.',
      'Tu es un second réviseur indépendant. Travaille STRICTEMENT EN LECTURE SEULE. Puis corrige la configuration.',
      'Agis comme contre-relecteur indépendant hostile en lecture seule. Audit exact. Mais modifie le service.',
      'Revue indépendante terminale, lecture seule, du nouveau commit. Ensuite déploie le correctif.',
      'Tu es un second réviseur chargé de corriger l’application en lecture seule.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'mutation-root', text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    }
  });

  it('keeps application health in the software deployment domain', () => {
    const objective = transitionObjectiveContract({
      messageId: 'zero-deploy',
      text: 'Déploie Zero, puis vérifie la révision, HTTPS, le login/dashboard et la santé du service.',
    });
    expect(objective).toMatchObject({
      risk: 'standard',
      requiresExecutionEvidence: true,
    });
    expect(objective.evidenceDomain).toBeUndefined();
  });

  it('retains execution authority for explicit dev-login reactivation requests', () => {
    for (const text of [
      "Tu dois réactiver le dev login abrutit c'est ta mission",
      'Réactive le login de développement.',
      'Merci de reactiver le dev login.',
      'Pouvez-vous réactiver le login de dev ?',
      'Je veux que tu réactives le dev login.',
      'Je souhaite que tu réactives le dev login.',
      "J'ai besoin que tu réactives le dev login.",
      'Il faut que tu réactives le dev login.',
      'Est-ce que tu peux réactiver le dev login ?',
      'Tu dois maintenant réactiver le dev login.',
      'Il faut maintenant réactiver le dev login.',
      'Vas-y, réactive le dev login.',
      "D'accord, réactive le dev login.",
      'Merci, réactive le dev login.',
      'Veuillez maintenant réactiver le dev login.',
      'Tu peux stp réactiver le dev login.',
      'Je te demande maintenant de réactiver le dev login.',
      '- Réactiver le dev login',
      '* Réactiver le dev login',
      '• Réactiver le dev login',
      'Action : réactiver le dev login',
      'À faire : réactiver le dev login',
      'Tâche : réactiver le dev login',
      'Action :\nRéactiver le dev login',
      'À faire :\n- Réactiver le dev login',
      'Tâche :\n1. Réactiver le dev login',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'zero-login', text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
      expect(objective.risk).toBe('standard');

      const persistedBeforeClassifierFix = { ...objective };
      delete persistedBeforeClassifierFix.requiresExecutionEvidence;
      expect(objectiveRequiresExecutionEvidence(persistedBeforeClassifierFix)).toBe(true);
      expect(objectiveRequiresExecutionEvidence({
        ...persistedBeforeClassifierFix,
        requiresExecutionEvidence: false,
      })).toBe(false);
    }

    const persistedLiveObjective = transitionObjectiveContract({
      messageId: 'zero-live',
      text: "Tu dois réactiver le dev login abrutit c'est ta mission",
    });
    delete persistedLiveObjective.requiresExecutionEvidence;
    persistedLiveObjective.amendments = [{
      messageId: 'zero-stop', text: 'Ne réactive pas le dev login.', timestamp: 2,
    }];
    expect(objectiveRequiresExecutionEvidence(persistedLiveObjective)).toBe(false);
    persistedLiveObjective.amendments = [{
      messageId: 'zero-stop-before', text: 'Ne surtout pas réactiver le dev login.', timestamp: 3,
    }];
    expect(objectiveRequiresExecutionEvidence(persistedLiveObjective)).toBe(false);
    for (const [index, text] of [
      'Arrête de réactiver le dev login.',
      'Cesse de réactiver le dev login.',
      'Stoppe la réactivation du dev login.',
      'Annule la réactivation du dev login.',
      "N'essaie pas de réactiver le dev login.",
      'Il ne faut plus réactiver le dev login.',
      'Laisse tomber, ne réactive pas le dev login.',
      'Finalement ne réactive pas le dev login.',
      'Ne réactive plus le dev login.',
      'Pas de réactivation du dev login.',
      'Réactivation annulée.',
      'Laisse tomber.',
      'Annule.',
      'Stop.',
      'Finalement non.',
      'Non, ne le fais pas.',
      'Oublie.',
      'Attends.',
      'Pas maintenant.',
      "N'en fais rien.",
    ].entries()) {
      persistedLiveObjective.amendments = [{
        messageId: `zero-revoke-${index}`, text, timestamp: 10 + index,
      }];
      expect(objectiveRequiresExecutionEvidence(persistedLiveObjective)).toBe(false);
    }
    for (const text of [
      'Réactivation annulée. Réactive le dev login.',
      'Annule la réactivation précédente. Réactive le dev login maintenant.',
      'Pas de réactivation en prod. Réactive le dev login.',
      'Ne réactive pas le compte prod. Réactive le dev login.',
      'Attends. Réactive ensuite le dev login.',
    ]) {
      persistedLiveObjective.amendments = [{
        messageId: 'zero-resume', text, timestamp: 30,
      }];
      expect(objectiveRequiresExecutionEvidence(persistedLiveObjective)).toBe(true);
    }
    persistedLiveObjective.amendments = [{
      messageId: 'zero-revoke-last',
      text: 'Réactive le dev login. Finalement ne réactive pas le dev login.',
      timestamp: 31,
    }];
    expect(objectiveRequiresExecutionEvidence(persistedLiveObjective)).toBe(false);

    for (const text of [
      'Ne réactive pas le dev login.',
      'Ne surtout pas réactiver le dev login.',
      'Analyse si nous devons réactiver le dev login.',
      'Le rapport dit : réactive le dev login.',
      'Vérifie pourquoi le dev login est désactivé, mais ne le réactive pas.',
      'Déploie le service de développement.',
      '- Ne réactive pas le dev login.',
      '* Ne réactive pas le dev login.',
      'Action : ne réactive pas le dev login.',
      'À faire : ne pas réactiver le dev login.',
      'Le rapport dit :\n- Réactiver le dev login.',
      'Exemple :\n* Réactiver le dev login.',
      'Citation :\n• Réactiver le dev login.',
      'Plan proposé :\n- Réactiver le dev login.',
      'Analyse cette instruction :\n- Réactiver le dev login.',
      'Le rapport dit :\nRéactive le dev login.',
      'Analyse cette instruction :\nRéactive le dev login.',
      'La documentation recommande :\nRéactiver le dev login.',
      'Exemple :\n1. Réactiver le dev login.',
      'Citation :\nRéactiver le dev login.',
      'Sujet :\nRéactiver le dev login.',
      'Question :\nRéactiver le dev login.',
      'Hypothèse :\nRéactiver le dev login.',
      'Option :\nRéactiver le dev login.',
      'Proposition :\nRéactiver le dev login.',
      'Scénario :\nRéactiver le dev login.',
      'Consigne citée :\nRéactiver le dev login.',
    'Texte à analyser :\nRéactiver le dev login.',
      'Réactiver le dev login ne doit jamais être fait.',
      'Réactiver le dev login doit être évité.',
      'Réactiver le dev login était une erreur.',
      'Réactiver le dev login sera risqué.',
      'Réactiver le dev login nécessite une autorisation.',
      'Réactiver le dev login implique un risque majeur.',
      'Réactiver le dev login signifie contourner la sécurité.',
    ]) {
      const legacy = transitionObjectiveContract({ messageId: 'zero-read-only', text });
      delete legacy.requiresExecutionEvidence;
      expect(objectiveRequiresExecutionEvidence(legacy)).toBe(false);
    }

    for (const text of [
      'Le rapport dit :\nNe réactive pas le dev login.',
      'Exemple :\n* Ne réactive pas le dev login.',
      'Citation :\nNe réactive pas le dev login.',
      'Analyse cette instruction :\nNe réactive pas le dev login.',
      'Question :\nNe réactive pas le dev login.',
      'Hypothèse :\nNe réactive pas le dev login.',
      'Option :\nNe réactive pas le dev login.',
      'Proposition :\nNe réactive pas le dev login.',
      'Scénario :\nNe réactive pas le dev login.',
      'Consigne citée :\nNe réactive pas le dev login.',
      'Texte à analyser :\nNe réactive pas le dev login.',
    ]) {
      persistedLiveObjective.amendments = [{
        messageId: 'reported-multiline-revoke', text, timestamp: 40,
      }];
      expect(objectiveRequiresExecutionEvidence(persistedLiveObjective)).toBe(true);
      expect(transitionObjectiveContract({
        existing: persistedLiveObjective,
        messageId: 'reported-multiline-transition',
        text,
      }).requiresExecutionEvidence).toBe(true);
    }
    for (const text of [
      'Action :\nNe réactive pas le dev login.',
      'À faire :\n- Ne réactive pas le dev login.',
      'Tâche :\n1. Ne réactive pas le dev login.',
    ]) {
      persistedLiveObjective.amendments = [{
        messageId: 'direct-multiline-revoke', text, timestamp: 41,
      }];
      expect(objectiveRequiresExecutionEvidence(persistedLiveObjective)).toBe(false);
      expect(transitionObjectiveContract({
        existing: persistedLiveObjective,
        messageId: 'direct-multiline-transition',
        text,
      }).requiresExecutionEvidence).toBeUndefined();
    }
  });

  it('retains execution authority for direct external communication requests', () => {
    for (const text of [
      'Ok dans ce cas informe Benoit de la situation et demande-lui les ID.',
      'Préviens Alice que le service est rétabli.',
      'Send Alice the status update.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'communication-root', text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
      expect(objective.risk).toBe('standard');
    }
  });

  it('lets the last comma-delimited instruction own execution authority', () => {
    for (const text of [
      'Réactive le dev login, finalement ne le réactive pas.',
      'Réactive le dev login. Finalement ne le réactive pas.',
      'Réactive le dev login, mais finalement ne le réactive pas.',
      'Envoie à Benoît, finalement n’envoie rien.',
    ]) {
      const revoked = transitionObjectiveContract({ messageId: 'comma-revoke', text });
      expect(revoked.requiresExecutionEvidence).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence({
        ...revoked, requiresExecutionEvidence: true,
      })).toBe(false);
    }

    for (const text of [
      'Ne réactive pas le compte prod, réactive le dev login.',
      'Ne réactive pas le compte prod. Réactive le dev login.',
      'Ne réactive pas le compte prod, mais réactive le dev login.',
      'N’envoie pas à Alice, envoie l’e-mail à Benoît.',
    ]) {
      const resumed = transitionObjectiveContract({ messageId: 'comma-resume', text });
      expect(resumed.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(resumed)).toBe(true);
    }

    const active = transitionObjectiveContract({
      messageId: 'comma-active', text: 'Réactive le dev login.',
    });
    const stopped = transitionObjectiveContract({
      existing: active,
      messageId: 'comma-stop',
      text: 'Réactive le dev login, finalement ne le réactive pas.',
    });
    expect(stopped.requiresExecutionEvidence).toBeUndefined();
    expect(objectiveRequiresExecutionEvidence(stopped)).toBe(false);

    const malformedReviewer = {
      ...active,
      delegatedRole: 'reviewer' as const,
      requiresExecutionEvidence: true,
    };
    expect(objectiveRequiresExecutionEvidence(malformedReviewer)).toBe(false);
  });

  it('does not turn a reported or analytical comma tail into execution authority', () => {
    for (const text of [
      'Le rapport dit, réactive le dev login.',
      'Exemple, réactive le dev login.',
      'Citation, réactive le dev login.',
      'Ne fais qu’analyser, réactive le dev login.',
      'Analyse si, pour corriger, il faut réactiver le dev login.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'reported-comma', text });
      expect(objective.requiresExecutionEvidence).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence({
        ...objective,
        requiresExecutionEvidence: undefined,
      })).toBe(false);
    }

    const active = transitionObjectiveContract({
      messageId: 'reported-negative-root', text: 'Réactive le dev login.',
    });
    for (const text of [
      'Le rapport dit, ne réactive pas le dev login.',
      'Exemple, n’envoie rien.',
      'Citation, ne le fais pas.',
      'Analyse si, finalement ne le réactive pas.',
    ]) {
      const continued = transitionObjectiveContract({
        existing: active,
        messageId: `reported-negative-${text}`,
        text,
      });
      expect(continued.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(continued)).toBe(true);
    }
  });
});
