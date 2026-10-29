# Revue des exigences de la release 0.12.11 — 28 octobre 2026

Cette revue lie les exigences aux versions et moyens de preuve. Elle ne déclare
ni le gate global réussi, ni l'application installée, ni les installateurs disponibles.
Les résultats exécutés restent dans les reçus du contrôleur sur le checkout exact.
Une ligne reviewed indique une revue des exigences ; aucun résultat futur n'est inventé.

Le 29 octobre, le run 40873520149 échoue sur neuf tests shared et l’audit dépendances,
avec typage, lint, environnement et politique TypeScript réussis. Le diagnostic Linux
temporaire conserve les sorties complètes de quatre fichiers de tests synthétiques et
du script public de dépendances, dans un profil QA isolé. Aucun rapport canonique privé
n’est publié ; le code de sortie est conservé et aucun contrôle obligatoire n’est retiré.
Le diagnostic 40877157371 confirme le parseur PowerShell non initialisé dans les tests
et une écriture admise après remplacement d’un répertoire. Les fixtures initialisent
le vrai parseur ; les références Git HEAD@{0} restent classées Bash. L’identité des
répertoires ajoute leur date de création nanoseconde aux device/inode pour détecter
leur réutilisation ; les anciens instantanés restent compatibles. Les types seuls
sont extraits pour garder shared.ts sous 500 lignes. Les 24 tests ciblés passent ;
la qualification Linux réelle et le gate global restent obligatoires.
Le premier diagnostic dépendances n’avait pas initialisé RTK : il réutilise désormais
le bootstrap vérifié existant et exclut le checkout privé avant l’inventaire public.
Le run 40878294709 valide la reprise physique et le parseur, mais révèle trois fixtures
de chemins Windows utilisées sur Linux et six entrées obsolètes (cinq paquets).
Les tests emploient désormais les chemins natifs ; le cas de casse Windows vérifie
aussi le refus sur les autres hôtes, sans skip ajouté. Versions registre vérifiées :
lucide-react 1.64.0, react-resizable-panels 4.15.1, @rolldown/plugin-babel 0.3.0,
qs 6.17.1 et jose 6.2.14. Le patch Babel 8 existant est porté sur le nouveau fichier
de déclarations upstream, archive officielle vérifiée par son intégrité npm.
Le lockfile Bun 1.4.4 est régénéré sans installation globale ni exécution de scripts ;
audit sécurité du lock : zéro entrée, code 0. Arbre installé, types et build restent
à qualifier sur CI. Les deux exceptions humaines restent strictement inchangées.
Le diagnostic préalable lance désormais la commande de tests complète du projet,
avec sortie conservée, pour détecter les erreurs Linux restantes avant les contrôles
de typage coûteux. Le gate canonique reste inchangé et obligatoire sur le commit exact.
Le run 40879890233 confirme zéro anomalie sur les 278 entrées de dépendances et
zéro échec dans tous les groupes ordinaires, dont les 5 386 tests shared. Le test
Electron isolé du diagnostic nécessite le même xvfb-run que le gate ; il est rétabli,
sans ignorer le test. Les versions stables des runtimes sont vérifiées directement :
https://nodejs.org/en/download/current (26.13.0) et https://www.python.org/downloads/
(3.15.2), le 29 octobre. Contrat, vérification runtime et CI sont alignés ; le vieux
.node-version 24.19.0 est également corrigé. Aucun runtime système du Mac n’est remplacé.
Le run 40880912320 expose encore deux fixtures PowerShell dont le répertoire autorisé
n’existe pas. Le contrôle de chemin refuse correctement un ancêtre hors de cette racine.
Les tests créent maintenant un vrai répertoire temporaire, le suppriment en afterAll,
et testent la casse sur cette même racine. Aucune règle de confinement n’est assouplie.
Le run 40882333697 valide ces fixtures et les dépendances. Le test Electron échoue
encore avec Xvfb : la cause n’est donc pas établie par l’affichage seul. Son assertion
contrôle maintenant code de sortie, présence du reçu et stderr avant de lire le JSON.
Le diagnostic préalable cible ce seul obstacle ; le gate conserve la suite complète.
Les quatre pins Python du workflow Robinswood Validate sont aussi alignés sur 3.15.2.
Le diagnostic ciblé doit préfixer le fichier .isolated.ts par ./ pour que Bun le lance
comme chemin ; l’absence de test correspondant est restée un échec, jamais une réussite.
Le scanner de la validation OSS signale dix lignes SHA-256 dans six preuves historiques,
pas des identifiants. La configuration reconnaît uniquement huit lignes/valeurs exactes,
dans ces six chemins et pour generic-api-key. Scan réel du dépôt : dix puis zéro alerte.
Deux contrôles négatifs restent rouges : valeur différente au même emplacement, ou
ligne connue hors des preuves autorisées. Résultats versionnés dans
docs/robinswood/evidence/release-0.12.11/secret-scan-digest-proof.json.

