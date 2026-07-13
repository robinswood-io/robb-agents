# Évaluation PR upstream Craft Agents OSS — Robb Agents

Date de référence : 2026-07-07 14:27 Europe/Paris

Objectif : identifier les PR upstream intéressantes à intégrer dans Robb Agents, distribution OSS Robinswood, en privilégiant les fonctionnalités utiles pour un pilote client français : sécurité, stabilité des sources, UX de distribution, gouvernance, compatibilité Windows/macOS, et faible risque de merge.

## Synthèse exécutive

Priorité recommandée : intégrer d’abord les petits correctifs mergeables qui réduisent les risques client sans toucher au cœur Robb router/Gemini/rebrand.

## Statut d’intégration — 2026-07-07 15:37 Europe/Paris

Intégré dans `robinswood/main` :

| PR upstream | Statut Robb | Commit Robb |
|---|---|---|
| #822 — masked API key not sent to backend | Intégré | `623fb292` |
| #865 — sanitize MCP source proxy tool names | Intégré | `623fb292` |
| #889 — confirm before deleting workspace | Intégré | `623fb292` |
| #945 — percent-encoded file path links | Intégré | `623fb292` |
| #821 — refresh models after LLM reauth | Intégré | `ca521ab2` |
| #836 — keep macOS Dock icon consistent | Intégré | `ca521ab2` |
| #871 — inherit Windows system proxy | Intégré | `ca521ab2` |
| #789 — symlinked skills discovery | Intégré | `ca521ab2` |
| #890 — per-group pagination status/unread | Intégré | `ca521ab2` |
| #939 — persisted gitBashPath envOverrides | Intégré | `ca521ab2` |
| #918 — relative + multiplatform source paths | Intégré avec couverture Robb `CONFIG_DIR` | `e46a9252` |
| #893 — persist auto-update diagnostics | Déjà présent dans la base upstream (`556c59a7`) ; adaptation Robb ajoutée | `8cb426f3` |
| #952 — i18n built-in status/label names | Intégré avec traductions FR et tests de non-régression | `9096940f` |

Validation locale après intégration : Robinswood validator, typechecks `shared`/`server-core`/`electron`, 227 tests ciblés, build subprocess, et smoke-test DMG `Robb-Agents-arm64.dmg`.

### Lot A — À intégrer en premier

| PR | Intérêt Robb | Applicabilité locale | Recommandation |
|---|---|---:|---|
| #822 — masked API key not sent to backend | Sécurité/confidentialité credentials ; tiny patch | clean apply | Intégrer immédiatement |
| #865 — sanitize MCP source proxy tool names | Fiabilité/sécurité sources MCP ; important pour clients avec sources custom | clean apply | Intégrer immédiatement |
| #889 — confirm before deleting workspace | Garde-fou UX destructif ; cohérent avec usage client | clean apply | Intégrer immédiatement |
| #893 — persist auto-update diagnostics | Prépare distribution externe Robb ; debug update production | 3-way apply | Intégrer après revue rapide |
| #945 — percent-encoded file path links | Bugfix markdown/liens fichiers ; faible risque | clean apply | Intégrer immédiatement |
| #952 — i18n built-in status/label names | Très utile pour UX français-first ; complète notre FR-first | 3-way apply | Intégrer avec revue i18n Robb |

### Lot B — Bon ROI, après Lot A

| PR | Intérêt Robb | Applicabilité locale | Recommandation |
|---|---|---:|---|
| #821 — refresh models after LLM reauth | Fiabilité settings IA | clean apply | Intégrer |
| #836 — keep macOS Dock icon consistent | Polish rebrand Robb/macOS | clean apply | Intégrer avant release packagée |
| #871 — inherit Windows system proxy | Important pour clients entreprise Windows/proxy | clean apply | Intégrer avant pilote Windows |
| #918 — relative + multiplatform source paths | Portabilité templates workspace client/sources | clean apply | Intégrer avec tests sources |
| #939 — persisted gitBashPath envOverrides | Fiabilité Windows SDK subprocess | clean apply | Intégrer avec #871 |
| #789 — symlinked skills discovery | Robustesse dev/skills | clean apply | Intégrer si skills clients avancés |
| #890 — per-group pagination status/unread | UX listes longues | clean apply | Intégrer après sécurité/stabilité |

### Lot C — Utile mais à étudier/cherry-pick prudemment

