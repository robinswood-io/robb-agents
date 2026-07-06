# Robinswood Agents — mémoire de fork

Date de décision : 2026-07-06

Ce dépôt est le fork privé Robinswood de `craft-ai-agents/craft-agents-oss`.

Objectif : construire une distribution française, client-ready, de Craft Agents OSS, orientée usages métier, gouvernance IA, sources Robinswood et routage intelligent des modèles.

## Décision

Nous ne forkons pas uniquement pour obtenir la langue française. Le français est le point d’entrée, mais le fork doit devenir une base produit Robinswood :

- interface française native ;
- app rebrandée, sans usage de la marque Craft en distribution client ;
- connecteurs métiers français et Robinswood ;
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

Nom de travail : **Robinswood Agents**.

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

## Roadmap initiale

### Phase 0 — Fork propre

- [x] Créer repo privé `robinswood-io/robinswood-agents`.
- [x] Ajouter upstream Craft Agents OSS.
- [x] Intégrer la locale française.
- [x] Ajouter CI minimale (`Robinswood Validate`) ; validation upstream lourde disponible en manuel.
- [ ] Rebrand app, bundle ID, icône, docs, installer. Inventaire initial documenté dans `rebrand-inventory.md`.
- [x] Clarifier obligations Apache 2.0 / trademark au niveau inventaire initial.

### Phase 1 — Distribution française

- [x] Français par défaut pour les nouvelles installations Robinswood, avec override utilisateur persistant.
- [ ] Onboarding simplifié pour clients français.
- [ ] Presets LLM : local, OVH/custom endpoint, OpenRouter, Anthropic/OpenAI si autorisé.
- [ ] Templates workspace Robinswood.
- [ ] Permissions par défaut adaptées client.

### Phase 2 — Switch manuel provider

- [ ] Permettre un handoff provider après un tour, quand l’agent est idle.
- [ ] Afficher provider/modèle par réponse.
- [ ] Journaliser les changements.
- [ ] Préserver le contexte via transcript/résumé canonique.

### Phase 3 — Router automatique

- [ ] Définir `routingPolicy` par workspace/client.
- [ ] Classifier léger de difficulté/sensibilité.
- [ ] Sélecteur de provider et modèle par tour.
- [ ] Fallbacks si provider indisponible.
- [ ] Budget et métriques coût.

## Règles de maintenance du fork

- Garder une branche `upstream/main` propre.
- Garder les patches Robinswood petits et documentés.
- Rebase/merge upstream régulièrement.
- Éviter les divergences profondes avant stabilisation produit.
- Toute modification structurante doit être documentée dans `docs/robinswood/`.

## Notes légales

Craft Agents OSS est sous Apache 2.0, mais “Craft” et “Craft Agents” sont des marques. Une distribution client Robinswood doit donc être rebrandée et ne pas être présentée comme une app officielle Craft.
