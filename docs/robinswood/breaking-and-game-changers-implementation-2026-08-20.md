# Ruptures et game changers — bilan d'implémentation des 20–21 août 2026

Ce document trace l'implémentation locale de l'audit « breaking changes et game changers » sur la baseline Robb Agents 0.12.3. Il distingue trois niveaux de preuve :

- **Vérifié localement** : code, contrats et tests automatisés exécutés sur l'arbre partagé.
- **Qualifié hors ligne** : comportement fournisseur représenté par des contrats et des mocks, sans tenant réel.
- **Gate externe** : validation qui exige une identité de signature, des secrets, un tenant ou plusieurs machines réelles.

## Ruptures techniques traitées

| Point | Implémentation | Niveau actuel |
| --- | --- | --- |
| MCP 2026-07-28 | SDK TypeScript v2 scindé, négociation automatique moderne/legacy sur HTTP et stdio, conformance Tasks dual-era, blocage de toute nouvelle configuration SSE. | Vérifié localement. Un test de caractérisation reproduit le défaut amont SDK v2 #2598 (`tasks/get` et `tasks/cancel` interceptés avant le handler) ; l'extension Tasks serveur reste derrière ce gate plutôt que de contourner les validations du SDK. |
| Electron, Node, Vite et TypeScript | `BrowserView` remplacé par `WebContentsView`; baseline Node 24.19, Electron 43.4, Vite 8.2 et compilateur TypeScript 7, avec voie API/compatibilité TypeScript 6. | Vérifié localement sur macOS arm64 et dans les builds de production. |
| Contrats fournisseurs privés | Façade centrale, versions exactes, kill switches, garde SSRF, fallbacks sûrs et canaris quotidiens redacted pour ChatGPT Codex, Copilot et Google Code Assist. | Contrats vérifiés localement; canaris réels soumis aux secrets et aux comptes fournisseurs. |
| Secrets des sous-processus | Blocklists remplacées par une allowlist minimale pour MCP, Pi et Vibe; aucune propagation implicite de variables cloud, CI, SSH ou credentials. | Vérifié par enfants réels et variables sentinelles. |
| Distribution Electron | Releases publiques fail-closed sur signature, ASAR avec intégrité et fuses, provenance de commit contrôlée, manifeste SHA-256 protégé couvrant les runtimes JavaScript externes, et canal `production` imposé par les wrappers Windows/Linux. | Paquet macOS arm64 réel vérifié et lancé; 407 fichiers externes scellés. Les contrats Windows/Linux, chemins NSIS et source integrity sont vérifiés localement, mais leurs assemblages natifs restent des gates CI. |
| Persistance | Enveloppes `schemaVersion` pour config globale, workspaces et sessions, migrations avec backups, validation Zod, écritures atomiques et refus d'écraser un schéma futur ou invalide. | Vérifié localement; sémantique `rename`/fsync à confirmer sur Windows réel. |

## Capacités implémentées et maturité

| Capacité | Résultat livré | Niveau actuel |
| --- | --- | --- |
| Mission OS / Control Room | Route Mission globale, portefeuille filtrable et paginé, coût/tokens, fraîcheur, risque, blocages, preuves, contrôles, liens profonds, inbox d'approbation, préflight hôte et replan avec aperçu du diff. | Vérifié par contrats de route, modèle UI, i18n, typecheck et build. Dernier benchmark local chaud sur 1 000 missions : p95 serveur 389,53 ms et modèle UI complet 8,36 ms; ce n'est pas un SLA end-to-end. |
| Proof-of-Outcome Passport | Résolution hôte des preuves à l'émission, hashes SHA-256, provenance, reçus de mutation, enveloppe Ed25519 vérifiable hors ligne et clé d'émetteur workspace pinée. L'ancre publique est exportable en SPKI base64url/PEM avec empreinte SHA-256, jamais avec la clé privée. | Vérifié localement, y compris altération, frontière de chemin et émetteur non fiable. Le vérificateur authentifie l'enveloppe par défaut; avec `--workspace-root`, il rouvre en confinement le journal canonique et toutes les preuves `workspace:///`, puis compare taille et hashes. Les preuves non-workspace restent explicitement comptées comme non revalidées. |
| Broker de mutations Mission | Invocation bornée, approbation durable liée au hash exact et à son expiration, WAL avant transport, idempotency recovery et stockage state/lock/receipt confiné contre traversal, symlinks et hardlinks. Une divergence produit un état durable `compensation-required`. | Vérifié par crash/restart, non-duplication et tests adversariaux de chemin. Electron et le serveur headless n'instancient volontairement aucun transport tenant générique : toute mutation externe reste fail-closed jusqu'à injection d'un adaptateur certifié avec secret resolver et réconciliation fournisseur. |
| Pack financier vertical | Variantes Microsoft 365 et Google Workspace, 13 work items et 3 mutations brokerées chacune, politiques capability/egress, mocks et validateur. | Qualifié hors ligne uniquement; aucun tenant réel n'a été muté. |
| Privacy receipt | Pare-feu d'egress structuré, minimisation, pseudonymisation HMAC, coffre injecté, canaris secrets et reçu signé de ce qui est libéré vers le transport. | Vérifié pour payloads connecteurs JSON structurés lorsque la factory hôte et ses sinks durables sont configurés; documents et prompts opaques hors périmètre. |
| Router outcome-aware | Store durable des outcomes, drift runtime, vérité terrain Mission, adaptateur eval, seuils statistiques et recommandations shadow sans mutation automatique de policy. | Analyse RPC et affichage consultatif dans les réglages vérifiés. Il n'existe ni producteur eval durable branché en production, ni promotion automatique; la décision reste humaine et hors du runtime. |
| Jumeau numérique Mission | Preflight sans mutation, résolution des contraintes côté hôte, replan versionné avec diff/invalidation transitive, préservation des résultats indépendants et recovery sans double dispatch. | RPC vérifiés sur 100 replans avec journaux tronqués et 100 recoveries; parcours renderer préflight + édition JSON + preview + confirmation implanté. Les adaptateurs coût/readiness réels restent à injecter. |
| Apprentissage organisationnel | Propositions sourcées par un passeport d'émetteur de confiance, secret scan, schémas stricts, chaîne signée, proposer/évaluateur/reviewer distincts, reviewer humain attesté, canary, rollback et révocation. | Fondation autonome vérifiée localement, sans RPC/UI ni auto-publication. L'ancienne API key-only n'est pas conservée. |
| Sovereign Team Mesh | Identités humaines/machines/agents, capacités attestées liées machine+hôte, file metadata-only, leases, fencing, heartbeat, failover et révocation. | Fondation autonome vérifiée en simulation locale; une machine sans capacité exacte ou superset est refusée. Control plane, IdP réel et essai deux hôtes restent des gates externes. |

