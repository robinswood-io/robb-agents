# Robb Agents — mémoire de fork

Date de décision : 2026-07-06

Ce dépôt est la distribution open-source Robb Agents maintenue par Robinswood, basée sur `craft-ai-agents/craft-agents-oss`.

Objectif : construire une distribution française, client-ready et open-source de Craft Agents OSS, orientée usages métier, gouvernance IA et sélection explicite des modèles, sans embarquer de proxy ou endpoint privé Robinswood dans l’arbre OSS.

## Décision

Nous ne forkons pas uniquement pour obtenir la langue française. Le français est le point d’entrée, mais le fork doit devenir une base produit Robinswood :

- interface française native ;
- app rebrandée, sans usage de la marque Craft en distribution client ;
- connecteurs métiers français et intégrations configurables par déploiement ;
- workspaces préconfigurés par client ;
- permissions et choix explicites des connexions IA ;
- audit des actions et des providers utilisés ;
- choix de connexions locales, custom endpoints, OpenRouter et fournisseurs directs autorisés par le client.

## Base initiale

- Upstream : `craft-ai-agents/craft-agents-oss`, tag/base initiale `v0.10.5`.
- Branche initiale Robinswood : `robinswood/main`.
- Ajout intégré : PR française #156 (`fr.json` + entrée `fr` dans `LOCALE_REGISTRY`).

## Constat technique important

Craft Agents OSS supporte déjà plusieurs connexions LLM et un modèle par session.

Cependant :

- le modèle peut être changé en cours de session ;
- la connexion/provider est verrouillée après le premier message via `connectionLocked` ;
- `setSessionConnection(...)` refuse le changement si la session contient déjà des messages ;
- `getOrCreateAgent(...)` verrouille la connexion lors de la première résolution.

Le switch provider dans un chat existant est donc un vrai chantier produit/architecture, pas un simple réglage UI.

## Orientation produit

Nom de travail : **Robb Agents**.

Positionnement : poste de travail IA français pour clients PME/ETI/cabinets/directions métiers, connecté aux sources internes et gouverné par politiques.

Différenciateurs visés :

1. français natif ;
2. sources métier packagées ;
3. templates d’assistants par fonction ;
4. sélection explicite du fournisseur, du modèle et du raisonnement ;
5. coût et provider visibles par réponse ;
6. souveraineté / confidentialité configurables ;
7. audit client.

## Sélection des modèles

Le main public ne contient pas de moteur de routage automatique des travaux
utilisateur. Les revues, sous-tâches et résumés héritent de la sélection explicite.
Les helpers fixes de métadonnées (titres/icônes) et les modèles par défaut lors
de la configuration d'une connexion restent distincts de l'affectation des tâches.

## Dossiers de travail

- [`provider-playbook.md`](./provider-playbook.md) — configuration des fournisseurs et sélection manuelle.
- [`manual-e2e.md`](./manual-e2e.md) — checklist de validation Electron réelle avant pilote client.
- [`upstream-pr-evaluation-2026-07-07.md`](./upstream-pr-evaluation-2026-07-07.md) — évaluation des PR Craft Agents OSS à intégrer dans Robb Agents.
- [`client-workspace-template.md`](./client-workspace-template.md) — template workspace client Robinswood.
- [`audit-and-cost-spec.md`](./audit-and-cost-spec.md) — spécification audit provider/modèle/coûts.
- [`rebrand-inventory.md`](./rebrand-inventory.md) — inventaire initial des surfaces à rebrander.
- [`rebrand-implementation-plan.md`](./rebrand-implementation-plan.md) — plan rebrand minimal sans renommage massif.
- [`ovh-ai-endpoints-verification.md`](./ovh-ai-endpoints-verification.md) — checklist de vérification OVHcloud AI Endpoints avant preset.
- [`market-roadmap-execution-plan-2026.md`](./market-roadmap-execution-plan-2026.md) — plan d’exécution consolidé face au marché, dépendances, SLO et critères d’acceptation.
- [`security-robustness-assessment-2026-07-24.md`](./security-robustness-assessment-2026-07-24.md) — audit vérifié, correctifs intégrés et risques résiduels priorisés.
- [`durable-task-contract.md`](./durable-task-contract.md) — contrat canonique des tâches durables, vue Conductor, projections cockpit, preuves et supervision long-running.

## Roadmap initiale

### Phase 0 — Fork propre

- [x] Créer le fork Robinswood initial, puis préparer la distribution OSS `robb-agents`.
- [x] Ajouter upstream Craft Agents OSS.
- [x] Intégrer la locale française.
- [x] Ajouter CI Robinswood (`Robinswood Validate`) avec install gelée, typechecks ciblés et tests de sessions et de sélection manuelle ; validation upstream lourde disponible en manuel.
- [ ] Rebrand app, bundle ID, icône, docs, installer. Inventaire initial documenté dans `rebrand-inventory.md`, plan minimal dans `rebrand-implementation-plan.md`.
- [x] Clarifier obligations MIT / Apache 2.0 upstream / trademark au niveau inventaire initial.

### Phase 1 — Distribution française

- [x] Français par défaut pour les nouvelles installations Robinswood, avec override utilisateur persistant.
- [ ] Onboarding simplifié pour clients français.
- [x] Playbook providers documenté : local, souverain/OVH custom endpoint, OpenRouter, Anthropic/OpenAI.
- [ ] Presets LLM codés : local, OVH/custom endpoint, OpenRouter, Anthropic/OpenAI si autorisé.
- [x] Template workspace Robinswood documenté dans `client-workspace-template.md`.
- [ ] Permissions par défaut adaptées client.

### Phase 2 — Switch manuel provider

- [x] Permettre un handoff provider après un tour, quand l’agent est idle.
- [x] Afficher provider/modèle par réponse.
- [x] Journaliser les changements via `routingMeta` persistant.
- [x] Préserver le contexte via transcript/résumé canonique best-effort.

## Règles de maintenance du fork

- Garder une branche `upstream/main` propre.
- Garder les patches Robinswood petits et documentés.
- Rebase/merge upstream régulièrement.
- Éviter les divergences profondes avant stabilisation produit.
- Toute modification structurante doit être documentée dans `docs/robinswood/`.

## Notes légales

Robb Agents est publié sous licence MIT pour les modifications Robb, avec conservation de `LICENSE-APACHE` et du `NOTICE` upstream pour les portions dérivées de Craft Agents OSS. “Craft” et “Craft Agents” sont des marques de Craft Docs Ltd. ; Robb Agents n’est pas une distribution officielle Craft. L’arbre OSS ne doit pas embarquer d’endpoint/proxy privé Robinswood ; ces déploiements doivent rester dans des overlays privés.