## Périmètre, garanties et preuves

- Environnement, mandat et prévol : ENVIRONMENT.md et AGENTS.md. Cible locale imposée,
  worktree isolé, intégration sérialisée, sauvegarde restaurable et variante privée conservée.
- 48 v2.3.0 relue : reprise des résultats existants, corrections des échecs puis contrôles globaux.
  Lint/TS interrompus restent non validés ; aucun arrêt assimilé à une réussite.
- Qualité 00/50 : contrôle AST, options résolues, couverture de tous les TS, lint typé,
  compilation native sur 17 configurations, inventaire physique et exceptions exactes.
  Source-quality vérifie aussi le Python ; zéro désactivation de vérification ajoutée.
- Dernier global du 28 octobre à 18:45 UTC : 11009 réussites Bun, 12 skips, zéro échec ;
  183 tests Python (un skip) et 21 tests documentaires réussis. Compilation native et lint
  globaux réussis. Les skips restent explicites et ne sont pas comptés comme exécutés.
  Depuis : @types/node 26.6.6 et AWS client-s3 3.1159.0, lock et sous-processus reconstruits ;
  nouveau gate complet obligatoire sur les sources finales stagées.
- Dépendances : audit des registres configurés, versions installées, lock hors plateforme,
  PEP723 et binaires. Deux exceptions humaines exactes ; aucune exclusion du code maintenu.
  sprintf-js : stable upstream 1.1.3 plus correctif DoS existant, source installée vérifiée,
  provenance/licence/patch dans scripts/vendor/sprintf-js et régressions security-hardening.
- UI : docs/robinswood/evidence/release-0.12.11/ui-components.json contient quatre scénarios
  Chromium réels avec empreintes des composants ; API simulées explicitement identifiées.
  Cela ne prouve pas le parcours de l'Electron installé. Ce dernier reste une étape distincte.
- Missions : sept scénarios réels précédents réussis via la connexion habituelle autorisée,
  dont modification en cours, activation de source et compaction SDK. Nouveau passage : sept sur sept
  le 28 octobre à 18:18Z ; docs/robinswood/evidence/release-0.12.11/autonomy-final.json contient les assertions et hashes des bundles.
  QA uniquement, pas de données réelles mutées.
- Sécurité : frontières IPC et noms d'outils contrôlés par lint existant ; contrats permissions,
  fichiers, persistance, reconnexion et sorties structurées couverts par la suite du projet.
  Ni succès de wrapper ni texte du modèle ne suffisent à clôturer une mission.
- Modèles/continuation : modèle configuré conservé ; aucune nouvelle orchestration/délégation,
  aucun quota fournisseur, aucune tâche récurrente créée pour cette release.
- Thème/observabilité : pile desktop existante préservée suivant 48 et le contrat projet ;
  tokens, séparation d'effets et erreurs visibles maintenus. Les recettes NestJS/Next/Tailwind
  ne créent pas une migration de pile. La preuve UI est limitée aux scénarios réellement exécutés.
- CI : source immutable, contrôleur privé épinglé, clé read-only autorisée, credentials non persistés,
  événements de release de confiance, concurrence sérialisée, timeouts et rétention des artefacts.
  Le prévol signature et la publication restent fail-closed. Les règles privées ne sont pas copiées.
- Ressources : nettoyage limité aux outputs générés de cette tâche ; autres processus/profils préservés.
- Ressources app et core/shared : source de vérité resources, registry i18n, tokens, contrats de types,
  erreurs et compatibilité des fournisseurs vérifiés par les contrôles existants et les tests de release.
  Les notes suivent resources/release-notes/next.md jusqu'à la préparation de release.
- Les profils spécialisés non invoqués et les technologies absentes sont motivés ci-dessous.
  Leurs protections communes restent couvertes par les règles transversales et le contrat desktop.