## Frontières de sécurité transverses

- Les décisions et observations du jumeau numérique qui touchent policy, budget ou connecteurs sont toujours résolues côté hôte; le renderer ne peut pas les déclarer.
- Un dry-run ne construit ni exécuteur, ni credential lease, ni transport et ne crée aucun journal Mission.
- Les approbations de connecteur expirées ne sont jamais rejouées; la reprise d'une mutation déjà engagée passe d'abord par la réconciliation.
- Les passeports existants sont vérifiés contre la clé publique du workspace avant réutilisation ou apprentissage.
- La lecture et la vérification d'un passeport exigent une correspondance exacte avec le workspace et la Mission demandés; le renderer ignore tout résultat asynchrone d'une autre Mission, révision ou séquence.
- L'export RPC de l'ancre Passport exige `mission.read` et ne contient que la clé publique Ed25519, son encodage SPKI/PEM et l'empreinte SHA-256 calculée sur les octets DER/SPKI.
- La file souveraine exige une machine active, attestée, liée au même hôte que le lease et couvrant toutes les capacités requises. Cette identité et son attestation sont résolues à nouveau lors de chaque heartbeat, contrôle de fence et release; un heartbeat ne peut dépasser la durée de vie de l'attestation.
- Les journaux Mission et artefacts de preuve rejettent traversée, composants symlink/reparse et hardlinks; sur POSIX, lecture, troncature et écriture utilisent le même descripteur `O_NOFOLLOW` avec contrôle d'identité inode/device.
- Les états, locks et reçus du broker appliquent le même confinement et les reçus sont immuables (`O_EXCL`).
- Au démarrage packagé, les runtimes JavaScript hors ASAR sont vérifiés contre le manifeste protégé avant tout bootstrap agent; omission, traversée, doublon, taille ou hash divergent font échouer le démarrage.
- Une provenance Windows `verified-authenticode` n'est émise qu'après validation de la signature de l'exécutable unpacked et de l'installeur; le parcours NSIS la revalide encore sur l'exécutable installé.

## Gates de qualification externe

Le code et les contrats locaux peuvent entrer en qualification externe, mais les affirmations suivantes ne doivent pas être faites avant exécution des gates correspondants :

