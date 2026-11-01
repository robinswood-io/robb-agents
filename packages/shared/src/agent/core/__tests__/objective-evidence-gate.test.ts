import { afterEach, describe, expect, it } from "bun:test";
import { classifyHighStakesEvidenceDomain, detectHighStakesEvidenceDomain, isConcreteOperationalSoftwareRestatement, isOperationalTechnicalContractLifecycleObjective, checkObjectiveEvidenceBeforeMutation, clearObjectiveEvidenceGate } from "../objective-evidence-gate.ts";
import { DIRECT_MEDICAL_MUTATION_CASES, DIRECT_RBAC_MUTATION_CASES, NON_AUTHORITATIVE_SENSITIVE_LANGUAGE_CASES } from "./sensitive-mutation-language-fixtures.ts";
import { beginObjectiveEvidenceGate } from "./testing/objective-evidence-gate-fixture.ts";

describe('high-stakes objective evidence gate', () => {
  afterEach(() => clearObjectiveEvidenceGate('s1'));

  it.each(DIRECT_MEDICAL_MUTATION_CASES)(
    'keeps the complete clinical-language matrix authoritative: %s',
    text => expect(classifyHighStakesEvidenceDomain(text)).toBe('medical'),
  );

  it.each(DIRECT_RBAC_MUTATION_CASES)(
    'keeps the complete RBAC-language matrix authoritative: %s',
    text => expect(classifyHighStakesEvidenceDomain(text)).toBe('security'),
  );

  it.each(NON_AUTHORITATIVE_SENSITIVE_LANGUAGE_CASES)(
    'keeps documentary, negated, narrated and interrogative language non-authoritative: %s',
    text => expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined(),
  );

  it.each([
    ['Corrige la sécurité.', 'security'],
    ['Corrige ces vulnérabilités.', 'security'],
    ['Corrige cette vulnérabilité.', 'security'],
    ['Corrige la conformité.', 'legal'],
    ['Corrige ces conformités.', 'legal'],
    ['Corrige les données de santé.', 'medical'],
    ['Corrige ces données médicales.', 'medical'],
    ['Corrige la fiscalité.', 'financial'],
    ['Corrige ces écritures comptables.', 'financial'],
    [`Corrige la ${'sécurité'.normalize('NFD')}.`, 'security'],
  ] as const)('recognizes Unicode-bounded French high-stakes wording: %s', (text, domain) => {
    expect(classifyHighStakesEvidenceDomain(text)).toBe(domain);
  });

  it.each([
    'Corrige le champ sécuritéInterne dans ce JSON.',
    'Corrige le champ niveauSécurité dans ce JSON.',
    'Corrige la propriété vulnérabilitéInterne dans ce JSON.',
    'Corrige le champ conformitéInterne dans ce JSON.',
    'Corrige la constante santéInterne dans ce JSON.',
    'Corrige la propriété fiscalitéInterne dans ce JSON.',
  ])('does not classify a high-stakes keyword embedded in an identifier: %s', text => {
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Corrige le contrat de complétion automatique de cet agent.',
    'Implement the API contract and validate its JSON output.',
    'Corrige le contrat API et le contrat de sortie JSON.',
    'Fix the completion contract and its validation receipt.',
    'Corrige les contrôles du contrat hôte et leurs reçus.',
    // Sanitized wording from the Batigest delegated review, not a legal document.
    'Revue indépendante finale, lecture seule. Périmètre courant : corriger l’usage de la session occupée de Julien en utilisant une autre session Windows, prouver le banc DEMO et préserver la production. Rejoue exactement les deux commandes Bash du contrat courant. Inspecte le rapport JSON et confirme en SSH le résultat du banc DEMO.',
  ])('does not classify a software contract as legal: %s', text => {
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Déploie Zero puis vérifie la révision, HTTPS, le login/dashboard et la santé.',
    'Vérifie la santé du service et du conteneur après le déploiement.',
    'Vérifie la santé du service après le déploiement.',
    "Vérifie la santé de l'application et l'état de santé du serveur.",
    'Vérifie la santé de l’application technique.',
    'Vérifie la santé du système informatique.',
    'Corrige la sonde de santé de cette API.',
    'Vérifie la santé du service, puis redémarre le conteneur.',
    'Vérifie la santé du service : elle doit être healthy.',
    'Vérifie la santé du service, le HTTPS puis le dashboard.',
    'Vérifie après changement la révision déployée, la santé, le HTML ou les endpoints d’authentification.',
    'Vérifie après changement la révision déployée, la santé, l’interface ou les endpoints d’authentification.',
    'Déploie le service puis vérifie la révision en exécution, l’accès HTTP et la santé opérationnelle.',
  ])('does not classify an application health check as medical: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it('keeps the exact live PNS E-Doc deployment objective outside the medical domain', () => {
    const text = 'Objectif exact autorisé par Thibault : intervenir sur le serveur `pns`, dépôt `/srv/pnsgen`, pour installer le correctif E-Doc où une réponse contenant `id` mais aucun `linkMail` doit être acceptée sans URL locale de substitution et sans second email Mailjet; une réponse sans `id` reste rejetée. Fichiers locaux finaux joints. Tu dois : 1) vérifier d’abord l’état réel et ne pas répéter une mutation déjà faite ; 2) sauvegarder les fichiers distants ; 3) installer les 2 sources et 2 tests aux chemins `server/services/unifiedEdocService.ts`, `server/workers/signatureWorker.ts`, et leurs `.test.ts`; 4) résoudre l’environnement de test (`vitest: not found`) par la voie normale du dépôt/conteneur, puis faire réussir exactement `npm test -- --run server/services/unifiedEdocService.test.ts server/workers/signatureWorker.test.ts`; 5) construire et déployer la révision selon le mécanisme existant avec rollback ; 6) vérifier la révision en exécution, l’accès HTTP et la santé opérationnelle ; 7) synchroniser vers le serveur `dev` et la branche Git du dépôt, puis vérifier les révisions; 8) NE JAMAIS appeler l’API d’envoi/signature E-Doc et NE JAMAIS réémettre le contrat 3602. Fournir un reçu précis avec commandes, codes de sortie, révisions et vérifications.';
    expect(isOperationalTechnicalContractLifecycleObjective(text)).toBeTrue();
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Vérifie la santé du patient avant le traitement.',
    "Vérifie l'état de santé du patient dans l'application.",
    'Corrige les données de santé exposées par cette API.',
    'Corrige cette application de santé.',
    'Déploie le portail public de santé puis vérifie son contenu.',
    'Vérifie la santé du système immunitaire.',
    'Vérifie l’état de santé du système de soins.',
    'Vérifie HTTPS puis la santé mentale.',
    'Corrige la santé de l’application clinique.',
    'Corrige la santé du système, notamment immunitaire.',
    'Corrige la santé de l’application : clinique.',
    'Corrige la santé du service, notamment immunitaire.',
    'Corrige la santé du service : clinique.',
    'Vérifie la santé mentale, le HTML du portail puis les endpoints.',
    'Vérifie la santé du patient, l’interface puis les endpoints.',
    'Vérifie l’application de santé, le HTML puis les endpoints.',
    'Vérifie la santé, l’interface de suivi clinique.',
    'Vérifie la santé, les interfaces de télémédecine.',
    'Vérifie la santé, l’interface hospitalière.',
    'Vérifie la santé, l’interface de l’hôpital.',
    'Vérifie la santé, l’interface thérapeutique.',
    'Vérifie la santé, l’interface de pharmacie.',
    'Check health and the hospital interface.',
    'Check health and the healthcare interface.',
    'Déploie le portail patient puis vérifie la révision en exécution, l’accès HTTP et la santé opérationnelle du patient.',
    'Déploie l’application de santé puis vérifie la révision en exécution, l’accès HTTP et sa santé opérationnelle.',
  ])('preserves medical evidence classification for human health: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('medical');
  });

  it.each([
    'On server dev at /srv/workspace/care, update the health application and verify that health records synchronize with the API and tests pass.',
    "Sur le serveur dev dans /srv/workspace/care, corrige l’application de santé et vérifie que les dossiers de santé sont synchronisés avec l’API et que les tests réussissent.",
  ])('keeps health products and records medical without requiring a patient noun: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('medical');
    expect(classifyHighStakesEvidenceDomain(text)).toBe('medical');
    expect(isConcreteOperationalSoftwareRestatement(text)).toBeFalse();
  });

  it.each([
    'On server dev at /srv/workspace/orion, fix the service then verify health, revision and tests.',
    'Sur le serveur dev dans /srv/workspace/orion, corrige le service puis vérifie que santé, révision et tests sont cohérents.',
  ])('keeps bounded operational health verification outside the medical domain: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Review the health of the company and its sales pipeline.',
    'Assess brand health.',
    'Review customer account health in CRM.',
    'Assess organizational health.',
    'Review project health.',
    'Check repository health and CI.',
    'Assess partnership health.',
    'Check service health.',
    'Check API health.',
  ])('does not promote ordinary business or software health to medical: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Applique le traitement prescrit au patient.',
    'Corrige le traitement médical prescrit.',
    "Update the patient's treatment plan.",
  ])('keeps clinically contextualized treatment in the medical domain: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('medical');
  });

  it.each([
    'Adapte le traitement du cancer.',
    "Évalue le traitement de l'infection.",
    'Adjust treatment for chronic pain.',
    'Quel traitement pour l’hypertension ?',
    'Adapte le traitement de la migraine.',
    'Prescris un traitement antibiotique.',
    'Réduis le dosage du traitement.',
    'What treatment is appropriate for diabetes?',
    'Commence un traitement médicamenteux pour l’asthme.',
    'Adjust the medication dosage in the treatment plan.',
    'Quel traitement pour la leucémie ?',
    'Adapte le traitement de l’insuffisance cardiaque.',
    'What treatment is appropriate for heart failure?',
    'Change the treatment for HIV.',
    'Adapte le traitement du VIH.',
    'Quel traitement pour la sclérose en plaques ?',
    'Quel traitement pour la bronchite ?',
    'Change the treatment for COPD.',
    'Adapte le traitement de la COVID-19.',
    'Quel traitement pour l’endométriose ?',
    'Adapte le traitement de l’obésité.',
    'Change the treatment for insomnia.',
    'Adapte le traitement de l’eczéma.',
    'Quel traitement pour la grossesse ?',
    'Le patient est atteint du VIH. Adapte le traitement.',
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
    'Prescribe antibiotics to the patient.',
    'Prescris des antibiotiques au patient.',
    'Prescribe insulin to the patient.',
    'Commence la chimiothérapie pour le patient.',
    'Start chemotherapy for the patient.',
    'Adapte la dialyse du patient.',
    'Adjust the patient’s dialysis.',
    'Reduce the insulin dose for the patient.',
  ])('recognizes unambiguously clinical treatment context: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('medical');
  });

  it.each([
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
  ])('classifies a direct clinical action as an authoritative medical mutation: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('medical');
    expect(classifyHighStakesEvidenceDomain(text)).toBe('medical');
  });

  it.each([
    'N’administre pas de morphine au patient.',
    'Do not inject insulin into the patient.',
    'Le rapport recommande d’administrer de la morphine au patient.',
    'The report recommends to perform an appendectomy.',
    'Faut-il injecter de l’insuline au patient ?',
    'Should we perform an appendectomy?',
  ])('keeps negated, reported and interrogative clinical actions non-mutating: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('medical');
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Lower the morphine dose.',
    'Lower the prednisone dose for the patient.',
    'Diminue la dose de morphine.',
    'Baisse la dose de morphine.',
    'Passe la dose de morphine à 5 mg.',
    'Administre du paracétamol.',
    'Infuse ceftriaxone.',
    'Infuse one gram of ceftriaxone into the patient.',
    'Perfuse de la ceftriaxone.',
    'Intube le patient.',
    'Perform an intubation.',
    'Effectue une transfusion.',
    'Perform a blood transfusion.',
    'Pose une perfusion.',
    'Set the metformin dose.',
    'Switch the patient to morphine.',
    'Stop warfarin.',
    'Hold insulin.',
    'Double the insulin dose.',
    'Halve the morphine dose.',
    'Put the patient on morphine.',
    'Mets le patient sous morphine.',
  ])('keeps the medical evidence contract aligned for direct mutations: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('medical');
    expect(classifyHighStakesEvidenceDomain(text)).toBe('medical');
  });

  it.each([
    'Do not lower the morphine dose.',
    'N’administre pas de paracétamol.',
    'Should we perform a blood transfusion?',
    'Faut-il intuber le patient ?',
    'The doctor administered paracetamol.',
    'The surgeon performed a blood transfusion.',
    'The doctor is administering ceftriaxone.',
    'Le médecin diminue la posologie de morphine.',
    'Le médecin administre du paracétamol.',
    'Le médecin intube le patient.',
    'Le chirurgien effectue une transfusion.',
    'Le médecin pose une perfusion.',
    'The protocol says to infuse ceftriaxone.',
    'The protocol requires the nurse to intubate the patient.',
    'La procédure exige d’intuber le patient.',
    'Le protocole recommande d’effectuer une transfusion.',
    'The report quotes “Infuse ceftriaxone.”',
    'Do not stop warfarin.',
    'Should we switch the patient to morphine?',
    'The doctor says to hold insulin.',
    'The report recommends doubling the insulin dose.',
    'The patient was put on morphine.',
    'Le médecin met le patient sous morphine.',
  ])('does not derive medical mutation authority from non-request prose: %s', text => {
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Make Alice an administrator.',
    'Nomme Alice administratrice.',
    'Promote Alice to administrator.',
    'Assign Alice the Administrator role.',
    'Attribue le rôle administrateur à Alice.',
    'Accorde le rôle d’administrateur à Alice.',
    'Accorde le rôle d’admin à Alice.',
    'Donne le rôle d’admin à Alice.',
    'Attribue le rôle d’admin à Alice.',
    'Donne à Alice le rôle d’admin.',
    'Set Alice as admin.',
    'Set Alice’s role to administrator.',
    'Change Alice’s role to admin.',
    'Add Alice to administrators.',
    'Ajoute Alice aux administrateurs.',
    'Supprime l’accès admin d’Alice.',
    'Passe Alice administratrice.',
    'Rends Alice administratrice.',
    'Add Alice to the SRE group.',
    'Mets Alice dans le groupe admins.',
    'Grant Alice read access.',
    'Donne à Alice un accès lecture.',
    'Revoke Bob write access.',
    'Accorde à Alice les privilèges sudo.',
    'Retire Alice du groupe des administrateurs.',
    'Retire Alice du groupe administrators.',
    'Retire à Alice son accès en écriture.',
    'Elevate Alice to superuser.',
    'Élève Alice au rang de superutilisateur.',
    'Élève Alice au rang de superutilisatrice.',
  ])('keeps the security evidence contract aligned for direct RBAC mutations: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('security');
    expect(classifyHighStakesEvidenceDomain(text)).toBe('security');
  });

  it.each([
    'Write a biography for an administrator.',
    'Name the administrator in the report.',
    'Add an administrator note to documentation.',
    'Make an administrator dashboard mockup.',
    'Remove administrator typo.',
    'Donne le rapport à l’administrateur.',
    'Nomme l’administrateur dans le rapport.',
    'The report says Alice was promoted to administrator.',
    'Alice was given administrator access yesterday.',
    'L’administrateur attribue à Alice le rôle administrateur.',
    'Le responsable met Alice dans le groupe SRE.',
    'Le responsable accorde à Alice un accès lecture.',
    'Le responsable donne à Alice des privilèges sudo.',
    'Le technicien donne à Alice les privilèges sudo.',
    'The policy says to grant Alice read access.',
    'La politique exige d’ajouter Alice au groupe SRE.',
    'The policy requires admins to add Alice to the SRE group.',
    'The procedure says to revoke Alice’s write access.',
    'The policy recommends assigning Alice the Administrator role.',
    'Should Alice be assigned the Administrator role?',
    'Alice should not be granted write access.',
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
  ])('does not derive RBAC mutation authority from prose, narration, policy or questions: %s', text => {
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it('keeps the deprecated three-argument gate fail-closed for a direct RBAC mutation', () => {
    expect(beginObjectiveEvidenceGate(
      's1', 'legacy-rbac-positive', 'Accorde le rôle d’administrateur à Alice.',
    )).toMatchObject({ objectiveId: 'legacy-rbac-positive', domain: 'security' });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
  });

  it('does not create a deprecated three-argument gate from a negated passive RBAC statement', () => {
    expect(beginObjectiveEvidenceGate(
      's1', 'legacy-rbac-negated', 'Alice should not be granted write access.',
    )).toBeUndefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });
});