Les exceptions sont refusées lorsque la version change ; trois tests sans réseau vérifient
ce périmètre, le refus d’une version non approuvée et l’intégrité de la copie installée.
Les tests unitaires utilisent un profil temporaire par défaut ; la CI Linux prépare Xvfb.
Le contrôle canonique à 4 Gio a épuisé son heap après les cinq autres contrôles verts ;
la limite bornée à 8 Gio ne retire aucun diagnostic et doit encore être validée sur Robb.

## Couverture versionnée

Les hashes exacts sont dans quality-policy.json et revalidés par le contrôleur.

| Source | État | Motif ou preuve |
|---|---|---|
| bmad/ARTIFACTS.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| bmad/PROCESS.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| bmad/PROJECT-POLICY.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-agents/rules/01-rules/00-agents-global.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-agents/rules/01-rules/01-api-security-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/02-browser-tester.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/03-bug-hunter.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/04-code-explorer.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/05-config-validator.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/06-construction-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/07-data-analyzer.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/08-database-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/09-dependency-scanner.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/10-deployment-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/11-doc-writer.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/12-docker-compose-dev-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/13-docker-specialist.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/14-document-generator.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/15-financial-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/16-frontend-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/17-game-master.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/18-gdpr-compliance-auditor.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/19-git-helper.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/20-github-automation.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/21-infrastructure-guardian.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/22-integration-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/23-knowledge-enricher.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/24-migration-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/25-nextjs-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/26-nginx-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/27-observability-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/28-quick-reviewer.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/29-secrets-guardian.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/30-security-auditor.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/31-task-orchestrator.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/32-test-generator.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/33-troubleshooter.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/34-typescript-debugger.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/35-typescript-expert.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/36-whatsapp-automation.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-agents/rules/01-rules/50-verdaccio-packages.md | not_applicable | Profil spécialisé non invoqué ; aucun agent délégué. Les garanties transversales restent couvertes par les règles 48/50 et les contrôles Robb. |
| packs/robinswood-core/rules/01-rules/00-auto-continuation.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/00-environment-context.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/00-frontmatter-schema.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/00-glossaire-environnements.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/00-style-guide.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/00-typescript-any-interdiction.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/00-ui-verification-obligatoire.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/01-core.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/01-flowdev-context.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/02-anti-complaisance.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/02-docker-central-orchestration.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/03-verification.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/04-browser-testing.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/05-git-workflow.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/07-workspace-projects.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/08-bun-standardization.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/09-stack-standard.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/10-frontend-backend-urls.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/11-packages-maison.md | not_applicable | Pas de package privé @robinswood publié ou migré ; registres effectifs audités, workspaces Craft existants préservés. |
| packs/robinswood-core/rules/01-rules/12-validation-layers.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/13-package-deprecation.md | not_applicable | Aucune dépréciation ou suppression de package publié ; seules dépendances de ce checkout migrées et vérifiées. |
| packs/robinswood-core/rules/01-rules/14-model-selection-strategy.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/15-resource-management-limits.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/16-codex-smart-routing.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/17-multi-llm-limitations.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/18-mcp-playwright-usage.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/19-haiku-enforcement.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/20-health-readiness-standards.md | not_applicable | Recette endpoints NestJS absente de cette application Electron/Bun ; runtime local vérifié par son contrat spécifique. |
| packs/robinswood-core/rules/01-rules/21-llm-local-background-tasks.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/22-docker-healthcheck-patterns.md | not_applicable | Pas de conteneur ou healthcheck Docker dans la cible de cette livraison Mac. |
| packs/robinswood-core/rules/01-rules/23-deployment-gating.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/24-reverse-proxy-resilience.md | not_applicable | Aucun reverse proxy Nginx ou infrastructure réseau modifié. |
| packs/robinswood-core/rules/01-rules/25-observability-standards.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/26-error-prevention-rules.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/27-claude-run-protocol.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/28-playwright-skill-only.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/29-design-system-theming.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/30-github-actions-optimization.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/31-instruction-validation.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/32-auto-commit-on-task-complete.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/33-night-agent-integration.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/34-qa-automation-process.md | not_applicable | Aucun QA Watchdog Night Agent installé ou invoqué ; tests directs et missions réelles du projet. |
| packs/robinswood-core/rules/01-rules/35-story-templates.md | not_applicable | Pas de story Night Agent ni génération de CRUD métier ; périmètre code et release Robb existants. |
| packs/robinswood-core/rules/01-rules/36-schema-migration-strategy.md | not_applicable | Pas de migration Drizzle/PostgreSQL ni écriture comptable. Contrats de persistance fichier couverts par tests Robb. |
| packs/robinswood-core/rules/01-rules/37-incident-response-protocol.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/38-implicit-development.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/39-changelog-auto-versioning.md | not_applicable | Aucun Night Agent ou workflow auto-versioning ; release 0.12.11 explicite et notes selon contrat ressources Robb. |
| packs/robinswood-core/rules/01-rules/40-deployment-migration-enforcement.md | not_applicable | Pas de migration de base distante ou de déploiement de service serveur partagé ; staging Mac selon AGENTS.md. |
| packs/robinswood-core/rules/01-rules/41-stack-migration-protocol.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/42-model-selection-migrations.md | not_applicable | Aucun changement de modèle imposé ; OAuth et modèle habituel explicitement autorisés pour QA. |
| packs/robinswood-core/rules/01-rules/43-rtk-token-optimization.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/44-craft-agent-behavior-continuous-improvement.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/45-remote-agent-worktrees.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/47-no-time-billing.md | not_applicable | Aucune facturation, tarification ou engagement commercial. |
| packs/robinswood-core/rules/01-rules/48-governance-contract.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/49-francophone-campaigns-salutation.md | not_applicable | Aucune campagne ou message externe. |
| packs/robinswood-core/rules/01-rules/50-quality-contract.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/CLARIFICATION-DEV-PROD-2026-02-01.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-core/rules/01-rules/HAIKU-QUICKSTART.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-docker/rules/01-rules/01-docker-dev.md | not_applicable | Application desktop locale explicitement désignée par Thibault ; aucun runtime Orion, Docker, Nginx, serveur ou base métier de ces recettes modifié. |
| packs/robinswood-docker/rules/01-rules/02-ports.md | not_applicable | Application desktop locale explicitement désignée par Thibault ; aucun runtime Orion, Docker, Nginx, serveur ou base métier de ces recettes modifié. |
| packs/robinswood-infrastructure/rules/01-rules/01-nginx.md | not_applicable | Application desktop locale explicitement désignée par Thibault ; aucun runtime Orion, Docker, Nginx, serveur ou base métier de ces recettes modifié. |
| packs/robinswood-infrastructure/rules/01-rules/02-plans.md | not_applicable | Application desktop locale explicitement désignée par Thibault ; aucun runtime Orion, Docker, Nginx, serveur ou base métier de ces recettes modifié. |
| packs/robinswood-infrastructure/rules/01-rules/03-database.md | not_applicable | Application desktop locale explicitement désignée par Thibault ; aucun runtime Orion, Docker, Nginx, serveur ou base métier de ces recettes modifié. |
| packs/robinswood-infrastructure/rules/01-rules/04-secrets.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| packs/robinswood-projects/rules/01-rules/01-projects-registry.md | not_applicable | Application desktop locale explicitement désignée par Thibault ; aucun runtime Orion, Docker, Nginx, serveur ou base métier de ces recettes modifié. |
| packs/robinswood-typescript/rules/01-rules/01-typescript.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| project:AGENTS.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| project:apps/electron/resources/AGENTS.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| project:packages/core/CLAUDE.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| project:packages/shared/CLAUDE.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| project:bmad/ENVIRONMENT.md | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |
| project:bmad/dependency-exceptions.json | reviewed | Revue des garanties ci-dessus ; preuve finale imposée par les contrôles et le contrat desktop. |

