# Robb Agents — mémoire de fork

Date de décision : 2026-07-06

Ce dépôt est la distribution open-source Robb Agents maintenue par Robinswood, basée sur `craft-ai-agents/craft-agents-oss`.

Objectif : construire une distribution française, client-ready et open-source de Craft Agents OSS, orientée usages métier, gouvernance IA et routage intelligent des modèles, sans embarquer de proxy ou endpoint privé Robinswood dans l’arbre OSS.

## Décision

Nous ne forkons pas uniquement pour obtenir la langue française. Le français est le point d’entrée, mais le fork doit devenir une base produit Robinswood :

- interface française native ;
- app rebrandée, sans usage de la marque Craft en distribution client ;
- connecteurs métiers français et intégrations configurables par déploiement ;
- workspaces préconfigurés par client ;
- politiques de confidentialité et de routage IA ;
- audit des actions et des providers utilisés ;
- capacité à router entre local, OVH/custom endpoints, OpenRouter, Anthropic/OpenAI ou autres providers selon les règles client.

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
4. routage IA policy-first ;
5. coût et provider visibles par réponse ;
6. souveraineté / confidentialité configurables ;
7. audit client.

## Router IA cible

Le router ne doit pas optimiser uniquement le coût. Il doit être **policy-first** :

1. confidentialité / sensibilité ;
2. providers autorisés par client/workspace/source ;
3. difficulté de la tâche ;
4. besoin d’outils ou de vision ;
5. contexte requis ;
6. latence ;
7. coût.

Exemples :

- résumé simple → local / OVH petit modèle ;
- données client sensibles → local ou endpoint souverain autorisé ;
- analyse complexe → modèle premium autorisé ;
- action destructive → modèle fort + permission + audit ;
- production client-facing → modèle fort + validation humaine si nécessaire.

## Dossiers de travail

- [`provider-playbook.md`](./provider-playbook.md) — stratégie providers, policy-first router, statuts livrés.
- [`manual-e2e.md`](./manual-e2e.md) — checklist de validation Electron réelle avant pilote client.
- [`upstream-pr-evaluation-2026-07-07.md`](./upstream-pr-evaluation-2026-07-07.md) — évaluation des PR Craft Agents OSS à intégrer dans Robb Agents.
- [`client-workspace-template.md`](./client-workspace-template.md) — template workspace client Robinswood.
- [`router-fallback-spec.md`](./router-fallback-spec.md) — spécification du fallback router policy-aware.
- [`audit-and-cost-spec.md`](./audit-and-cost-spec.md) — spécification audit provider/modèle/coûts.
- [`rebrand-inventory.md`](./rebrand-inventory.md) — inventaire initial des surfaces à rebrander.
- [`rebrand-implementation-plan.md`](./rebrand-implementation-plan.md) — plan rebrand minimal sans renommage massif.
- [`ovh-ai-endpoints-verification.md`](./ovh-ai-endpoints-verification.md) — checklist de vérification OVHcloud AI Endpoints avant preset.
- [`routing-policy.example.json`](./routing-policy.example.json) — exemple policy validé par tests.
- [`technical-spike-router.md`](./technical-spike-router.md) — notes techniques switch provider / router.
- [`market-roadmap-execution-plan-2026.md`](./market-roadmap-execution-plan-2026.md) — plan d’exécution consolidé face au marché, dépendances, SLO et critères d’acceptation.

## Roadmap initiale

### Phase 0 — Fork propre

- [x] Créer le fork Robinswood initial, puis préparer la distribution OSS `robb-agents`.
- [x] Ajouter upstream Craft Agents OSS.
- [x] Intégrer la locale française.
- [x] Ajouter CI Robinswood (`Robinswood Validate`) avec install gelée, typechecks ciblés et tests router/runtime ; validation upstream lourde disponible en manuel.
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

### Phase 3 — Router automatique

- [x] Définir `routingPolicy` par workspace/client.
- [x] Ajouter un exemple client validé : `routing-policy.example.json`.
- [x] Éditer/valider `routingPolicy` depuis les réglages Workspace.
- [x] Sensibilité manuelle par source via `routingSensitivity`, éditable depuis la page Source.
- [ ] Classifier léger de difficulté/sensibilité.
- [x] Sélecteur de provider et modèle par tour lorsque `routingPolicy.enabled=true`.
- [ ] Fallbacks si provider indisponible. Spécification prête dans `router-fallback-spec.md`.
- [ ] Budget et métriques coût. Spécification prête dans `audit-and-cost-spec.md`.

## Règles de maintenance du fork

- Garder une branche `upstream/main` propre.
- Garder les patches Robinswood petits et documentés.
- Rebase/merge upstream régulièrement.
- Éviter les divergences profondes avant stabilisation produit.
- Toute modification structurante doit être documentée dans `docs/robinswood/`.

## Notes légales

Robb Agents est publié sous licence MIT pour les modifications Robb, avec conservation de `LICENSE-APACHE` et du `NOTICE` upstream pour les portions dérivées de Craft Agents OSS. “Craft” et “Craft Agents” sont des marques de Craft Docs Ltd. ; Robb Agents n’est pas une distribution officielle Craft. L’arbre OSS ne doit pas embarquer d’endpoint/proxy privé Robinswood ; ces déploiements doivent rester dans des overlays privés.
