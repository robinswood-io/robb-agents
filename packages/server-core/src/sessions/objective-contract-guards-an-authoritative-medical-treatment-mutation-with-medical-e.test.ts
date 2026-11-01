import { describe, expect, it } from "bun:test";
import { objectiveRequiresExecutionEvidence, transitionObjectiveContract } from "./objective-contract.ts";

describe('durable objective contract', () => {
  it.each([
    'Modifie le traitement du VIH.',
    'Adapte le traitement de l’insuffisance cardiaque.',
    'Prescris un traitement antibiotique.',
    'Réduis le dosage du traitement.',
    'Commence un traitement médicamenteux pour l’asthme.',
    'Adjust treatment for chronic pain.',
    'Prescribe antibiotic treatment.',
    'Reduce the treatment dosage.',
    'Le patient est atteint du VIH. Adapte le traitement.',
    'Diagnostic médical : VIH. Adapte le traitement.',
    'Pour l’insuffisance cardiaque. Adapte le traitement.',
    'Heart failure was diagnosed. Adjust the treatment.',
    'Adapte le traitement. Le patient est atteint du VIH.',
    'Adapte le traitement de chimiothérapie.',
    'Commence le traitement par dialyse.',
    'Adjust the chemotherapy treatment.',
    'Change the radiotherapy treatment.',
    'Arrête le traitement par radiothérapie.',
    'Adapte le traitement par immunothérapie.',
    'Commence le traitement par hormonothérapie.',
    'Change the psychotherapy treatment.',
    'Adapte le traitement par chirurgie.',
    'Adjust the surgery treatment.',
    'Adapte le traitement par physiothérapie.',
    'Adapte le traitement par kinésithérapie.',
    'Change the physical therapy treatment.',
    'Commence le traitement par transfusion sanguine.',
    'Adapte le traitement par greffe de rein.',
    'Commence le traitement par oxygénothérapie.',
    'Adjust the gene therapy treatment.',
    'Start the blood transfusion treatment.',
    'Commence le traitement par vaccination.',
    'Change the anticoagulant treatment.',
    'Modifie le traitement de la mucoviscidose.',
    'Adaptez le traitement du VIH.',
    'Commencez le traitement par dialyse.',
    'Prescribe antibiotics to the patient.',
    'Prescris des antibiotiques au patient.',
    'Prescris de la morphine.',
    'Prescribe insulin to the patient.',
    'Commence la chimiothérapie pour le patient.',
    'Start chemotherapy for the patient.',
    'Adapte la dialyse du patient.',
    'Adjust the patient’s dialysis.',
    'Reduce the insulin dose for the patient.',
    'Ajuste le dosage de warfarine',
    'Augmente la dose de morphine',
    'Increase the morphine dosage',
    'Administre de la morphine au patient',
    'Injecte de l’insuline au patient',
    'Réalise une appendicectomie',
    'Perform an appendectomy',
    'Effectue une biopsie',
    'Switch the patient to morphine.',
    'Stop warfarin.',
    'Hold insulin.',
    'Double the insulin dose.',
    'Halve the morphine dose.',
    'Put the patient on morphine.',
    'Mets le patient sous morphine.',
  ])('guards an authoritative medical treatment mutation with medical evidence: %s', (text) => {
    const objective = transitionObjectiveContract({ messageId: `medical-${text}`, text });
    expect(objective).toMatchObject({
      risk: 'high-stakes',
      orchestrationMode: 'mission',
      evidenceDomain: 'medical',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
    expect(objective.completionCriteria).toContain('independent-review-passed');
    expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
  });

  it.each([
    'Adapte le traitement des données du PLC.',
    'Commence le traitement de la réponse API.',
    'Réduis le traitement du lot batch.',
    'Adjust the treatment of incoming API requests.',
    'Reduce the batch treatment pipeline.',
    'Prescris le traitement des candidatures.',
    'Prescribe the treatment of customer relationships.',
    'Réduis le dosage du traitement du lot batch.',
    'Adjust the pharmaceutical treatment of inventory.',
    'Le rapport mentionne le VIH. Prescris le traitement des candidatures.',
    'Heart failure is documented. Adjust the treatment of inventory.',
    'Adapte le traitement des données de chimiothérapie.',
  ])('does not promote an operational treatment mutation to the medical evidence gate: %s', (text) => {
    const objective = transitionObjectiveContract({ messageId: `operational-${text}`, text });
    expect(objective.risk).toBe('standard');
    expect(objective.evidenceDomain).toBeUndefined();
    expect(objective.evidenceRequirement).toBeUndefined();
    expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    expect(objective.requiresAcceptanceCriteria).toBe(true);
  });

  it('downgrades a stale PLC medical contract only after an explicit operational clarification', () => {
    const plcText = "On a reçu la réponse d'ISAGRI pour l'API qui remonte les données dans SharePoint PLC. Implémente le connecteur.";
    const plc = transitionObjectiveContract({
      messageId: 'plc-root',
      text: plcText,
    });
    const staleMedical = {
      ...plc,
      risk: 'high-stakes' as const,
      orchestrationMode: 'mission' as const,
      evidenceDomain: 'medical' as const,
      evidenceRequirement: 'authoritative-sources-before-mutation' as const,
      completionCriteria: [...plc.completionCriteria, 'independent-review-passed' as const],
    };
    const clarification = 'Reprends maintenant avec le staging corrigé. Le terme « traitement » désigne ici une opération d’intégration ISAGRI, pas un acte médical : ne redemande donc aucune source médicale. Relis les éléments déjà acquis, recherche les paramètres PLC dans les sources autorisées, puis prépare, implémente et teste toutes les parties sûres du connecteur ISAGRI → SharePoint. Lève seul les blocages récupérables et ne t’arrête que si un identifiant, un secret ou un endpoint réellement absent exige une intervention humaine ; dans ce cas, formule exactement l’élément manquant après avoir épuisé les sources disponibles. Termine par une vérification réelle et une revue indépendante.';
    const corrected = transitionObjectiveContract({
      existing: {
        ...staleMedical,
        amendments: [{
          messageId: 'plc-host-header',
          text: `${plcText}\n\n<host_objective_contract objective_user_message_id="plc-root" orchestration="mission" risk="high-stakes">\nHigh-stakes evidence gate: permissions and secrets remain protected.\n</host_objective_contract>`,
          timestamp: 1,
        }],
      },
      messageId: 'plc-clarification',
      text: clarification,
    });

    expect(corrected).toMatchObject({
      risk: 'standard',
      orchestrationMode: 'mission',
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
    expect(corrected.evidenceDomain).toBeUndefined();
    expect(corrected.evidenceRequirement).toBeUndefined();
    expect(corrected.completionCriteria).not.toContain('independent-review-passed');

    // Also migrate a clarification that was already persisted by the previous
    // runtime before this fix, on the next ordinary continuation.
    const migratedOnResume = transitionObjectiveContract({
      existing: {
        ...staleMedical,
        lastUserMessageId: 'persisted-plc-clarification',
        continuationCount: 1,
        amendments: [{ messageId: 'persisted-plc-clarification', text: clarification, timestamp: 2 }],
      },
      messageId: 'plc-resume',
      text: 'Poursuit',
    });
    expect(migratedOnResume.risk).toBe('standard');
    expect(migratedOnResume.evidenceDomain).toBeUndefined();
    expect(migratedOnResume.evidenceRequirement).toBeUndefined();
    expect(migratedOnResume.completionCriteria).not.toContain('independent-review-passed');
  });

  it('repairs a stale medical label after a fully restated concrete software recovery mission', () => {
    const base = transitionObjectiveContract({
      messageId: 'orion-root',
      text: "Impossible de reconnecter les IA c'est une regression",
      nowMs: 1,
    });
    const staleMedical = {
      ...base,
      risk: 'high-stakes' as const,
      orchestrationMode: 'mission' as const,
      evidenceDomain: 'medical' as const,
      evidenceRequirement: 'authoritative-sources-before-mutation' as const,
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
      completionCriteria: [...base.completionCriteria, 'independent-review-passed' as const],
      amendments: [
        { messageId: 'orion-retry', text: 'Reprend eh corrige', timestamp: 2 },
        { messageId: 'orion-proceed', text: 'Procède', timestamp: 3 },
      ],
    };
    const restatement = 'Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge. Diagnostique puis corrige durablement le pont, démarre ou redémarre uniquement ce service si nécessaire, redéploie Orion seulement si l’état constaté l’exige, puis vérifie la santé, la révision déployée et le test bun run test:orion-production.';
    const corrected = transitionObjectiveContract({
      existing: staleMedical,
      messageId: 'orion-restatement',
      text: restatement,
      nowMs: 4,
    });
    expect(corrected).toMatchObject({
      risk: 'standard',
      orchestrationMode: 'mission',
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
    expect(corrected.evidenceDomain).toBeUndefined();
    expect(corrected.evidenceRequirement).toBeUndefined();
    expect(corrected.completionCriteria).not.toContain('independent-review-passed');

    const migratedOnResume = transitionObjectiveContract({
      existing: {
        ...staleMedical,
        lastUserMessageId: 'orion-persisted-restatement',
        continuationCount: 3,
        amendments: [
          ...(staleMedical.amendments ?? []),
          { messageId: 'orion-persisted-restatement', text: restatement, timestamp: 4 },
        ],
      },
      messageId: 'orion-resume',
      text: 'Poursuis',
      nowMs: 5,
    });
    expect(migratedOnResume.evidenceDomain).toBeUndefined();
    expect(migratedOnResume.evidenceRequirement).toBeUndefined();
    expect(migratedOnResume.completionCriteria).not.toContain('independent-review-passed');
  });

  it('classifies the current Orion SSH maintenance root from its current bounded subject', () => {
    const text = 'Le staging corrigé bb5f447 est actif. Cible uniquement le serveur dev, /srv/workspace/orion et le service orion-agent-bridge ; ne touche ni Traefik global ni aucun autre service. Utilise exclusivement rbw-servers et ses outils SSH structurés. Diagnostique puis applique la correction durable avec sauvegarde et retour arrière ; démarre ou redémarre uniquement orion-agent-bridge si nécessaire, et redéploie Orion seulement si l’état constaté l’exige. Vérifie que GET /assistant-api/accounts retourne 200, que /parametres fonctionne, que santé et révision sont cohérentes, et que bun run test:orion-production réussit dans /srv/workspace/orion.';
    const objective = transitionObjectiveContract({ messageId: 'orion-current-root', text });
    expect(objective).toMatchObject({
      risk: 'standard',
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
    expect(objective.evidenceDomain).toBeUndefined();
    expect(objective.evidenceRequirement).toBeUndefined();
  });

  it('does not let a concrete software restatement erase a genuine clinical root', () => {
    const clinical = transitionObjectiveContract({
      messageId: 'clinical-software-root',
      text: 'Le patient est atteint du VIH. Adapte son traitement médical.',
      nowMs: 1,
    });
    const restated = transitionObjectiveContract({
      existing: clinical,
      messageId: 'clinical-software-restatement',
      text: 'Cible exacte : serveur clinique, /srv/workspace/care et uniquement le service care-agent-bridge. Diagnostique puis corrige durablement le pont, redémarre ce service, puis vérifie les tests et la santé du patient avant de poursuivre son traitement médical.',
      nowMs: 2,
    });
    expect(restated).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain: 'medical',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
    expect(restated.completionCriteria).toContain('independent-review-passed');
  });

  it.each([
    'Sur le serveur dev et /srv/workspace/legal, modifie la clause juridique du contrat client, déploie le service puis vérifie les tests.',
    'Sur le serveur dev et /srv/workspace/care, adapte le traitement médical du patient, redémarre le service puis vérifie les tests.',
    'Sur le serveur dev et /srv/workspace/iam, corrige les permissions RBAC et fais une rotation du token OAuth, redéploie le service puis vérifie les tests.',
  ])('does not let structured SSH or a software path erase a real high-stakes mission: %s', text => {
    const objective = transitionObjectiveContract({ messageId: `high-stakes-ssh-${text}`, text });
    expect(objective.risk).toBe('high-stakes');
    expect(objective.evidenceRequirement).toBe('authoritative-sources-before-mutation');
    expect(objective.completionCriteria).toContain('independent-review-passed');
  });

  it('downgrades a stale legal gate after a full technical e-doc incident restatement', () => {
    const base = transitionObjectiveContract({
      messageId: 'pns-technical-root',
      text: 'Diagnostique le worker PNS puis corrige sa synchronisation.',
    });
    const staleLegal = {
      ...base,
      risk: 'high-stakes' as const,
      orchestrationMode: 'mission' as const,
      evidenceDomain: 'legal' as const,
      evidenceRequirement: 'authoritative-sources-before-mutation' as const,
      completionCriteria: [...base.completionCriteria, 'independent-review-passed' as const],
    };
    const restatement = 'Reprends et termine la résolution e-doc du contrat PNS 3602. Utilise uniquement les API et rbw-servers/SSH structuré. Le contrat est déjà signé mais la file remonte Failed, et aucune invitation, signature ou notification ne doit être réémise. Réconcilie les journaux et la base, diagnostique puis corrige durablement le mapping/synchronisation, et vérifie par preuves serveur/API le PDF dans le bucket.';
    const corrected = transitionObjectiveContract({
      existing: staleLegal,
      messageId: 'pns-technical-restatement',
      text: restatement,
    });
    expect(corrected).toMatchObject({
      risk: 'standard',
      orchestrationMode: 'mission',
      requiresExecutionEvidence: true,
    });
    expect(corrected.evidenceDomain).toBeUndefined();
    expect(corrected.evidenceRequirement).toBeUndefined();
    expect(corrected.completionCriteria).not.toContain('independent-review-passed');

    const migratedOnResume = transitionObjectiveContract({
      existing: {
        ...staleLegal,
        lastUserMessageId: 'persisted-pns-technical-restatement',
        continuationCount: 1,
        amendments: [{
          messageId: 'persisted-pns-technical-restatement',
          text: restatement,
          timestamp: 2,
        }],
      },
      messageId: 'pns-technical-resume',
      text: 'Poursuit',
    });
    expect(migratedOnResume.risk).toBe('standard');
    expect(migratedOnResume.evidenceDomain).toBeUndefined();
    expect(migratedOnResume.evidenceRequirement).toBeUndefined();
    expect(migratedOnResume.completionCriteria).not.toContain('independent-review-passed');
  });

  it.each([
    'Rédige et modifie ce contrat juridique pour le client.',
    'Supprime le contrat via API puis vérifie son statut dans la base.',
    'Rewrite the contract via API, then inspect its status in the database.',
    'Le contrat PNS 3602 doit être supprimé via API, puis diagnostique son statut dans la base.',
    'The PNS contract must be deleted via API, then inspect its database status.',
    'Dans le contrat PNS 3602, modifie la clause puis vérifie le statut via API.',
    'Le document juridique PNS doit être supprimé via API, puis diagnostique son statut.',
  ])('never lets a technical amendment downgrade a genuinely legal root: %s', (rootText) => {
    const legalRoot = transitionObjectiveContract({
      messageId: 'legal-contract-root',
      text: rootText,
    });
    expect(legalRoot).toMatchObject({ risk: 'high-stakes', evidenceDomain: 'legal' });
    expect(legalRoot.completionCriteria).toContain('independent-review-passed');

    const continued = transitionObjectiveContract({
      existing: legalRoot,
      messageId: 'legal-contract-technical-amendment',
      text: 'Diagnostique aussi la synchronisation e-doc du contrat via API et SSH sur pns, puis vérifie son statut dans la base.',
    });
    expect(continued).toMatchObject({ risk: 'high-stakes', evidenceDomain: 'legal' });
    expect(continued.completionCriteria).toContain('independent-review-passed');
  });

  it.each([
    'Fais les corrections nécessaires.',
    'Corrige les problèmes détectés.',
  ])('does not retarget a PLC correction to a conditionally mentioned secret: %s', (followUp) => {
    const clarification = 'Reprends maintenant avec le staging corrigé. Le terme « traitement » désigne ici une opération d’intégration ISAGRI, pas un acte médical : ne redemande donc aucune source médicale. Relis les éléments déjà acquis, recherche les paramètres PLC dans les sources autorisées, puis prépare, implémente et teste toutes les parties sûres du connecteur ISAGRI → SharePoint. Lève seul les blocages récupérables et ne t’arrête que si un identifiant, un secret ou un endpoint réellement absent exige une intervention humaine ; dans ce cas, formule exactement l’élément manquant après avoir épuisé les sources disponibles. Termine par une vérification réelle et une revue indépendante.';
    const plc = transitionObjectiveContract({ messageId: 'plc-fresh-root', text: clarification });
    expect(plc).toMatchObject({ risk: 'standard', requiresExecutionEvidence: true });

    const continued = transitionObjectiveContract({
      existing: plc,
      messageId: `plc-fresh-${followUp}`,
      text: followUp,
    });
    expect(continued).toMatchObject({
      risk: 'standard',
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
    expect(continued.evidenceRequirement).toBeUndefined();
    expect(continued.evidenceDomain).toBeUndefined();
  });

  it.each([
    'Traitement signifie un workflow API et non médical.',
    'Treatment refers to data processing and not a medical procedure.',
  ])('accepts an explicitly conjoined nominal operational clarification: %s', (text) => {
    const plc = transitionObjectiveContract({
      messageId: 'conjoined-clarification-root',
      text: 'Implémente le connecteur ISAGRI vers SharePoint.',
    });
    const corrected = transitionObjectiveContract({
      existing: {
        ...plc,
        risk: 'high-stakes',
        evidenceDomain: 'medical',
        evidenceRequirement: 'authoritative-sources-before-mutation',
      },
      messageId: `conjoined-clarification-${text}`,
      text,
    });
    expect(corrected.risk).toBe('standard');
    expect(corrected.evidenceDomain).toBeUndefined();
    expect(corrected.evidenceRequirement).toBeUndefined();
  });

  it('never downgrades real RBAC or secret mutations hidden beside the clarification, including on resume', () => {
    const plc = transitionObjectiveContract({
      messageId: 'security-plc-root',
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
    const securityClarification = 'Le terme « traitement » désigne ici une intégration API, pas un acte médical. Corrige les permissions RBAC et modifie le secret du connecteur.';
    const corrected = transitionObjectiveContract({
      existing: staleMedical,
      messageId: 'security-clarification',
      text: securityClarification,
    });
    expect(corrected).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain: 'security',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });

    const resumedFromLegacyPersistence = transitionObjectiveContract({
      existing: {
        ...staleMedical,
        lastUserMessageId: 'persisted-security-clarification',
        continuationCount: 1,
        amendments: [{
          messageId: 'persisted-security-clarification',
          text: securityClarification,
          timestamp: 2,
        }],
      },
      messageId: 'security-resume',
      text: 'Poursuit',
    });
    expect(resumedFromLegacyPersistence).toMatchObject({
      risk: 'high-stakes',
      evidenceDomain: 'security',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });
  });
});