Contrat 50 v1.3.0 relu : chaque revue porte la portée exacte du dépôt, des sources et
preuves, du contrat, des règles et du contrôleur. Le catalogue reste pending ; aucune
approbation n’est déduite d’un succès de test ou d’une autorisation de publication.
Les états et motifs de cette revue sont réévalués sur les changements finaux : versions
Node/AWS testées, règles de lint renforcées, CI liée au contrôleur privé avec refus de
revues périmées et clone CI du même dépôt vérifié. Les six régressions de portée et les
quatre du protocole de lots font partie des 23 tests du contrôleur.
Le probe complet du 28 octobre à 19:19 UTC a réussi : 3807 fichiers, zéro échec de
l’analyse AST/options/couverture/lint typé, 666 secondes et sources inchangées.
ESLint isole les lots de 250 fichiers dans des enfants bornés à 8 Gio ; reçu privé et
couverture exacte requis. L’ancienne exécution en échec mémoire reste conservée au journal.
Les configurations vides de base restent soumises aux options strictes et à la couverture
complète. ban-ts-comment interdit les trois directives de suppression, y compris ts-expect-error.
Les sept missions ont de nouveau réussi à 19:13 UTC après les mises à jour Node/AWS ;
preuve caviardée et empreintes des sous-processus dans autonomy-final.json.
Le parcours natif du nouveau paquet, son installation et sa disponibilité publique
restent distincts de ces preuves source et doivent encore être vérifiés.

