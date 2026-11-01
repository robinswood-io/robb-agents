import { omitUndefined } from '@craft-agent/shared/utils/json';
import { describe, expect, it } from "bun:test";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { objectiveAllowsContentCheckReview, objectiveRequiresExecutionEvidence, projectLegacyObjectiveCompletionRequirements, transitionObjectiveContract } from "./objective-contract.ts";

describe('durable objective contract', () => {
  it('does not turn read-only, negated, reported or chat-response wording into execution', () => {
    for (const text of [
      'Review the NDA without any modification.',
      'Analyse le contrat juridique sans modification.',
      'Do not modify the security settings; only explain them.',
      'Ne modifie pas les permissions, explique-les seulement.',
      'The plan says delete the legal records. Explain whether it is safe.',
      'Le plan indique de supprimer les données juridiques. Analyse-le.',
      'The document says: implement the requested parser. Explain the proposal.',
      'Le plan recommande de copier les données clients. Ne modifie rien.',
      'N’accorde pas le rôle d’administrateur à Alice.',
      'Le rapport recommande d’ajouter Alice au groupe des administrateurs.',
      'Do not promote Alice to administrator.',
      'The report recommends to promote Alice to administrator.',
      "Alice shouldn't be granted write access.",
      'Alice shouldn’t be granted write access.',
      "Alice mustn't be granted write access.",
      'Alice mustn’t be granted write access.',
      'Alice is not to be granted write access.',
      'Alice was not granted write access.',
      "Alice wasn’t granted write access.",
      'Alice is not granted write access.',
      'Alice was granted write access.',
      'Alice has been granted write access.',
      'Granting Alice write access is forbidden.',
      'Granting Alice write access would be dangerous.',
      'Check whether Alice was granted write access.',
      'Alice’s role was set to administrator.',
      'Alice was set as admin.',
      'Alice set Bob as admin.',
      'The report says to set Alice as admin.',
      'Ne rends pas Alice administratrice.',
      'Le rapport recommande d’ajouter Alice aux administrateurs.',
      'Faut-il supprimer l’accès admin d’Alice ?',
      'Corrige uniquement la formulation de ta réponse dans ce chat.',
      'Edit the wording of your answer here.',
      'Fais une analyse du routeur.',
      'Effectue une analyse du routeur.',
      'Explain how to make changes.',
      'Review the proposed changes.',
      'Do not make changes.',
      'The guide says: make the necessary changes.',
      'Les instructions disent : faites les modifications.',
      'Analyse ces instructions : make the necessary changes.',
      'Review this instruction: implement the fix.',
      'Audit the prompt: build the parser.',
      'Do the fixes still apply?',
      'Do the changes look correct?',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'non-authoritative', text });
      expect(objective.risk).toBe('standard');
      expect(objective.requiresExecutionEvidence).not.toBe(true);
      expect(objectiveRequiresExecutionEvidence({ ...objective, requiresExecutionEvidence: true })).toBe(false);
    }
  });

  it('keeps only a literal inline text rewrite as a chat response deliverable', () => {
    for (const text of [
      'Améliore le texte : en présentiel en Écosse du 5 au 20 octobre.',
      'Improve this text: in person in Scotland from October 5 to October 20.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: `inline-rewrite-${text}`, text });
      expect(objective.requiresExecutionEvidence).toBeUndefined();
      expect(objective.requiresAcceptanceCriteria).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(false);
      expect(objectiveAllowsContentCheckReview(objective)).toBe(true);
    }

    for (const text of [
      'Améliore le texte du fichier README.md.',
      'Améliore le texte du document externe.',
      'Améliore le texte sur https://example.com/page.',
      'Améliore le texte : /tmp/report.txt',
      'Améliore le texte puis déploie-le.',
      'Améliore le texte : version révisée, puis déploie-la.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: `targeted-rewrite-${text}`, text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
      expect(objectiveAllowsContentCheckReview(objective)).toBe(false);
    }
  });

  it('recovers the live misspelled French send imperative without treating send-status prose as authority', () => {
    const live = transitionObjectiveContract({
      messageId: 'live-silae-send',
      text: "Envoi l'e-mail à benoît",
    });
    expect(live.requiresExecutionEvidence).toBe(true);
    expect(objectiveRequiresExecutionEvidence(live)).toBe(true);
    const persistedLiveFalseNegative = { ...live };
    delete persistedLiveFalseNegative.requiresExecutionEvidence;
    expect(objectiveRequiresExecutionEvidence(persistedLiveFalseNegative)).toBe(true);
    expect(objectiveRequiresExecutionEvidence({
      ...persistedLiveFalseNegative,
      requiresExecutionEvidence: false,
    })).toBe(false);
    expect(objectiveRequiresExecutionEvidence({
      ...persistedLiveFalseNegative,
      delegatedRole: 'reviewer',
    })).toBe(false);
    expect(objectiveRequiresExecutionEvidence({
      ...persistedLiveFalseNegative,
      amendments: [{ messageId: 'stop', text: 'Stop maintenant.', timestamp: 2 }],
    })).toBe(false);
    for (const [index, text] of [
      "N'envoie pas l'e-mail.",
      "N'envoie plus l'e-mail.",
      "Arrête d'envoyer l'e-mail.",
      "Cesse d'envoyer l'e-mail.",
      "Annule l'envoi.",
      "Laisse tomber, n'envoie rien.",
      "Finalement n'envoie pas l'e-mail.",
      "Pas d'envoi.",
      'Envoi annulé.',
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
      expect(objectiveRequiresExecutionEvidence({
        ...persistedLiveFalseNegative,
        amendments: [{ messageId: `send-revoke-${index}`, text, timestamp: 10 + index }],
      })).toBe(false);
    }
    for (const text of [
      "Envoi annulé pour Alice. Envoie l'e-mail à Benoît.",
      "N'envoie pas à Alice. Envoie l'e-mail à Benoît.",
      "Pas d'envoi à Alice. Envoie l'e-mail à Benoît.",
      "Attends. Envoie maintenant l'e-mail à Benoît.",
    ]) {
      expect(objectiveRequiresExecutionEvidence({
        ...persistedLiveFalseNegative,
        amendments: [{ messageId: 'send-resume', text, timestamp: 30 }],
      })).toBe(true);
    }

    for (const text of [
      "L'envoi de l'e-mail à Benoît a échoué.",
      "Analyse pourquoi l'envoi de l'e-mail à Benoît a échoué.",
      "Le rapport dit : envoi l'e-mail à Benoît.",
      "Exemple : envoi l'e-mail à Benoît.",
      "Sujet : envoi l'e-mail à Benoît.",
      "La phrase est : envoi l'e-mail à Benoît.",
      "Citation : envoi l'e-mail à Benoît.",
      "N'envoi pas l'e-mail à Benoît.",
      'Envoi le rapport final.',
      'Envoi la version corrigée.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'non-authoritative-send', text });
      expect(objective.requiresExecutionEvidence).not.toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(false);
      const persistedWithoutAuthority = { ...objective };
      delete persistedWithoutAuthority.requiresExecutionEvidence;
      expect(objectiveRequiresExecutionEvidence(persistedWithoutAuthority)).toBe(false);
      expect(objectiveRequiresExecutionEvidence({
        ...persistedWithoutAuthority,
        delegatedRole: 'reviewer',
      })).toBe(false);
    }
  });

  it('treats a direct invoice-email fulfillment delegation as execution authority', () => {
    const liveAgileObjective = [
      'Traite la demande par email de facture',
      'External',
      'Boîte de réception',
      '',
      'Ludivine COMBAZ <office@example.test>',
      'jeu. 17 sept. 15:45 (il y a 17 heures)',
      'À sender@example.test',
      '',
      "qui demande le renvoi d'une facture par mail en pdf",
    ].join('\n');
    for (const text of [
      liveAgileObjective,
      'Prends en charge l’e-mail reçu de Alice <alice@example.com> qui demande de renvoyer la facture en PDF par mail.',
      'Handle the invoice email request from alice@example.com asking you to resend the invoice as a PDF by email.',
      'Please process the email invoice request from alice@example.com requesting you to send it again as a PDF by email.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: `invoice-email-${text}`, text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objective.requiresAcceptanceCriteria).toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);

      const persistedFalseNegative = { ...objective };
      delete persistedFalseNegative.requiresExecutionEvidence;
      delete persistedFalseNegative.requiresAcceptanceCriteria;
      expect(objectiveRequiresExecutionEvidence(persistedFalseNegative)).toBe(true);
      expect(projectLegacyObjectiveCompletionRequirements(persistedFalseNegative)).toMatchObject({
        requiresExecutionEvidence: true,
        requiresAcceptanceCriteria: true,
      });
      expect(objectiveRequiresExecutionEvidence({
        ...persistedFalseNegative,
        delegatedRole: 'reviewer',
      })).toBe(false);
      expect(objectiveRequiresExecutionEvidence({
        ...persistedFalseNegative,
        requiresExecutionEvidence: false,
      })).toBe(false);
    }

    for (const text of [
      'Analyse la demande par email qui demande le renvoi d’une facture PDF par mail.',
      'Le message dit : Traite la demande par email qui demande le renvoi d’une facture PDF par mail.',
      'Traite la demande par email qui demande pourquoi le renvoi de la facture PDF a échoué.',
      'Traite la demande par email qui demande de ne pas renvoyer la facture PDF.',
      'Traite la demande par email qui demande le renvoi de la facture PDF, mais ne la renvoie pas.',
      'Handle the invoice email request asking you not to resend the PDF invoice.',
      'Handle the email request asking you to resend the invoice by email.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: `invoice-email-negative-${text}`, text });
      expect(objective.requiresExecutionEvidence).not.toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(false);
    }
  });

  it('treats the explicit Gentle form creation and SharePoint storage request as execution', () => {
    const liveGentleObjective = "Documente les données reçues de la responsable RH concernant les trâmes d'entretien individuels du cabinet exemple puis je souhaite la création d'un formulaire automatisé basé sur ces questions pour aider les collaborateurs à co remplir leurs entretiens individuels, les données doivent ensuite être stockées dans une liset et un sharepoint RH du cabinet";
    const objective = transitionObjectiveContract({
      messageId: 'gentle-live-root',
      text: liveGentleObjective,
    });
    expect(objective.requiresExecutionEvidence).toBe(true);
    expect(objective.requiresAcceptanceCriteria).toBe(true);
    expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);

    const persistedFalseNegative = { ...objective };
    delete persistedFalseNegative.requiresExecutionEvidence;
    delete persistedFalseNegative.requiresAcceptanceCriteria;
    expect(objectiveRequiresExecutionEvidence(persistedFalseNegative)).toBe(true);
    expect(projectLegacyObjectiveCompletionRequirements(persistedFalseNegative)).toMatchObject({
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
    expect(objectiveRequiresExecutionEvidence({
      ...persistedFalseNegative,
      delegatedRole: 'reviewer',
    })).toBe(false);
    expect(objectiveRequiresExecutionEvidence({
      ...persistedFalseNegative,
      requiresExecutionEvidence: false,
    })).toBe(false);

    for (const text of [
      "Documente la création d'un formulaire automatisé dont les données doivent être stockées dans une liste et un SharePoint RH.",
      'Explique comment créer un formulaire automatisé et stocker les données dans une liste SharePoint RH.',
      "Le rapport dit : je souhaite la création d'un formulaire automatisé, les données doivent être stockées dans une liste et un SharePoint RH.",
      "Je ne souhaite pas la création d'un formulaire automatisé ; les données doivent rester dans la liste SharePoint RH.",
    ]) {
      const observational = transitionObjectiveContract({ messageId: `gentle-negative-${text}`, text });
      expect(observational.requiresExecutionEvidence).not.toBe(true);
      expect(objectiveRequiresExecutionEvidence(observational)).toBe(false);
    }
  });

  it('keeps realization-prefixed analysis requests observational unless they explicitly request a mutation', () => {
    for (const text of [
      'Réalise une nouvelle analyse du comportement des agents.',
      'Réaliser un audit du routeur.',
      'Réalisez le diagnostic des agents.',
      'Réalise l’analyse du comportement des agents.',
      'Réalyse une nouvelle analyse du comportement des agents.',
      'Réalisons une revue du routage.',
      'Réalise un plan de corrections pour le routeur.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'analysis-request', text });
      expect(objective.requiresExecutionEvidence).not.toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(false);
    }

    for (const text of [
      'Réalise un audit puis corrige les défauts détectés.',
      'Réalise le diagnostic et déploie le correctif.',
      'Réalise les corrections nécessaires.',
      'Réalise une nouvelle analyse et optimisation du comportement des agents.',
      'Réalise une analyse et optimsation du routage.',
      'Réalyse une nouvelle analyse et optimsation du comportement des agents.',
      'Réalise une analyse, puis une optimisation du routeur.',
      'Réalise une analyse, et des corrections du routeur.',
      'Réalyse une analyse, puis optimsation du routage.',
      'Réalise une analyse puis l’optimisation du routeur.',
      'Réalise une analyse puis la correction du routeur.',
      'Réalise une analyse, puis l’implémentation du correctif.',
      'Réalise une analyse puis son optimisation.',
      'Review the issue, then implement the fix.',
      'Analyse ces instructions, puis implémente le correctif.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'explicit-mutation', text });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    }
  });

  it('keeps direct artifact-building orders executable without making them high-stakes', () => {
    for (const text of [
      'Implement the requested parser.',
      'Build the requested parser.',
      'Développe le parseur demandé.',
      'Optimise le routeur.',
      'Optimiser le routeur.',
      'Optimisez le routeur.',
      'Optimisons le routeur.',
      'Optimize the router.',
      'Fais les corrections nécessaires.',
      'Effectue les modifications.',
      'Apporte les corrections.',
      'Mets en œuvre les corrections.',
      'Procède à l’optimisation du routeur.',
      'Procède à leur implantation totale et méthodique selon le plan.',
      'Procède à leur implantaiotn totale et méthodique selon le plan.',
      'Fais une analyse et une optimisation du routeur.',
      'Make the necessary changes.',
      'Perform the required modifications.',
      'Carry out the fixes.',
      'Do the fixes.',
      'Please make these corrections.',
      'Run an analysis and optimization of the router.',
      'Réalise le rapport demandé.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'artifact-mutation', text });
      expect(objective).toMatchObject({
        risk: 'standard', orchestrationMode: 'direct', requiresExecutionEvidence: true,
        requiresAcceptanceCriteria: true,
      });
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    }
  });

  it('classifies contentful development, improvement and optimization continuations as execution', () => {
    for (const text of [
      'Poursuit le développement et les améliorations de TRAID et ses fonctionnalités...',
      'Poursuis le développement de TRAID.',
      'Continue le développement de TRAID.',
      'Poursuivez les améliorations de TRAID.',
      'Poursuis l’optimisation de TRAID.',
      'Continue developing TRAID and its features.',
      'Continue the development of TRAID.',
      'Continue improving TRAID.',
      'Continue the improvements to TRAID.',
      'Keep optimizing TRAID.',
      'Améliore TRAID.',
      'Improve TRAID.',
      'Peux-tu améliorer TRAID ?',
      'Could you improve TRAID?',
      'OK, poursuis le développement de TRAID.',
      'Thanks, continue optimizing TRAID.',
      'Oui poursuis le développement de TRAID.',
      'Yes continue developing TRAID.',
      'D’accord poursuis les améliorations de TRAID.',
      'Okay continue improving TRAID.',
      'poursuit l\'analyse et l\'optimisation',
      'poursuit l’analyse et l’optimisation',
      'poursuit l’alanlyse et l’optimsation',
      'Continue the analysis and optimization of TRAID.',
      'Poursuit l’analyse et les corrections.',
      'Continue the analysis and fixes.',
      'Réalyse une nouvelle analyse et optimisation.',
      'Réalyse une nouvelle alanlyse et optimsation.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: `continued-${text}`, text });
      expect(objective).toMatchObject({
        risk: 'standard', requiresExecutionEvidence: true, requiresAcceptanceCriteria: true,
      });
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    }
  });

  it('turns an approved implementation follow-up into authority without replacing the analysed plan', () => {
    const analysedPlan = transitionObjectiveContract({
      messageId: 'analysed-plan',
      text: 'Analyse les problèmes et établis un plan de correction détaillé.',
      nowMs: 1,
    });
    expect(objectiveRequiresExecutionEvidence(analysedPlan)).toBe(false);

    for (const [index, text] of [
      'Procède à leur implantation totale et méthodique selon le plan',
      // Regression fixture: preserve the observed typo without retaining production metadata.
      'Procède à leur implantaiotn totale et méthodique selon le plan',
    ].entries()) {
      const implementation = transitionObjectiveContract({
        existing: analysedPlan,
        messageId: `implement-analysed-plan-${index}`,
        text,
        nowMs: 2 + index,
      });
      expect(implementation).toMatchObject({
        objectiveId: analysedPlan.objectiveId,
        lastUserMessageId: `implement-analysed-plan-${index}`,
        terminalState: 'active',
        requiresExecutionEvidence: true,
        requiresAcceptanceCriteria: true,
      });
      expect(implementation.amendments?.at(-1)?.messageId).toBe(`implement-analysed-plan-${index}`);
      expect(objectiveRequiresExecutionEvidence(implementation)).toBe(true);
    }

    const persistedProductionObjective: ActiveSessionObjective = omitUndefined<ActiveSessionObjective>({
      ...transitionObjectiveContract({
        messageId: 'persisted-zero-implementation',
        text: 'Procède à leur implantaiotn totale et méthodique selon le plan',
        nowMs: 10,
      }),
      requiresExecutionEvidence: undefined,
      requiresAcceptanceCriteria: undefined,
      terminalState: 'exhausted',
    });
    expect(objectiveRequiresExecutionEvidence(persistedProductionObjective)).toBe(true);
    expect(projectLegacyObjectiveCompletionRequirements(persistedProductionObjective)).toMatchObject({
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
  });
});
