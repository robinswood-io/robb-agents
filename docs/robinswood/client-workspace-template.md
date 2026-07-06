# Template workspace client — Robinswood Agents

Date de référence : 2026-07-06

Ce template décrit la configuration cible d’un workspace client Robinswood prêt pour pilote.

## Objectif

Déployer un workspace français, policy-first, avec :

- connexions IA nommées de manière stable ;
- `routingPolicy` client explicite ;
- sources classées par sensibilité ;
- permissions prudentes ;
- audit provider/modèle visible par réponse.

## Convention de nommage des connexions IA

Les slugs ci-dessous doivent être utilisés dans les policies et templates.

| Slug | Libellé conseillé | Usage | Sensibilités typiques |
|---|---|---|---|
| `local-rapide` | Local — rapide | tâches simples, brouillons, données restreintes | public, internal, confidential, restricted |
| `souverain-standard` | Souverain — standard | endpoint EU/client/OVH validé | internal, confidential |
| `premium-analyse-complexe` | Premium — analyse complexe | forte synthèse, raisonnement complexe | public, internal si autorisé |
| `google-gemini` | Google Gemini | Gemini via Google AI Studio | public, internal si autorisé explicitement |

Important : ces slugs sont fonctionnels. Les libellés visibles peuvent être plus client-friendly, mais la policy doit référencer les slugs exacts.

## Sensibilités source

Chaque source client doit recevoir une `routingSensitivity` manuelle dès l’installation.

| Type de source | Sensibilité par défaut | Exemples |
|---|---|---|
| Documentation publique | `public` | site web, docs marketing publiques |
| Travail interne courant | `internal` | notes projet, backlog, CRM non sensible |
| Documents client / RH / finance | `confidential` | Drive client, compta, contrats, emails |
| Données très sensibles | `restricted` | secrets, exports paie, M&A, santé, contentieux |

Règle : en cas de doute, choisir la sensibilité supérieure.

## Permissions workspace recommandées

Dans Workspace Settings :

```json
{
  "permissionMode": "ask",
  "cyclablePermissionModes": ["safe", "ask", "allow-all"],
  "localMcpEnabled": true
}
```

Recommandation pilote :

- défaut `ask` ;
- `safe` pour exploration client ;
- `allow-all` uniquement pour tâches contrôlées / validation interne.

## routingPolicy client par défaut

À coller dans Workspace Settings → Router IA après création des connexions.

```json
{
  "version": 1,
  "enabled": true,
  "defaultSensitivity": "internal",
  "requireExplicitAllowFor": ["confidential", "restricted"],
  "rules": [
    {
      "id": "public-premium-or-gemini",
      "description": "Les contenus publics peuvent utiliser les providers premium autorisés.",
      "when": { "sensitivity": ["public"] },
      "allowConnectionSlugs": ["premium-analyse-complexe", "google-gemini", "souverain-standard", "local-rapide"],
      "preferConnectionSlugs": ["premium-analyse-complexe", "google-gemini"]
    },
    {
      "id": "internal-sovereign-first",
      "description": "Les contenus internes privilégient le souverain/client.",
      "when": { "sensitivity": ["internal"] },
      "allowConnectionSlugs": ["souverain-standard", "local-rapide"],
      "preferConnectionSlugs": ["souverain-standard"],
      "fallbackConnectionSlugs": ["local-rapide"]
    },
    {
      "id": "confidential-sovereign-or-local",
      "description": "Les contenus confidentiels restent sur connexions souveraines/locales.",
      "when": { "sensitivity": ["confidential"] },
      "allowConnectionSlugs": ["souverain-standard", "local-rapide"],
      "preferConnectionSlugs": ["souverain-standard"],
      "fallbackConnectionSlugs": ["local-rapide"]
    },
    {
      "id": "restricted-local-only",
      "description": "Les contenus restreints restent locaux uniquement.",
      "when": { "sensitivity": ["restricted"] },
      "allowConnectionSlugs": ["local-rapide"]
    }
  ]
}
```

## Variante sans provider premium externe

Pour un client interdisant Google/OpenAI/Anthropic/OpenRouter :

```json
{
  "version": 1,
  "enabled": true,
  "defaultSensitivity": "internal",
  "defaultDenyConnectionSlugs": ["google-gemini", "premium-analyse-complexe"],
  "requireExplicitAllowFor": ["confidential", "restricted"],
  "rules": [
    {
      "id": "public-sovereign-or-local",
      "when": { "sensitivity": ["public"] },
      "allowConnectionSlugs": ["souverain-standard", "local-rapide"],
      "preferConnectionSlugs": ["souverain-standard"]
    },
    {
      "id": "internal-sovereign-or-local",
      "when": { "sensitivity": ["internal"] },
      "allowConnectionSlugs": ["souverain-standard", "local-rapide"],
      "preferConnectionSlugs": ["souverain-standard"]
    },
    {
      "id": "confidential-sovereign-or-local",
      "when": { "sensitivity": ["confidential"] },
      "allowConnectionSlugs": ["souverain-standard", "local-rapide"],
      "preferConnectionSlugs": ["souverain-standard"]
    },
    {
      "id": "restricted-local-only",
      "when": { "sensitivity": ["restricted"] },
      "allowConnectionSlugs": ["local-rapide"]
    }
  ]
}
```

## Checklist de création workspace

1. Créer le workspace client.
2. Vérifier langue UI française.
3. Créer/renommer les connexions IA :
   - `local-rapide` ;
   - `souverain-standard` ;
   - `premium-analyse-complexe` si autorisé ;
   - `google-gemini` si autorisé.
4. Tester chaque connexion.
5. Configurer les sources.
6. Renseigner `routingSensitivity` sur chaque source.
7. Coller et valider `routingPolicy`.
8. Créer une session test par sensibilité.
9. Vérifier tooltip provider/modèle/règles.
10. Exécuter `manual-e2e.md`.

## Checklist d’acceptation client

| Contrôle | Attendu | Statut |
|---|---|---|
| Langue | UI française |  |
| Connexions | slugs conventionnels disponibles |  |
| Sources | toutes classées par sensibilité |  |
| Policy | JSON valide, enregistrée top-level |  |
| Public | premium/Gemini autorisé seulement si client OK |  |
| Internal | souverain/local |  |
| Confidential | souverain/local explicite |  |
| Restricted | local uniquement |  |
| Fail-closed | aucune route silencieuse si interdit |  |
| Audit | tooltip provider/model/reason/sensitivity/rules visible |  |

## Notes d’installation client

```text
Client :
Date :
Responsable Robinswood :
Connexions disponibles :
Sources activées :
Exceptions policy :
Risques / arbitrages :
```