Référence CI privée finale : 4072d2b1f56ef7f0226be20c7998ff3533fc0fd3 ;
contrôleur revu avec portée et run+verify réussis sur ce commit exact.

Mise à jour Tiptap 3.32.0 → 3.32.1 après publication complète des paquets à 19:54 UTC :
les 14 exigences directes/overrides et le lock sont synchronisés, 38 paquets installés.
Audit direct de 278 entrées sans écart ; les deux seules exceptions restent inchangées.
Les quatre parcours Chromium réels ont été rejoués avec cette version et réussissent ;
ui-components.json porte la date, les versions installées, le hash du lock et des composants.
Les sept missions headless antérieures portent sur le runtime Node/AWS et les sous-processus
déjà reconstruits ; Tiptap concerne l’éditeur. La mission native finale vérifiera le paquet
complet après cette mise à jour. Le nouveau gate global reste obligatoire.

Le premier paquet natif a5a7a0c a réussi création de trois livrables, empreintes,
ouverture Markdown/JSON absolue et nouvelle demande créant un quatrième fichier.
Le clic relatif dans le Markdown est resté inactif : FilePreviewRenderer ne recevait
ni onOpenFile ni onOpenUrl. Publication suspendue avant tout tag ; défaut conservé au journal.
Correction ciblée : raccordement aux PlatformActions existantes et résolution des liens
depuis le dossier du document via le résolveur existant ; racines locales/Windows/UNC
préservées. Aucune nouvelle couche d’orchestration, dépendance ou permission.
Quatre tests de chemins réussis (deux nouveaux cas), lint ciblé sans avertissement et
trois parcours du vrai composant FilePreviewRenderer dans Chromium réussis ; preuve
ui-preview-links.json. Nouveaux gate global, build et parcours natif restent obligatoires.

## Reprise après crash et qualification CI
Le candidat natif a5 a été installé par le CLI officiel et le module privé conservé
à l’octet. Un lien relatif d’aperçu ne routait pas vers les actions existantes :
le correctif c9 raccorde ces callbacks et résout depuis le document. Les quatre tests
ciblés et trois parcours Chrome du composant passent ; la nouvelle installation
et le parcours natif complet restent requis avant tag.
Après saturation mémoire du Mac, aucun nouveau contrôle global ni build local.
Le contrôleur privé 109991b8a6b3967bab6c7860af4f5c0cafdff404 a réussi run puis verify
sur ce commit CI : https://github.com/Aoleon/rulebook-ai/actions/runs/40778242059.
Trente tests, MyPy strict14sources, Ruff/ESLint et contrats sont verts pour ce CLI.
L’AST est un processus fini avant les lots de lint. Aucun budget8Gio n’est forcé
par le contrôleur ; seul le job Linux de Robb fixe ce budget sur son propre runner.
Le reçu de contrôle est exact et obligatoire ; timeout et code réel restent distincts.
Le mode stage-signed réutilise --release, production, Developer ID et notarisation,
avec artefacts CI uniquement et Windows/Linux ignorés. Les tests du prévol exigent
la signature même sans tag, et vérifient que ce mode ne peut publier de release.
Le mode public et ses exigences de signature/notarisation ne sont pas affaiblis.
Les diagnostics publics se limitent à la sortie des tests synthétiques et aux workers.
Les règles privées, le rapport canonique complet, les secrets et Inqom restent exclus.
Le premier run Linux c9 a échoué dans les tests (123) ; il ne qualifie pas cette release.
Le nouveau run/verify exact reste obligatoire, puis prévol et parcours natifs Mac.
Mémoire enterprise indisponible par outil dans cette reprise : copie locale lue,
enterprise/rules.md mise à jour28/10/vérifiée02/08 et security-policies31/05 ;
ces documents historiques ne créent aucune autorisation. Cible Mac réutilisée,
aucun Orion, aucun sous-agent, aucun changement de configuration Codex.
Les36tests ciblés du prévol et de l’intégrité de release passent après ce delta.
Les runners de packaging utilisent explicitement Node26.12.1, comme le contrat.