1. **Release publique certifiée** : signer/notariser un paquet macOS avec l'identité de production et vérifier Authenticode/SmartScreen sur Windows.
2. **Contrats fournisseurs stables** : exécuter les canaris avec comptes réels sans jamais journaliser les tokens.
3. **Pack financier certifié** : tester un tenant Microsoft et un tenant Google, révocation incluse, zéro mutation dupliquée sur 1 000 reprises, toutes les écritures approuvées/réconciliées et gain utilisateur supérieur à 50 %.
4. **Proof Passport certifié** : distribuer l'empreinte de l'ancre par un canal organisationnel fiable, puis démontrer 100 % de preuves obligatoires résolues et hashées, zéro faux PASS et zéro secret dans les exports sur le corpus de qualification.
5. **Performance Mission OS** : mesurer le p95 de la Control Room sur 1 000 missions, l'absence d'approbations orphelines et la part des opérations pilote réalisables sans ouvrir un chat.
6. **Privacy étendue** : sur les catégories définies, mesurer détection PII supérieure à 99 %, faux blocages inférieurs à 2 % et perte de qualité inférieure à 3 points; qualifier séparément documents et prompts non structurés.
7. **Router outcome-aware** : sur au moins 500 cas avec vérité terrain, obtenir -25 % de coût ou -20 % de latence avec une baisse de réussite au plus égale à 1 point et zéro violation de policy.
8. **Jumeau numérique** : détecter au moins 95 % des erreurs policy/budget avant lancement et maintenir le coût réel dans ±30 % au P80.
9. **Apprentissage vérifié** : sur tâches récurrentes, réduire de 30 % les tokens/interventions sans régression qualité/sécurité et sans secret publié.
10. **Mesh souverain distribué** : vérifier un IdP/SCIM réel, deux hôtes, failover inférieur à 60 s, révocation inférieure à 30 s et 1 000 bascules sans mutation dupliquée.

## Preuves locales principales

- Control Room et routes : `apps/electron/src/renderer/pages/__tests__/`, `apps/electron/src/shared/__tests__/route-parser-missions.test.ts`.
- Benchmark Control Room : `scripts/benchmark-mission-control.ts` (1 000 missions; hors IPC, React/DOM et contention de production).
- Passport, ancre publique et confinement des preuves : `packages/shared/src/missions/proof-passport.test.ts`, `packages/server-core/src/missions/MissionEvidenceResolver.test.ts`, `packages/server-core/src/missions/MissionProofPassportService.test.ts` et `scripts/tests/verify-proof-passport.test.ts`.
- Broker, reprise, consentement et confinement du WAL : `packages/server-core/src/missions/BrokeredMissionConnectorExecutor.test.ts`, `packages/server-core/src/services/connector-execution-runtime.test.ts`.
- Jumeau et replanning : `packages/shared/src/missions/digital-twin.test.ts`, `packages/server-core/src/missions/MissionDigitalTwinIntegration.test.ts`, `apps/electron/src/renderer/pages/__tests__/mission-digital-twin-panel.test.ts`.
- Privacy, router, learning et Mesh : tests homonymes sous `packages/shared/src/governance/` et `packages/shared/src/config/`.
- Pack financier : `examples/missions/operational-financial-reconciliation/qualification.test.ts` et `validate.ts`.
- Ruptures techniques : suites MCP sous `packages/shared/src/mcp/`, contrats release sous `scripts/tests/`, intégrité runtime dans `packages/shared/src/agent/backend/__tests__/runtime-integrity.test.ts` et tests de persistance sous `packages/shared/src/{config,workspaces,sessions}/`.

## Commandes de contrôle

```sh
bun install --frozen-lockfile
bun run validate:versions
bun run typecheck:all
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run lint:i18n:coverage
bun test
bun run electron:build
bun run viewer:build
git diff --check
```

## Résultats de la campagne finale

Campagne close le 21 août 2026 sur macOS arm64, Bun 1.3.14 :

- installation verrouillée et contrat de versions : verts, version workspace `0.12.3` sur 15 paquets;
- TypeScript natif 7 : 16/16 configurations vertes; matrice API TypeScript 6 : 16/16 verte;
- suite exhaustive après rebase sur `robinswood/main` : 5 864 tests réussis, 12 ignorés, 0 échec, 14 432 assertions, 5 876 tests dans 531 fichiers;
- `validate:ci` : vert, dont 48/48 contrats de release, audits de paquet, outils documentaires, installateurs et parité i18n (7 locales plus l'anglais, 2 072 clés chacune);
- builds Vite 8 Electron/WebUI/Viewer et main/preload/resources : verts; le build ressource scelle 407 fichiers runtime externes;
- preuve de packaging macOS arm64 réalisée plus tôt dans la même campagne : ASAR/fuses et 407 hashes validés, lancement isolé jusqu'à `App initialized successfully`, puis arrêt propre; coût médian de vérification 47,76 ms sur sept passages. Les derniers ajustements UI, Mesh et release ont été recompilés et retestés, mais ce paquet local antérieur n'est pas présenté comme un repackage de l'arbre final;
- benchmark Control Room chaud, 1 000 missions × 10 work items : p95 serveur 389,53 ms et modèle UI complet 8,36 ms, hors IPC/DOM/contention de production; workspace temporaire supprimé après la mesure;
- lint global : zéro erreur et 217 avertissements historiques non bloquants (Electron 119, shared 12, server-core 86, UI 0);
- `git diff --check`, contrôle des espaces finaux des fichiers non suivis et scan des marqueurs de conflit : verts après la campagne finale.

Windows/Linux n'ont pas été assemblés localement, les canaris fournisseurs n'ont pas été exécutés avec secrets réels, et aucun tenant, IdP ni essai distribué deux hôtes n'a été engagé. Ce bilan ne transforme aucun de ces gates externes en preuve de production.
