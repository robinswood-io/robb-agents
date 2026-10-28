# Revue des exigences de la release 0.12.11 — 28 octobre 2026

Cette revue lie les exigences aux versions et moyens de preuve. Elle ne déclare
ni le gate global réussi, ni l'application installée, ni les installateurs disponibles.
Les résultats exécutés restent dans les reçus du contrôleur sur le checkout exact.
Une ligne reviewed indique une revue des exigences ; aucun résultat futur n'est inventé.

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