## Diagnostic Linux de la reprise durable
Le run40778880825 passe typage, lint, environnement, dépendances et politique TypeScript ;
son seul échec observé est l’assertion async du cas prior-read. Le diagnostic40781421808
le reproduit sur le groupe complet292fichiers, alors que le cas isolé passe sur Mac.
Bun masque la raison derrière .resolves. Le test attend désormais la même promesse
avant la même assertion toBeUndefined ; l’assertion du reçu durable reste identique.
Aucun contrôle produit, rejet de mutation incertaine, timeout ou résultat attendu changé.
Le diagnostic40781794044 passe les2788tests/14643assertions avec cette seule différence.
Cela étaye un défaut du matcher ou de sa temporisation, sans établir un correctif
amont Bun. Son contrôle canonique a refusé la revue périmée, comme attendu.
L’étape de diagnostic temporaire est retirée. La qualification globale de ce nouveau
contenu reste obligatoire. Référence technique consultée :
https://github.com/oven-sh/bun/issues/37189 (problème analogue, pas preuve de même cause).

## Correction causale du 29 octobre
Le run global40782672913 invalide l’hypothèse du matcher. Le diagnostic40865259495
reproduit trois fois le même rejet : PowerShell validator root not set. Le détecteur
reconnaissait new-target dans touch /fixture/new-target comme un cmdlet. Sur Linux
avec pwsh disponible, cette erreur de routage appelait le parseur non initialisé.
Le correctif borne les motifs de cmdlets et alias aux positions de commande et
supprime le motif redondant non borné. Aucune nouvelle dépendance, couche,
permission ou exception ; les validateurs Bash/PowerShell et les protections contre
les mutations incertaines restent exigés. Les commandes PowerShell réelles,
pipelines et opérateurs restent reconnus. Les quinze tests de régression ont
été exécutés avec Bun1.4.4 : neuf passent et six échouent sur la source antérieure,
les quinze passent sur le correctif. La suite globale et ses contrôles de sécurité
restent obligatoires ; aucun timeout, test ignoré ou seuil n’est ajouté.
L’étape de diagnostic est retirée. Les preuves publiques portent uniquement les
tests synthétiques. La copie isolée est issue du commit poussé3d41e3d ; les lectures
du checkout Documents sont bloquées, sans modification de celui-ci. Toute intégration
attend sa relecture et la vérification des changements concurrents. Les fenêtres
natives ne sont pas exposées par l’outil actuel : aucun parcours local revendiqué.

## Isolation de l’environnement des tests
Le run40868793064 atteint session-tools-core après le groupe serveur. Le cas Node
de sandbox-env héritait process.env tout en exigeant l’absence de UV_CACHE_DIR,
variable définie par setup-uv en CI. Le même échec est reproduit avec une variable
synthétique sur Mac. Le test passe désormais un environnement vide explicite ;
un cas complémentaire prouve que les variables existantes sont conservées et
qu’aucun cache Python n’est créé pour Node. Le code produit n’est pas modifié.
Les dix-neuf tests ciblés passent avec Bun1.4.4 et UV_CACHE_DIR préexistant.
La qualification upstream_pinned_transitive est constatée dans le contrôleur DEV
fa57af45 (tooling/quality-controller), avec rapport PASS. Elle qualifie seulement
les transitives npm contraintes par leur parent actuel, avec arbre et audit valides ;
elle ne vaut pas dérogation générale pour Robb. Le contrôle de dépendances Robb
utilise Bun et passait déjà : aucune nouvelle exception ou substitution n’est ajoutée.

## Correction des deux contrôles de plateforme — 29 octobre
Le run 40885516394 révèle le refus du helper SUID livré avec Electron sous Linux.
La CI utilise désormais le helper Chrome déjà installé sur le runner, après
vérification de son propriétaire root et de son mode 4755. Cette méthode est
documentée par Chromium dans sa recommandation sur les restrictions AppArmor.
Aucun droit système modifié, aucune sandbox désactivée, aucun test ignoré.
Le run 40883934833 construit Windows mais mesure 1,02 Gio pour un budget de 1 Gio.
Le paquet Windows conserve les huit langues Electron correspondant au registre
Robb : en-US, es, zh-CN, ja, hu, de, pl et fr. Le budget reste inchangé.
Les sept tests du contrôleur CI passent localement. Les deux contrôles réels,
le gate canonique et le staging natif restent à vérifier sur ce nouveau contenu.