| PR | Intérêt Robb | Applicabilité locale | Risque / note |
|---|---|---:|---|
| #760 — Anthropic session sandboxing | Très intéressant sécurité/gouvernance | conflicting | Grand patch ; à découper/cherry-pick après router policy stable |
| #805 — source_activated auto-retry server-side | UX sources ; réduit retry côté renderer | conflicting | À étudier pour workflows sources client |
| #667 — classify context overflow errors | Meilleurs diagnostics modèles | conflicting | Petit concept, mais conflits types/messages |
| #779 — Telegram final messages | Messaging gateway fiabilité | 3-way apply | À intégrer si Telegram est prioritaire |
| #713 — preferences notes to Pi backend | Personnalisation Pi/Gemini | 3-way apply | À comparer avec notre Gemini bridge |
| #728 — default zoom level setting | UX nice-to-have | 3-way apply | Pas prioritaire pour pilote |
| #917 — multiple subscription support | Potentiellement utile, mais chevauche notre Google/Gemini OAuth custom | conflicting | Étudier après stabilisation provider matrix |
| #874 — Pi SDK maintained fork/update | Important modèles/Bedrock, mais touche dépendances Pi | conflicting | Audit technique dédié nécessaire |

### Lot D — Ne pas intégrer maintenant

| PR | Raison |
|---|---|
| #954 — team-mode workspace mutation permissions | Énorme patch (+218k/-5.6k, 1246 fichiers), conflit massif ; direction sécurité intéressante mais pas intégrable tel quel |
| #851 — honor CRAFT_CONFIG_DIR for app state paths | Objectif déjà traité dans Robb : `CONFIG_DIR` isolé `~/.robb-agents`, `window-state` centralisé, CI split |
| #752/#750 — custom endpoint protocol/model metadata | Semble largement déjà couvert par notre fork ; faire diff ciblé avant doublon |
| #724/#694 — i18n language sync | Probablement partiellement couvert par FR-first ; vérifier uniquement si bug UI main-process réapparaît |
| WeChat PRs #845/#799/#688 | Intérêt marché Chine, pas prioritaire pour clients FR Robb |

## Détails des PRs prioritaires

### #822 — Editing a connection no longer sends masked API key to backend

- Type : sécurité/privacy credentials.
- Taille : 1 fichier, +2/-7.
- Applicabilité locale : `clean apply`.
- Valeur : évite qu’un placeholder masqué soit traité comme clé réelle ou propagé côté backend.
- Recommandation : **prendre en premier**.

### #865 — Sanitize source proxy tool names

- Type : sécurité/robustesse MCP sources.
- Taille : 3 fichiers, +148/-8.
- Applicabilité locale : `clean apply`.
- Valeur : protège l’exposition de tools MCP quand les noms sources/outils contiennent caractères non conformes.
- Recommandation : **prioritaire** pour Robb, car les sources client custom sont centrales.

### #889 — Confirm before deleting a workspace

- Type : garde-fou UX destructif.
- Taille : 8 fichiers, +26/-0.
- Applicabilité locale : `clean apply`.
- Valeur : aligne l’app sur le principe de confirmation avant action destructive.
- Recommandation : **prioritaire**.

### #893 — Persist auto-update diagnostics in production

- Type : distribution/ops.
- Taille : 3 fichiers, +92/-16.
- Applicabilité locale : `3-way apply`.
- Valeur : indispensable pour diagnostiquer les mises à jour une fois Robb distribué.
- Recommandation : **intégrer avant première distribution externe**, après revue du contexte rebrand/update endpoint.

### #945 — Percent-encoded bare file path links

- Type : bugfix markdown/navigation fichiers.
- Taille : 4 fichiers, +39/-3.
- Applicabilité locale : `clean apply`.
- Valeur : améliore liens fichiers avec espaces/caractères encodés ; faible risque.
- Recommandation : **intégrer**.

### #952 — i18n built-in status/label names

- Type : i18n/UX.
- Taille : 15 fichiers, +190/-37.
- Applicabilité locale : `3-way apply`.
- Valeur : complète le travail français-first pour statuts/labels intégrés.
- Risque : vérifier interactions avec nos labels/status éventuels Robb.
- Recommandation : **intégrer avec revue i18n**.

## Ordre d’intégration proposé

1. Créer branche `integrate/upstream-safety-small` depuis `robinswood/main`.
2. Cherry-pick / apply : #822, #945, #889.
3. Valider : focused tests + Robinswood Validate.
4. Cherry-pick / apply : #865.
5. Valider sources/MCP tests.
6. Cherry-pick / apply : #821, #836, #939, #871.
7. Valider Windows-related logic via tests seulement sur macOS, puis CI.
8. Intégrer #952 séparément pour faciliter revue i18n.
9. Intégrer #893 avant release update/notarisation.
10. Ouvrir spikes dédiés pour #760, #874, #917, #805.

## Commandes utilisées

- Listing PRs : `gh pr list --repo craft-ai-agents/craft-agents-oss --state open --limit 50`.
- Détails : `gh pr view <n> --repo craft-ai-agents/craft-agents-oss --json ...`.
- Applicabilité locale : `gh pr diff <n> ...` puis `git apply --check`, fallback `git apply --3way --check`.

## Conclusion

Les meilleurs candidats immédiats pour Robb Agents sont : **#822, #865, #889, #893, #945, #952**.

Ils apportent une valeur client directe avec un risque limité : sécurité credentials, sécurité sources MCP, garde-fous destructifs, diagnostics update, robustesse liens fichiers, et i18n française plus cohérente.
