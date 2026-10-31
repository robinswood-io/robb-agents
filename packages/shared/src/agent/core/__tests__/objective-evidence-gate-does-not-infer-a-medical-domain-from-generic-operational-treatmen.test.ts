import { afterEach, describe, expect, it } from "bun:test";
import { beginObjectiveEvidenceGate as beginAuthorizedObjectiveEvidenceGate, classifyHighStakesEvidenceDomain, detectHighStakesEvidenceDomain, isConcreteOperationalSoftwareRestatement, isDirectLegalDocumentMutation, isOperationalTechnicalContractLifecycleObjective, checkObjectiveEvidenceBeforeMutation, clearObjectiveEvidenceGate, getObjectiveEvidenceCompletionGap, recordObjectiveEvidence } from "../objective-evidence-gate.ts";
import { beginObjectiveEvidenceGate } from "./testing/objective-evidence-gate-fixture.ts";

describe('high-stakes objective evidence gate', () => {
  afterEach(() => clearObjectiveEvidenceGate('s1'));

  it.each([
    "On a reçu la réponse d'ISAGRI par mail pour la mise en place de l'API qui doit remonter les données dans Sharepoint PLC, procède au traitement et l'implantation",
    'Lance le traitement des données puis implante le connecteur API.',
    'Implante le traitement de la réponse API.',
    'Relance le traitement du fichier importé.',
    'Corrige le traitement du lot en attente.',
    'Optimise le traitement batch et le pipeline.',
    'Calcule le dosage du lot puis corrige le traitement du fichier.',
    'Ordonne le traitement du lot en attente.',
    'Vérifie le traitement des eaux usées.',
    'Process the API response and implement the SharePoint connector.',
    'Fix the data treatment pipeline.',
    'Adjust the batch dose and fix the file treatment pipeline.',
    'Corrige le traitement de la commande et relance le job.',
    'Optimise le traitement du bois et des surfaces.',
    'Change the treatment of wastewater.',
    'Fix the treatment of the API request.',
    'Relance le traitement de la paie.',
    'Corrige le traitement de la configuration du connecteur.',
    'Corrige le traitement de la demande client.',
    'Implante le traitement des réclamations.',
    'Change the treatment of incoming API requests.',
    'Optimize the treatment of customer data.',
    'Fix the treatment of insurance claims.',
    'Optimize the treatment of sewage.',
    'Change the treatment of raw water.',
    'Adjust the treatment of steel.',
    'Optimize the treatment of timber.',
    'Corrige le traitement du courrier entrant.',
    'Implante le traitement des formulaires.',
    'Change the treatment of notifications.',
    'Modifie le traitement du stock.',
    'Optimise le traitement des candidatures.',
    'Corrige le traitement des leads.',
    'Améliore le traitement de la relation client.',
    'Automatise le traitement des CV.',
    'Optimise le traitement du langage naturel.',
    'Change the treatment of inventory.',
    'Improve the treatment of resumes.',
    'Optimize the treatment of customer relationships.',
    'Corrige le traitement des salaires.',
    'Prescris le traitement des candidatures.',
    'Prescribe the treatment of customer relationships.',
    'Réduis le dosage du traitement du lot batch.',
    'Adjust the pharmaceutical treatment of inventory.',
    'Adapte le traitement du syndrome de compilation.',
    'Le rapport mentionne le VIH. Prescris le traitement des candidatures.',
    'Heart failure is documented. Adjust the treatment of inventory.',
    'Adapte le traitement des données de chimiothérapie.',
    'Change the chemotherapy inventory treatment.',
    'Optimise le traitement des séances de physiothérapie dans le planning.',
  ])('does not infer a medical domain from generic operational treatment: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it('recognizes a fully restated concrete software recovery objective', () => {
    expect(isConcreteOperationalSoftwareRestatement(
      'Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge. Diagnostique puis corrige durablement le pont, démarre ou redémarre uniquement ce service si nécessaire, redéploie Orion seulement si l’état constaté l’exige, puis vérifie la santé, la révision et le test bun run test:orion-production.',
    )).toBeTrue();
  });

  it('keeps the live Orion maintenance restatement outside the medical domain', () => {
    const text = 'Le staging corrigé bb5f447 est actif. Cible uniquement le serveur dev, /srv/workspace/orion et le service orion-agent-bridge. Utilise exclusivement rbw-servers et ses outils SSH structurés. Diagnostique puis applique la correction durable avec sauvegarde et retour arrière ; démarre ou redémarre uniquement orion-agent-bridge si nécessaire, et redéploie Orion seulement si l’état constaté l’exige. Vérifie que GET /assistant-api/accounts retourne 200, que /parametres fonctionne, que santé et révision sont cohérentes, et que bun run test:orion-production réussit dans /srv/workspace/orion.';
    expect(isConcreteOperationalSoftwareRestatement(text)).toBeTrue();
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Poursuis et corrige.',
    'Le patient est atteint du VIH. Sur le serveur clinique /srv/workspace/care, adapte son traitement puis vérifie son état médical.',
    'Sur le serveur dev /srv/workspace/orion, corrige les permissions RBAC, réinitialise le token OAuth, redéploie le service et vérifie les tests.',
    'Sur /srv/workspace/orion se trouve le service orion-agent-bridge et sa configuration détaillée, mais ne modifie rien et contente-toi de résumer ce texte.',
  ])('rejects a terse, clinical, security-sensitive or non-operational restatement: %s', text => {
    expect(isConcreteOperationalSoftwareRestatement(text)).toBeFalse();
  });

  it.each([
    'Diagnostique et corrige le mapping e-doc du contrat PNS 3602 via API et SSH, puis réconcilie la file Failed et le statut signé dans la base.',
    'Fix the signed-contract synchronization incident in the e-doc worker and database, then verify the API callback and storage bucket.',
  ])('does not infer a legal deliverable from an operational contract lifecycle incident: %s', text => {
    expect(isOperationalTechnicalContractLifecycleObjective(text)).toBeTrue();
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it('does not reinterpret a duplicate-prevention prohibition as a legal mutation', () => {
    const text = 'Reprends la résolution e-doc PNS du contrat 3602 via rbw-servers et SSH structuré. Réconcilie les effets déjà produits ; le contrat est signé et aucune invitation, signature ou notification ne doit être réémise. Diagnostique puis corrige durablement le mapping dans la base et vérifie par API le PDF signé dans le bucket.';
    expect(isDirectLegalDocumentMutation(text)).toBeFalse();
    expect(isOperationalTechnicalContractLifecycleObjective(text)).toBeTrue();
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Aucune signature ne doit être réémise ; modifie le contrat juridique du client.',
    'No signature should be reissued; rewrite the customer contract.',
  ])('keeps a separate positive legal mutation protected after a prohibition: %s', text => {
    expect(isDirectLegalDocumentMutation(text)).toBeTrue();
    expect(detectHighStakesEvidenceDomain(text)).toBe('legal');
  });

  it.each([
    'On server pns /srv/pns, diagnose the API mapping. No blocker exists and the contract must be signed.',
    'Sur le serveur pns /srv/pns, diagnostique le mapping API. Aucun blocage n’existe et le contrat doit être signé.',
    'Sur le serveur pns /srv/pns, diagnostique le mapping API. Aucune anomalie n’est détectée et le contrat devra être approuvé.',
  ])('never lets an unrelated negative subject hide a later legal mutation: %s', text => {
    expect(isDirectLegalDocumentMutation(text)).toBeTrue();
    expect(detectHighStakesEvidenceDomain(text)).toBe('legal');
    expect(classifyHighStakesEvidenceDomain(text)).toBe('legal');
  });

  it.each([
    'No invitation, signature, or notification should be reissued.',
    'Aucun nouveau message ou document ne doit être renvoyé.',
  ])('neutralizes only a closed negated effect subject: %s', text => {
    expect(isDirectLegalDocumentMutation(text)).toBeFalse();
  });

  it.each([
    'Write the document via API and inspect its generated identifier.',
    'Archive the document via API and verify its storage record.',
    'Crée le document via API puis vérifie son identifiant.',
    'Modifie le contrat API.',
    'Modify the API contract.',
    'Le contrat API doit être supprimé après le test.',
    'The API contract must be deleted after the test.',
    'Le document doit être supprimé après le test.',
    'The document must be deleted after the test.',
    'Write a contract test.',
    'Execute the contract test.',
    'Archive the contract test results.',
    'Deploy the contract to Ethereum.',
    'Mets à jour le contrat OpenAPI.',
    'Modifier le contrat de service API.',
    'Deploy the smart contract to Ethereum.',
    'Write a smart contract.',
    'Update the Solidity contract.',
    'Compile the Solidity contract.',
    'Archive the smart contract test results.',
    'Delete the contract schema.',
    'Update the contract fixture.',
    'Modify the contract interface.',
    'Rewrite the contract definition.',
    'Generate the contract ABI.',
    'Delete the contract mock.',
    'Delete the contract record.',
    'Delete the contract row.',
  ])('keeps generic documents and software contracts outside legal risk: %s', text => {
    expect(isDirectLegalDocumentMutation(text)).toBeFalse();
    expect(detectHighStakesEvidenceDomain(text)).toBeUndefined();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'How do I delete the contract?',
    'How can you delete the contract?',
    'How to delete the contract?',
    'Please explain how to delete the contract.',
    'Analyze whether to delete the contract.',
    'Please analyze whether to delete the contract.',
    'Analyze how to delete the contract.',
    'Please review how to delete the contract.',
    'Analyse comment supprimer le contrat.',
    'Merci d’analyser comment supprimer le contrat.',
    'Explique comment supprimer le contrat.',
    'Évalue s’il faut supprimer le contrat.',
    'Comment supprimer le contrat ?',
    'Comment puis-je supprimer le contrat ?',
    'Dois-je supprimer le contrat ?',
    'Est-ce que je dois supprimer le contrat ?',
    'Do not analyze how to delete the contract.',
    'N’analyse pas comment supprimer le contrat.',
  ])('keeps informational legal questions outside mutation authority: %s', text => {
    expect(isDirectLegalDocumentMutation(text)).toBeFalse();
    expect(classifyHighStakesEvidenceDomain(text)).toBeUndefined();
  });

  it.each([
    'Corrige la clause de responsabilité du contrat signé exposé par cette API.',
    'Rédige le contrat juridique du service e-doc puis vérifie son stockage.',
    'Draft the legal terms for the signed API contract and inspect the service.',
    'Signe le contrat via API puis vérifie son statut dans la base.',
    'Approuve le contrat via API puis corrige le statut dans la base.',
    'Modifie le contrat signé via API et vérifie le statut dans la base.',
    'Approve the contract via API, then inspect its status in the database.',
    'Supprime le contrat via API puis vérifie son statut dans la base.',
    'Crée le contrat via API puis vérifie son statut dans la base.',
    'Publie le contrat via API puis vérifie son statut dans la base.',
    'Réécris le contrat via API puis vérifie son statut dans la base.',
    'Delete the contract via API, then inspect its status in the database.',
    'Rewrite the contract via API, then inspect its status in the database.',
    'Submit the contract via API, then inspect its status in the database.',
    'Envoie le contrat via API puis inspecte son statut dans la base.',
    'Téléverse le contrat via API puis inspecte son statut dans la base.',
    'Transfère le contrat via API puis inspecte son statut dans la base.',
    'Résilie le contrat via API puis inspecte son statut dans la base.',
    'Accepte le contrat via API puis inspecte son statut dans la base.',
    'Contresigne le contrat via API puis inspecte son statut dans la base.',
    'Archive le contrat via API puis inspecte son statut dans la base.',
    'Génère le contrat via API puis inspecte son statut dans la base.',
    'Send the contract through the API, then inspect its database status.',
    'Upload the contract through the API, then inspect its database status.',
    'Accept the contract through the API, then inspect its database status.',
    'Terminate the contract through the API, then inspect its database status.',
    'Renew the contract through the API, then inspect its database status.',
    'Archive the contract through the API, then inspect its database status.',
    'Countersign the contract through the API, then inspect its database status.',
    'Generate the contract through the API, then inspect its database status.',
    'Execute the contract through the API, then inspect its database status.',
    'Signe le document via API puis vérifie son identifiant.',
    'Approve the legal document through the API, then inspect its status.',
    'Le contrat PNS 3602 doit être supprimé via API, puis diagnostique son statut dans la base.',
    'The PNS contract must be deleted via API, then inspect its database status.',
    'Dans le contrat PNS 3602, modifie la clause puis vérifie le statut via API.',
    'Le document juridique PNS doit être supprimé via API, puis diagnostique son statut.',
    'The legal document must be deleted via API, then inspect its status.',
    'Le document doit être signé via API avant la vérification.',
    'Delete all contracts.',
    'Delete customer contracts.',
    'Please delete our agreement.',
    'Please rewrite our agreement.',
    'Supprime nos contrats.',
    'The contract — delete it.',
    'Delete it from the contract.',
    'Delete all of our contracts.',
    'Delete both customer contracts.',
    'Delete the employment contract.',
    'Delete Alice’s contract.',
    'Sign all of our contracts.',
    'Amend the contract.',
    'Cancel the contract.',
    'Void the contract.',
    'Annule le contrat.',
    'Peux-tu supprimer le contrat ?',
    'Est-ce que tu peux supprimer le contrat ?',
  ])('keeps a real legal deliverable gated despite adjacent technical vocabulary: %s', text => {
    expect(isOperationalTechnicalContractLifecycleObjective(text)).toBeFalse();
    expect(classifyHighStakesEvidenceDomain(text)).toBe('legal');
  });

  it.each([
    'Corrige ce contrat juridique.',
    'Rédige un contrat de prestation pour le client.',
    'Modify the current contract with the customer.',
    'Corrige le contrat API et rédige le NDA du fournisseur.',
    'Corrige le contrat de complétion et la clause de responsabilité du contrat juridique.',
    'Draft a legal agreement for an API service.',
    'Corrige le contrat courant.',
    'Corrige la conformité juridique des commandes Bash du contrat courant.',
  ])('retains the legal gate when a legal task is present: %s', text => {
    expect(classifyHighStakesEvidenceDomain(text)).toBe('legal');
  });

  it('retains another high-stakes domain alongside a technical contract', () => {
    expect(classifyHighStakesEvidenceDomain('Corrige les vulnérabilités de sécurité et le contrat API.')).toBe('security');
    expect(classifyHighStakesEvidenceDomain('Corrige le calcul fiscal et le contrat de complétion.')).toBe('financial');
  });

  it('does not activate from negated mutation words without high-stakes contract authority', () => {
    const text = 'Analyse la sécurité du déploiement en lecture seule. Ne pas modifier les fichiers ni déployer.';
    expect(classifyHighStakesEvidenceDomain(text)).toBe('security');
    expect(beginAuthorizedObjectiveEvidenceGate('s1', 'u1', text, { risk: 'standard' })).toBeUndefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it.each([
    'Fix the security vulnerability.',
    'Rotate the security credentials.',
    'Configure the RBAC permissions.',
  ])('detects the evidence subject independently from host mutation vocabulary: %s', text => {
    expect(detectHighStakesEvidenceDomain(text)).toBe('security');
  });

  it('does not create an impossible source gate when no applicable domain is available', () => {
    expect(beginAuthorizedObjectiveEvidenceGate(
      's1', 'unknown-domain', 'Apply the high-risk operation.', {
        risk: 'high-stakes', evidenceRequirement: 'authoritative-sources-before-mutation',
      },
    )).toBeUndefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it('keeps the gate for an authorized high-stakes mutation contract', () => {
    expect(beginAuthorizedObjectiveEvidenceGate(
      's1',
      'u1',
      'Corrige ce contrat juridique.',
      { risk: 'high-stakes', evidenceRequirement: 'authoritative-sources-before-mutation', domain: 'legal' },
    )).toMatchObject({ objectiveId: 'u1', domain: 'legal' });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
  });

  it('ignores a stale evidence requirement on a standard-risk contract', () => {
    expect(beginAuthorizedObjectiveEvidenceGate(
      's1',
      'u1',
      'Corrige cette écriture comptable.',
      { risk: 'standard', evidenceRequirement: 'authoritative-sources-before-mutation', domain: 'financial' },
    )).toBeUndefined();
  });

  it('resets evidence when the persisted objective keeps its id but changes high-stakes domain', () => {
    beginAuthorizedObjectiveEvidenceGate(
      's1', 'u1', 'Corrige ce contrat juridique.', {
        risk: 'high-stakes', evidenceRequirement: 'authoritative-sources-before-mutation', domain: 'legal',
      },
    );
    recordObjectiveEvidence(
      's1',
      'WebFetch',
      'Source juridique officielle consultée sur https://legifrance.gouv.fr avec le texte applicable.',
      false,
    );
    recordObjectiveEvidence('s1', 'mcp__session__call_llm', JSON.stringify({
      verdict: 'PASS', criteria: [{ id: 'requested-outcome-delivered', passed: true }], findings: [],
    }), false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();

    expect(beginAuthorizedObjectiveEvidenceGate(
      's1',
      'u1',
      'Corrige ce contrat juridique.\nCorrige maintenant les permissions de sécurité.',
      { risk: 'high-stakes', evidenceRequirement: 'authoritative-sources-before-mutation', domain: 'security' },
    )).toMatchObject({
      objectiveId: 'u1',
      domain: 'security',
      evidenceObserved: false,
      authoritativeEvidenceObserved: false,
      independentReviewObserved: false,
    });
    expect(getObjectiveEvidenceCompletionGap('s1')).toBe('authoritative evidence has not been inspected');
  });

  it('keeps the legacy three-argument call conservatively compatible', () => {
    expect(beginAuthorizedObjectiveEvidenceGate(
      's1', 'legacy-high-stakes', 'Corrige ce contrat juridique.',
    )).toMatchObject({ objectiveId: 'legacy-high-stakes', domain: 'legal' });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);

    expect(beginAuthorizedObjectiveEvidenceGate(
      's1', 'legacy-standard', 'Explique simplement ce terme.',
    )).toBeUndefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it('rejects prose claiming authority, bare institution names and lookalike URL hosts', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    for (const result of [
      'Source officielle, texte en vigueur, source primaire : ce texte ne contient aucune provenance.',
      'Le site Legifrance ou EUR-Lex est mentionné sans preuve de consultation.',
      'A local note merely cites https://eur-lex.europa.eu/legal-content/FR/TXT without fetching it.',
      'Source primaire https://legifrance.gouv.fr.attacker.example/document official',
      'Source primaire https://attacker.example/path?source=legifrance.gouv.fr official',
      'Source primaire https://legifrance.gouv.fr@attacker.example/document official',
      'Source primaire https://attacker.example/https://sec.gov/document official',
    ]) {
      recordObjectiveEvidence('s1', 'Read', result, false);
      expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
      expect(checkObjectiveEvidenceBeforeMutation('s1', 'Read', 'read').allowed).toBe(true);
    }
    recordObjectiveEvidence('s1', 'web_fetch', 'Applicable official article https://eur-lex.europa.eu/legal-content/FR/TXT', false);
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it('requires a first-party connector identity instead of accounting words in arbitrary output', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige cette écriture comptable.');
    recordObjectiveEvidence('s1', 'Read', 'Grand livre, journal comptable et balance comptable : simple exemple sans connexion à une source.', false);
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
    recordObjectiveEvidence('s1', 'mcp__inqom__get_ledger', 'Observed ledger entries for the exact accounting period and dossier.', false);
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it('binds official-source credit to the actual fetched URL when host inputs are available', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    const result = 'Quoted official article https://eur-lex.europa.eu/legal-content/FR/TXT';
    for (const [toolName, input] of [
      ['Read', { file_path: '/tmp/unverified-notes' }],
      ['web_fetch', { url: 'https://attacker.example/article' }],
      ['web_search', { query: 'https://eur-lex.europa.eu/legal-content/FR/TXT' }],
      ['browser_tool', { command: 'evaluate "https://eur-lex.europa.eu"' }],
    ] as const) {
      recordObjectiveEvidence('s1', toolName, result, false, undefined, input);
      expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
    }
    recordObjectiveEvidence('s1', 'web_fetch', 'Actual article content returned by the successful request, with no URL repeated in its text.', false,
      undefined, { url: 'https://eur-lex.europa.eu/legal-content/FR/TXT' });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it.each([
    ['Corrige l’intégration de signature Cerfrance.', 'https://cneidf.cerfranceconnect.fr/documentation/signature'],
    ['Corrige le connecteur juridique Silae.', 'https://silae-api.document360.io/docs/authentication'],
    ['Corrige le connecteur juridique Silae.', 'https://www.silae.fr/solutions/api'],
  ])('accepts an exact objective-bound first-party business documentation host: %s -> %s', (objective, url) => {
    beginObjectiveEvidenceGate('s1', 'u1', objective);
    recordObjectiveEvidence('s1', 'WebFetch', 'Current vendor documentation was fetched from the exact requested source.', false,
      undefined, { url });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it.each([
    ['Corrige ce NDA fournisseur.', 'https://www.silae.fr/solutions/api'],
    ['Corrige le connecteur juridique Silae.', 'https://www.silae.fr/'],
    ['Corrige le connecteur juridique Silae.', 'https://silae-api.document360.io/'],
    ['Corrige l’intégration de signature Cerfrance.', 'https://cneidf.cerfranceconnect.fr/'],
  ])('rejects unrelated vendor scope or an unbounded vendor path: %s -> %s', (objective, url) => {
    beginObjectiveEvidenceGate('s1', 'u1', objective);
    recordObjectiveEvidence('s1', 'WebFetch', 'Current vendor page content from the requested source.', false,
      undefined, { url });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
  });

  it.each([
    'https://cneidf.cerfranceconnect.fr.attacker.example/documentation',
    'https://other.document360.io/docs/authentication',
    'https://silae.fr.attacker.example/solutions/api',
  ])('rejects a business documentation lookalike: %s', url => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige les intégrations juridiques Silae et Cerfrance.');
    recordObjectiveEvidence('s1', 'WebFetch', 'Untrusted documentation content returned by a lookalike target.', false,
      undefined, { url });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
  });
});
