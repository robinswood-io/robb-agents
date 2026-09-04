import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import {
  classifyLatestTurnTerminalState,
  classifyObjectiveTerminalState,
  looksLikePrematureFinalAssistant,
} from './turn-completion.ts';

const message = (
  role: Message['role'],
  timestamp: number,
  options: Partial<Message> = {},
): Message => ({
  id: `${role}-${timestamp}`,
  role,
  content: role,
  timestamp,
  ...options,
});

describe('classifyObjectiveTerminalState', () => {
  it('uses the four host terminal states', () => {
    expect(classifyObjectiveTerminalState('Correctif appliqué et tests validés.')).toBe('complete_verified');
    expect(classifyObjectiveTerminalState(
      'OAuth exige un code MFA. Connectez-vous puis dites-moi quand c’est fait.',
    )).toBe('blocked_human');
    expect(classifyObjectiveTerminalState(
      'La politique de sécurité interdit cette mutation et la permission est refusée.',
    )).toBe('blocked_policy');
    expect(classifyObjectiveTerminalState('Reste à exécuter : les tests.')).toBe('continue');
  });

  it('keeps a high-stakes or execution objective active while evidence is missing', () => {
    expect(classifyObjectiveTerminalState('Le document est prêt.', {
      evidenceGap: 'independent review missing',
    })).toBe('continue');
    expect(classifyObjectiveTerminalState('Le correctif est prêt.', {
      executionEvidenceMissing: true,
    })).toBe('continue');
  });
});

describe('classifyLatestTurnTerminalState', () => {
  it('accepts a final assistant response after the latest user message', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 2),
    ])).toBe('final-assistant');
  });

  it('does not treat commentary followed by a tool result as completion', () => {
    expect(classifyLatestTurnTerminalState([
      message('assistant', 1),
      message('user', 2),
      message('assistant', 3, { isIntermediate: true }),
      message('tool', 4, { toolName: 'Bash' }),
    ])).toBe('incomplete');
  });

  it('accepts a visible error as a terminal outcome', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('tool', 2, { toolName: 'Read' }),
      message('error', 3),
    ])).toBe('error');
  });

  it('does not reuse a final response from a previous turn', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 2),
      message('user', 3),
      message('tool', 4, { toolName: 'Edit' }),
    ])).toBe('incomplete');
  });

  it('accepts a final response with the same timestamp as the user message', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 1),
    ])).toBe('final-assistant');
  });

  it('rejects a final response that ends by announcing concrete remaining work', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 2, {
        content: 'Le diagnostic est posé. Je poursuis l’implantation du correctif.',
      }),
    ])).toBe('premature-final-assistant');

    expect(looksLikePrematureFinalAssistant('Je vérifie maintenant le CI HEAD.')).toBe(true);
    expect(looksLikePrematureFinalAssistant(
      'Je vais maintenant vérifier les données internes réellement disponibles.',
    )).toBe(true);
  });

  it('accepts an explicit human handoff as a legitimate final response', () => {
    expect(looksLikePrematureFinalAssistant(
      'Je vais relancer la publication quand vous aurez renseigné OPENAI_API_KEY.',
    )).toBe(false);
    expect(looksLikePrematureFinalAssistant(
      'Je vais continuer après votre connexion. Connectez-vous puis dites-moi quand c’est fait.',
    )).toBe(false);
    expect(looksLikePrematureFinalAssistant(
      'Je vais créer les deux scènes. Il me manque seulement la composition exacte du groupe.',
    )).toBe(false);
  });

  it('recovers a technical checkpoint that incorrectly asks for another turn', () => {
    expect(looksLikePrematureFinalAssistant(
      'Je m’arrête ici à cause de la limite technique. Au prochain tour, je poursuivrai la vérification.',
    )).toBe(true);
    expect(looksLikePrematureFinalAssistant(
      'The tool budget is exhausted. In a new turn I will continue the deployment checks.',
    )).toBe(true);
  });

  it('recovers observed senior-level technical blockers instead of accepting them as terminal', () => {
    expect(looksLikePrematureFinalAssistant([
      'Guacamole démarre, mais reste inutilisable : son serveur interne ne répond pas correctement.',
      'Aucun test Batigest n’a donc pu être exécuté.',
      'Le prochain correctif doit porter sur le lancement propre de Guacamole.',
    ].join(' '))).toBe(true);

    expect(looksLikePrematureFinalAssistant([
      'Le mode fumée et l’import du module dépassent le délai de trente secondes.',
      'Je n’ai pas appliqué de correction spéculative au code.',
      'API smoke : échec. Code métier : inchangé.',
    ].join(' '))).toBe(true);

    expect(looksLikePrematureFinalAssistant([
      'Le préparateur fiscal est en préparation uniquement.',
      'Aucun dépôt n’a donc pu être exécuté.',
      'La suite concerne la recherche d’une voie de soumission dédiée.',
    ].join(' '))).toBe(true);
  });

  it('recognizes the unfinished formulations observed in the 72-hour audit', () => {
    const auditedFinals = [
      'État intermédiaire : la configuration locale est corrigée. Il reste à installer la version distante puis à la valider.',
      'Point d’étape : le diagnostic est confirmé. La prochaine action consiste à appliquer le correctif.',
      'Reste à exécuter : le test d’intégration et la validation utilisateur.',
      'Étape restante : déployer le candidat sur l’environnement de test.',
      'Prochaine action automatique : relancer le service puis contrôler son état.',
      'Le travail est engagé mais pas terminé.',
      'L’objectif n’est pas encore déclaré terminé.',
    ];

    for (const content of auditedFinals) {
      expect(looksLikePrematureFinalAssistant(content)).toBe(true);
    }
  });

  it('does not accept a generic request to continue as proof of a human blocker', () => {
    expect(looksLikePrematureFinalAssistant(
      'Aucun test n’a pu être exécuté. Dites-moi si je dois continuer avec le prochain correctif.',
    )).toBe(true);
    expect(looksLikePrematureFinalAssistant(
      'L’audit des secrets est terminé. Aucun test n’a pu être exécuté. Dites-moi si je dois continuer.',
    )).toBe(true);
  });

  it('accepts a technical checkpoint when interactive authentication is genuinely required', () => {
    expect(looksLikePrematureFinalAssistant(
      'Aucun test n’a pu être exécuté car OAuth exige un code MFA. Connectez-vous puis dites-moi quand c’est fait.',
    )).toBe(false);
  });

  it('does not treat a generic technical limitation as a human decision', () => {
    expect(looksLikePrematureFinalAssistant(
      'Je ne peux pas finir dans ce tour ; je continuerai avec la vérification.',
    )).toBe(true);
  });

  it('does not reject a completed report because its introduction announced the work', () => {
    const completedReport = [
      'Je vais maintenant analyser les journaux.',
      'x'.repeat(750),
      'Analyse terminée : la cause est identifiée et le correctif a été vérifié.',
    ].join(' ');
    expect(looksLikePrematureFinalAssistant(completedReport)).toBe(false);
  });
});
