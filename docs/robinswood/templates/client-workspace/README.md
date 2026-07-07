# Template workspace client Robinswood Agents

Date de référence : 2026-07-07

Ce dossier contient les artefacts prêts à copier pour créer un workspace client français, policy-first et auditable.

## Fichiers

- `routing-policy.standard.json` — policy standard : local/souverain pour données sensibles, premium/Gemini seulement pour public.
- `routing-policy.no-external-premium.json` — variante stricte : aucun provider premium externe, même pour public.
- `source-sensitivity-matrix.csv` — matrice de classement manuel `routingSensitivity` des sources.

## Connexions IA attendues

Les slugs sont contractuels pour les policies :

| Slug | Libellé conseillé | Type attendu | Usage |
|---|---|---|---|
| `local-rapide` | Local — rapide | `pi_compat` | local/on-device ou gateway client |
| `souverain-standard` | Souverain — standard | `pi_compat` | endpoint FR/EU/client validé |
| `premium-analyse-complexe` | Premium — analyse complexe | `anthropic`, `pi` ou `pi_compat` | public uniquement sauf exception client |
| `google-gemini` | Google Gemini | `pi` OAuth `google-gemini-code-assist` | public uniquement sauf exception client |

Ne pas ajouter `souverain-standard` tant que l’endpoint réel (URL/auth/model IDs/streaming) n’est pas validé.

## Installation rapide

1. Créer le workspace client.
2. Vérifier que l’UI est en français.
3. Créer les connexions IA avec les slugs ci-dessus.
4. Tester chaque connexion indépendamment.
5. Classer chaque source avec `routingSensitivity` selon `source-sensitivity-matrix.csv`.
6. Coller une policy JSON dans Workspace Settings → Router IA.
7. Valider une session par sensibilité : `public`, `internal`, `confidential`, `restricted`.
8. Vérifier le tooltip réponse : provider, modèle, raison, sensibilité, règles, fallback/coût si disponibles.
9. Ouvrir `Audit IA`, vérifier l’agrégat et copier les exports JSON/Markdown.

## Choix de policy

### Standard

Utiliser `routing-policy.standard.json` si le client autorise explicitement les providers premium/Gemini pour contenus publics.

### Sans externe premium

Utiliser `routing-policy.no-external-premium.json` si le client interdit les providers externes premium ou marketplace.

## Critères d’acceptation pilote

- Les contenus `restricted` ne peuvent sortir que vers `local-rapide`.
- Les contenus `confidential` exigent une allow-list explicite.
- Un provider primaire cassé fallback uniquement vers une connexion autorisée.
- Aucun fallback hors policy n’est possible.
- Chaque réponse assistant est auditée avec provider/modèle/règles.
- L’export `Audit IA` ne contient aucun secret ni clé API.

## Notes de déploiement

```text
Client :
Date :
Responsable Robinswood :
Policy utilisée : standard / no-external-premium / personnalisée
Connexions créées :
Sources activées :
Sources non classées :
Exceptions validées par le client :
Tests E2E réalisés :
Risques / arbitrages :
```