## Résultats de plateforme et correction du chemin de scan
Le run 40887729222 valide les contrats sur Linux, macOS et Windows ainsi que
le parcours complet de l’installateur Windows avec les huit locales conservées.
Le scanner CI appelait Gitleaks avec /repo : ses chemins absolus ne correspondaient
pas aux six chemins relatifs des exceptions. Reproduction locale : dix alertes
en chemin absolu, zéro depuis la racine avec `dir .`. Le conteneur définit donc
son répertoire de travail à /repo puis scanne `.` ; aucune exception élargie.
Le run 40887724048 constate que le helper Chrome préinstallé ne possède pas
les droits requis. La correction de droits sur runner éphémère est préparée,
mais attend l’autorisation sensible. Aucun succès Electron ni gate revendiqué.
Le diagnostic temporaire est retiré après identification de la cause : il faisait
double emploi avec les contrôles canoniques et empêchait les contrôles indépendants
de démarrer. Le vrai test Electron reste dans la suite obligatoire ; son échec
bloque toujours le gate et la publication. Aucun droit système n’est modifié.

## Contrôles OSS adaptés au découpage existant
Le scan CI passe sur 266c4765. Le contrôle suivant échouait sur des marqueurs
restés associés aux anciens fichiers monolithiques et à la syntaxe process.env
par point. Le validateur lit maintenant les modules explicites responsables de
l’isolation Dev, du remplacement macOS, du démarrage et de la reprise de session.
Aucune exigence n’est supprimée. La validation légère complète passe localement.
Les quatre tests fonctionnels des chemins de profils passent sous Bun 1.4.4.
Sept contrôles négatifs retirent en mémoire chacun des marqueurs critiques
dans son module réel : les sept suppressions sont refusées par le validateur.
Aucun fichier applicatif ou profil utilisateur n’est modifié par ces contrôles.

## Helper Electron CI — autorisation et périmètre, 29 octobre
Thibault autorise explicitement le helper Electron en root:root / 4755 sur le
runner GitHub éphémère. La préparation refuse les hôtes locaux ou auto-hébergés,
résout le chemin et exige un fichier régulier dans le checkout avant toute commande.
Elle contrôle le propriétaire et le mode après modification, puis laisse le vrai
test Electron et le gate obligatoires décider du résultat. Aucune sandbox désactivée.
La variable CHROME_DEVEL_SANDBOX inefficace est retirée. Dix tests ciblés passent,
dont refus de l’hôte non autorisé, du lien extérieur et d’un échec de commande.
Le contrôleur épinglé reste provisoirement celui du précédent run : son résultat
ne suffit pas à qualifier les quatre règles modifiées par la diffusion globale 3.
Le contrôleur partagé retourne encore quality_rules_changed ; sa requalification
et l’alignement des revues restent nécessaires avant intégration ou livraison.

La relance 40908746377 s’arrête avant toute mutation de droits : le paquet Electron
est installé mais son répertoire dist manque. La préparation exécute désormais
l’installateur officiel du paquet verrouillé uniquement si le helper manque.
Un échec de téléchargement bloque les commandes de droits ; onze tests ciblés
passent. Le contrôle final exige propriétaire et groupe root, ainsi que le mode
4755. Le parcours réel CI reste obligatoire pour qualifier cette préparation.

La CI 40910542224 vérifie le helper puis expire à la limite de 1 500 secondes
du pilote, avant le reçu global. La limite du gate passe explicitement à
2 100 secondes, dans le budget du job de 40 minutes ; mémoire et contrôles
individuels inchangés. Une expiration conserve le code 124 et une preuve publique
minimale, sans publier les règles privées ni appeler verify.
Les entrées HTTP et JSON du pilote sont validées et typées. Sur DEV, MyPy strict
avec interdiction des expressions Any et Ruff passent ; les douze tests ciblés
incluent la propagation du budget et le refus de verify après expiration.
Ces résultats ne remplacent pas le gate global ni la qualification des autres
langages et des règles actuelles, encore absente dans le contrat Robb.
