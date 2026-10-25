import { describe, expect, it } from "bun:test";
import { objectiveRequiresExecutionEvidence, transitionObjectiveContract } from "./objective-contract.ts";

describe('durable objective contract', () => {
  it.each([
    ['Modifie le contrat juridique de production.', 'legal'],
    ['Corrige la facture puis effectue le paiement en production.', 'financial'],
  ] as const)('lets a new substantive amendment replace an older clarified security domain: %s', (text, evidenceDomain) => {
    const plc = transitionObjectiveContract({
      messageId: `multi-domain-root-${evidenceDomain}`,
      text: 'Implémente le connecteur ISAGRI vers SharePoint.',
    });
    const staleMedical = {
      ...plc,
      risk: 'high-stakes' as const,
      orchestrationMode: 'mission' as const,
      evidenceDomain: 'medical' as const,
      evidenceRequirement: 'authoritative-sources-before-mutation' as const,
      completionCriteria: [...plc.completionCriteria, 'independent-review-passed' as const],
    };
    const securityClarification = transitionObjectiveContract({
      existing: staleMedical,
      messageId: `multi-domain-security-${evidenceDomain}`,
      text: 'Le terme « traitement » désigne ici une intégration API, pas un acte médical. Corrige les permissions RBAC et modifie le secret du connecteur.',
    });
    expect(securityClarification.evidenceDomain).toBe('security');

    const amended = transitionObjectiveContract({
      existing: securityClarification,
      messageId: `multi-domain-current-${evidenceDomain}`,
      text,
    });
    expect(amended).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain,
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });

    const resumed = transitionObjectiveContract({
      existing: amended,
      messageId: `multi-domain-resume-${evidenceDomain}`,
      text: 'Poursuit',
    });
    expect(resumed).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain,
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
  });

  it.each([
    'Le terme « traitement » désigne ici une intégration API, pas un acte médical. Modifie la dose de morphine.',
    'Le terme « traitement » désigne ici une intégration API, pas un acte médical. Ajuste le dosage de warfarine.',
    'Le terme « traitement » désigne ici une intégration API, pas un acte médical. Réalise une appendicectomie.',
    'Treatment refers to data processing and not a medical procedure. Change the morphine dose.',
  ])('keeps a clinical instruction after the clarification high-stakes immediately and on resume: %s', (text) => {
    const plc = transitionObjectiveContract({
      messageId: `post-clarification-clinical-root-${text}`,
      text: 'Implémente le connecteur ISAGRI vers SharePoint.',
    });
    const staleMedical = {
      ...plc,
      risk: 'high-stakes' as const,
      orchestrationMode: 'mission' as const,
      evidenceDomain: 'medical' as const,
      evidenceRequirement: 'authoritative-sources-before-mutation' as const,
      completionCriteria: [...plc.completionCriteria, 'independent-review-passed' as const],
    };
    const corrected = transitionObjectiveContract({
      existing: staleMedical,
      messageId: `post-clarification-clinical-${text}`,
      text,
    });
    expect(corrected).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain: 'medical',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });

    const resumedFromLegacyPersistence = transitionObjectiveContract({
      existing: {
        ...staleMedical,
        lastUserMessageId: `persisted-post-clarification-clinical-${text}`,
        continuationCount: 1,
        amendments: [{
          messageId: `persisted-post-clarification-clinical-${text}`,
          text,
          timestamp: 4,
        }],
      },
      messageId: `post-clarification-clinical-resume-${text}`,
      text: 'Poursuit',
    });
    expect(resumedFromLegacyPersistence).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain: 'medical',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
  });

  it.each([
    ['Efface les données de production.', undefined],
    ['Nettoie les données de production.', undefined],
    ['Erase production data.', undefined],
    ['Wipe production data.', undefined],
    ['Réinitialise le token OAuth.', 'security'],
    ['Modifie les ACL.', 'security'],
    ['Accorde le rôle administrateur.', 'security'],
    ['Ajoute Alice au groupe administrateurs.', 'security'],
    ['Reset the OAuth token.', 'security'],
    ['Modify the ACLs.', 'security'],
    ['Grant the administrator role.', 'security'],
    ['Add Alice to the administrators group.', 'security'],
  ] as const)('recovers newly recognized sensitive mutations immediately and from persisted state: %s', (text, evidenceDomain) => {
    const immediate = transitionObjectiveContract({
      messageId: `new-sensitive-immediate-${text}`,
      text,
    });
    expect(immediate.risk).toBe('high-stakes');
    expect(immediate.orchestrationMode).toBe('mission');
    expect(immediate.requiresExecutionEvidence).toBe(true);
    expect(immediate.completionCriteria).toContain('independent-review-passed');
    expect(immediate.evidenceDomain).toBe(evidenceDomain);
    expect(immediate.evidenceRequirement).toBe(
      evidenceDomain ? 'authoritative-sources-before-mutation' : undefined,
    );

    const base = transitionObjectiveContract({
      messageId: `new-sensitive-root-${text}`,
      text: 'Implémente le connecteur ISAGRI vers SharePoint.',
    });
    const persistedBeforeClassifierFix = {
      ...base,
      risk: 'standard' as const,
      lastUserMessageId: `persisted-new-sensitive-${text}`,
      continuationCount: 1,
      amendments: [{
        messageId: `persisted-new-sensitive-${text}`,
        text,
        timestamp: 5,
      }],
    };
    delete persistedBeforeClassifierFix.evidenceDomain;
    delete persistedBeforeClassifierFix.evidenceRequirement;
    const resumed = transitionObjectiveContract({
      existing: persistedBeforeClassifierFix,
      messageId: `new-sensitive-resume-${text}`,
      text: 'Poursuit',
    });
    expect(resumed.risk).toBe('high-stakes');
    expect(resumed.orchestrationMode).toBe('mission');
    expect(resumed.completionCriteria).toContain('independent-review-passed');
    expect(resumed.evidenceDomain).toBe(evidenceDomain);
    expect(resumed.evidenceRequirement).toBe(
      evidenceDomain ? 'authoritative-sources-before-mutation' : undefined,
    );
  });

  it.each([
    'Le terme « traitement » désigne ici une intégration API, pas un acte médical. Déploie le connecteur en production.',
    'Le terme « traitement » désigne ici une intégration API, pas un acte médical. Supprime les données de test en production.',
  ])('keeps domainless production risk high while clearing the stale medical evidence gate: %s', (text) => {
    const plc = transitionObjectiveContract({
      messageId: 'domainless-risk-root',
      text: 'Implémente le connecteur ISAGRI vers SharePoint.',
    });
    const staleMedical = {
      ...plc,
      risk: 'high-stakes' as const,
      orchestrationMode: 'mission' as const,
      evidenceDomain: 'medical' as const,
      evidenceRequirement: 'authoritative-sources-before-mutation' as const,
      completionCriteria: [...plc.completionCriteria, 'independent-review-passed' as const],
    };
    const corrected = transitionObjectiveContract({
      existing: staleMedical,
      messageId: `domainless-risk-${text}`,
      text,
    });
    expect(corrected.risk).toBe('high-stakes');
    expect(corrected.evidenceDomain).toBeUndefined();
    expect(corrected.evidenceRequirement).toBeUndefined();
    expect(corrected.requiresExecutionEvidence).toBe(true);

    const resumedFromLegacyPersistence = transitionObjectiveContract({
      existing: {
        ...staleMedical,
        lastUserMessageId: `persisted-domainless-risk-${text}`,
        continuationCount: 1,
        amendments: [{
          messageId: `persisted-domainless-risk-${text}`,
          text,
          timestamp: 3,
        }],
      },
      messageId: `domainless-risk-resume-${text}`,
      text: 'Poursuit',
    });
    expect(resumedFromLegacyPersistence.risk).toBe('high-stakes');
    expect(resumedFromLegacyPersistence.evidenceDomain).toBeUndefined();
    expect(resumedFromLegacyPersistence.evidenceRequirement).toBeUndefined();
  });

  it('keeps a genuinely clinical objective high-stakes despite a false non-medical clarification', () => {
    const clinical = transitionObjectiveContract({
      messageId: 'clinical-root',
      text: 'Le patient est atteint du VIH. Adapte le traitement.',
    });
    const corrected = transitionObjectiveContract({
      existing: clinical,
      messageId: 'clinical-false-clarification',
      text: 'Le terme « traitement » désigne ici une intégration API, pas un acte médical. Poursuis le traitement.',
    });

    expect(corrected).toMatchObject({
      risk: 'high-stakes',
      orchestrationMode: 'mission',
      evidenceDomain: 'medical',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      requiresExecutionEvidence: true,
    });
    expect(corrected.completionCriteria).toContain('independent-review-passed');
  });

  it.each([
    'Le terme « traitement » désigne ici une intégration puis adapte la chimiothérapie du patient, pas un acte médical.',
    'Le terme « traitement » désigne ici une intégration pour le patient atteint du VIH, pas un acte médical. Adapte le traitement.',
    'Le terme « traitement » désigne ici une intégration puis modifie la dose de morphine, pas un acte médical.',
    'Le terme « traitement » désigne ici une intégration puis ajuste le dosage de warfarine, pas un acte médical.',
    'Le terme « traitement » désigne ici une intégration puis réalise une appendicectomie, pas un acte médical.',
    'The term treatment means an integration then change the morphine dose, not a medical act.',
    'Traitement signifie un workflow API, puis modifie la dose de morphine, pas un acte médical.',
  ])('does not let an operational clarification swallow a clinical signal: %s', (text) => {
    const plc = transitionObjectiveContract({
      messageId: 'clinical-wildcard-root',
      text: 'Implémente le connecteur ISAGRI vers SharePoint.',
    });
    const corrected = transitionObjectiveContract({
      existing: {
        ...plc,
        risk: 'high-stakes',
        orchestrationMode: 'mission',
        evidenceDomain: 'medical',
        evidenceRequirement: 'authoritative-sources-before-mutation',
      },
      messageId: `clinical-wildcard-${text}`,
      text,
    });

    expect(corrected).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain: 'medical',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
  });

  it.each([
    'Commence le traitement du lot de données. Ensuite, résume le dossier patient.',
    'Réduis le traitement des requêtes API. Le patient sera discuté ensuite.',
    'Start the treatment batch. Separately, summarize the patient report.',
    'Reduce the treatment of API requests. The patient is discussed separately.',
    'Adjust the treatment pipeline. Then read the patient file.',
  ])('keeps a separate medical clause from promoting an operational mutation: %s', (text) => {
    const objective = transitionObjectiveContract({ messageId: `operational-medical-${text}`, text });
    expect(objective.risk).toBe('standard');
    expect(objective.evidenceRequirement).toBeUndefined();
    expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    expect(objective.requiresAcceptanceCriteria).toBe(true);
  });

  it.each([
    'Change the chemotherapy inventory treatment.',
    'Optimise le traitement des séances de physiothérapie dans le planning.',
  ])('keeps an operational mutation near a clinical term outside the medical evidence gate: %s', (text) => {
    const objective = transitionObjectiveContract({ messageId: `operational-clinical-${text}`, text });
    expect(objective.risk).toBe('standard');
    expect(objective.evidenceDomain).toBeUndefined();
    expect(objective.evidenceRequirement).toBeUndefined();
  });

  it.each([
    'Analyse le traitement du VIH en lecture seule.',
    'Analyse comment adapter le traitement du VIH.',
    'Analyze how to adjust treatment for HIV.',
    'N’adapte pas le traitement du VIH.',
    'Do not adjust treatment for HIV.',
    'Le rapport recommande d’adapter le traitement du VIH.',
    'The report recommends to prescribe antibiotic treatment.',
    'Faut-il adapter le traitement du VIH ?',
    'Adapter le traitement du VIH serait dangereux.',
    'Adapter le traitement du VIH ?',
    'Il faudrait adapter le traitement du VIH.',
    'On pourrait réduire le dosage du traitement du VIH.',
    'Commence par analyser le traitement du VIH en lecture seule.',
    'Réduis le rapport à trois lignes sur le traitement du VIH.',
    'Le médecin recommande d’adapter le traitement du VIH.',
    'The doctor recommends to adjust treatment for HIV.',
    'Adapter le traitement du VIH reste une option.',
    'Adapter le traitement du VIH demeure risqué.',
    'Adapter le traitement du VIH constitue une option.',
    'Réactiver le dev login reste une option.',
    'Réactiver le dev login demeure risqué.',
    'Réactiver le dev login constitue une option.',
    'Réactiver le dev login représente un risque.',
    'Réactiver le dev login s’avère dangereux.',
    'Réactiver le dev login devient une option.',
    'Réactiver le dev login apparaît risqué.',
    'Le médecin dit : adaptez le traitement pour le VIH.',
    'Le docteur déclare : commencez le traitement par dialyse.',
    'The doctor says: adjust treatment for HIV.',
    'The doctor states: start the blood transfusion treatment.',
    'Adapter le traitement du VIH ne doit jamais être fait.',
    'Adapter le traitement du VIH doit être évité.',
    'Adapter le traitement du VIH était une erreur.',
    'Adapter le traitement du VIH sera risqué.',
    'Adapter le traitement du VIH nécessite une autorisation médicale.',
    'Réduire le dosage du traitement du VIH implique un risque.',
    'To adjust the treatment for HIV is risky.',
    'The option to start treatment for HIV remains controversial.',
    'The doctor says we should adjust the treatment for HIV.',
    'The doctor states that we must start treatment for HIV.',
    'The doctor recommends that we adjust treatment for HIV.',
    'Le médecin dit que nous devrions adapter le traitement du VIH.',
    'Le docteur indique qu’il faut commencer le traitement par dialyse.',
    'Selon le médecin, il faut adapter le traitement du VIH.',
    'When should the doctor adjust treatment for HIV?',
    'Quand le médecin devrait-il adapter le traitement du VIH ?',
    'N’administre pas de morphine au patient.',
    'Do not inject insulin into the patient.',
    'Le rapport recommande d’administrer de la morphine au patient.',
    'The report recommends to perform an appendectomy.',
    'Faut-il injecter de l’insuline au patient ?',
    'Should we perform an appendectomy?',
    'Do not stop warfarin.',
    'Should we switch the patient to morphine?',
    'The doctor says to hold insulin.',
    'The report recommends doubling the insulin dose.',
    'The patient was put on morphine.',
    'Le médecin met le patient sous morphine.',
  ])('keeps medical analysis, negation and reported speech non-mutating: %s', (text) => {
    const objective = transitionObjectiveContract({ messageId: `medical-read-${text}`, text });
    expect(objective.requiresExecutionEvidence).not.toBe(true);
    expect(objective.evidenceRequirement).toBeUndefined();
    expect(objectiveRequiresExecutionEvidence(objective)).toBe(false);
  });

  it.each([
    ['Analyse ce NDA en lecture seule, sans le modifier.', 'legal'],
    ['Audite les permissions RBAC en lecture seule, sans rien modifier.', 'security'],
    ['Analyse les écritures comptables en lecture seule, sans correction.', 'financial'],
  ] as const)('promotes a deictic correction of a read-only %s audit to guarded high-stakes execution', (text, domain) => {
    const audit = transitionObjectiveContract({ messageId: `audit-${domain}`, text });
    expect(audit).toMatchObject({ risk: 'standard', evidenceDomain: domain });
    expect(audit.requiresExecutionEvidence).not.toBe(true);
    expect(audit.evidenceRequirement).toBeUndefined();

    const correction = transitionObjectiveContract({
      existing: audit, messageId: `correct-${domain}`, text: 'Fais les corrections nécessaires.',
    });
    expect(correction).toMatchObject({
      risk: 'high-stakes', evidenceDomain: domain, requiresExecutionEvidence: true,
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
    expect(correction.completionCriteria).toContain('independent-review-passed');
  });

  it('keeps the authenticated audit domain across a later negated subject mention', () => {
    const audit = transitionObjectiveContract({
      messageId: 'legal-audit', text: 'Analyse ce contrat juridique en lecture seule, sans le modifier.',
    });
    const quotedFinding = transitionObjectiveContract({
      existing: audit, messageId: 'quoted-security-finding',
      text: 'Le rapport mentionne les permissions de sécurité. Ne modifie rien.',
    });
    expect(quotedFinding).toMatchObject({ evidenceDomain: 'legal' });

    const correction = transitionObjectiveContract({
      existing: quotedFinding, messageId: 'correct-legal-findings',
      text: 'Fais les corrections nécessaires.',
    });
    expect(correction).toMatchObject({
      risk: 'high-stakes', evidenceDomain: 'legal', requiresExecutionEvidence: true,
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });

    const legacyAudit = { ...audit, evidenceDomain: undefined };
    const legacyMention = transitionObjectiveContract({
      existing: legacyAudit, messageId: 'legacy-quoted-security-finding',
      text: 'Le rapport mentionne les permissions de sécurité. Ne modifie rien.',
    });
    const legacyCorrection = transitionObjectiveContract({
      existing: { ...legacyMention, evidenceDomain: undefined }, messageId: 'legacy-correct-legal-findings',
      text: 'Fais les corrections nécessaires.',
    });
    expect(legacyCorrection).toMatchObject({
      risk: 'high-stakes', evidenceDomain: 'legal', requiresExecutionEvidence: true,
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
  });
});
