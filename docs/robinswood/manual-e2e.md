# Validation manuelle E2E — Robinswood Agents

Date de référence : 2026-07-06

Ce document décrit la validation manuelle à exécuter dans l’app Electron avant de considérer le fork Robinswood prêt pour un pilote client.

## Objectif

Vérifier en conditions réelles que :

- les connexions IA agentiques se créent correctement ;
- le switch manuel de provider fonctionne entre deux tours ;
- `routingPolicy` route selon la politique workspace ;
- `routingSensitivity` des sources influence la sensibilité effective ;
- le badge provider/modèle expose une explication claire ;
- la politique fail-closed bloque les routes non autorisées.

## Pré-requis

### Build / lancement

Depuis le repo :

```bash
cd ~/Developer/robinswood-agents
bun install --frozen-lockfile
bun run typecheck:electron
bun run dev:electron
```

Si la commande de lancement Electron diffère selon l’environnement, noter ici la commande réellement utilisée :

```text
Commande réelle : ______________________________
```

### Connexions IA minimales

Créer ou vérifier les connexions suivantes dans Settings → AI :

| Slug cible | Usage | Type attendu |
|---|---|---|
| `local-rapide` | tâches peu sensibles / rapides | local ou endpoint compatible |
| `souverain-standard` | données internes/confidentielles | endpoint EU/souverain validé |
| `premium-analyse-complexe` | raisonnement complexe autorisé | provider premium autorisé |

Notes credentials :

- ne jamais committer de clés API ;
- vérifier que chaque connexion passe le bouton de validation ;
- si une connexion réelle n’est pas encore disponible, noter `BLOCKED` et la raison.

## Scénario A — Création de connexions

### A1. Connexion API key générique

1. Ouvrir Settings → AI.
2. Cliquer Add connection.
3. Sélectionner Other provider / API key.
4. Sélectionner un preset provider explicite (ex. OpenRouter, Google AI Studio si une clé API est disponible, ou autre provider validé).
5. Entrer la clé API correspondante.
6. Valider.

Résultat attendu :

- connexion créée sous slug `pi-api-key` ou variante unique si slug déjà pris ;
- provider affiché selon le preset choisi ;
- modèle par défaut résolu selon le provider ;
- validation de connexion OK.

Note produit : une clé Google AI Studio n’est pas un abonnement Google Gemini. Aucun flux OAuth/abonnement Gemini ne doit être affiché tant qu’il n’est pas supporté et validé côté backend Pi.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

Notes :

```text

```

### A2. Connexions Robinswood conventionnelles

Créer/renommer les connexions :

- `local-rapide` ;
- `souverain-standard` ;
- `premium-analyse-complexe`.

Résultat attendu :

- les trois connexions apparaissent dans le sélecteur de modèle/connexion ;
- aucune erreur d’auth ;
- le sélecteur reste disponible même après plusieurs messages.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

Notes :

```text

```

## Scénario B — Switch manuel provider entre deux tours

1. Créer une nouvelle session.
2. Envoyer : `Réponds en une phrase et indique le provider utilisé si visible.`
3. Attendre la fin complète du streaming.
4. Changer de connexion IA dans le sélecteur.
5. Envoyer : `Continue avec le même contexte, mais résume en 3 puces.`

Résultat attendu :

- le switch est autorisé uniquement session idle ;
- aucun crash ni perte totale de contexte ;
- la réponse suivante utilise la nouvelle connexion ;
- le badge provider/modèle change ;
- les métadonnées `routingMeta.reason` indiquent `manual-handoff` ou équivalent.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

Notes :

```text

```

## Scénario C — Sensibilité source

1. Ouvrir une source test.
2. Régler Sensibilité router sur `Confidentiel`.
3. Créer une session avec cette source activée.
4. Envoyer une question simple sur la source.

Résultat attendu :

- la sensibilité effective du tour est `confidential` ;
- le badge/tooltip de réponse affiche la sensibilité ;
- la route choisie respecte les allow-lists confidentielles.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

Notes :

```text

```

## Scénario D — routingPolicy workspace

Dans Workspace Settings → Router IA, coller une policy minimale adaptée aux slugs disponibles :

```json
{
  "version": 1,
  "enabled": true,
  "defaultSensitivity": "internal",
  "requireExplicitAllowFor": ["confidential", "restricted"],
  "rules": [
    {
      "id": "public-premium-ok",
      "when": { "sensitivity": ["public"] },
      "allowConnectionSlugs": ["premium-analyse-complexe"],
      "preferConnectionSlugs": ["premium-analyse-complexe"]
    },
    {
      "id": "internal-sovereign-first",
      "when": { "sensitivity": ["internal"] },
      "allowConnectionSlugs": ["souverain-standard", "local-rapide"],
      "preferConnectionSlugs": ["souverain-standard"]
    },
    {
      "id": "confidential-local-or-sovereign",
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

Valider puis enregistrer.

Résultat attendu :

- JSON valide accepté ;
- warnings visibles si un slug n’existe pas ;
- policy persistée au top-level `routingPolicy` du `config.json` workspace ;
- champ vide supprime/désactive la policy.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

Notes :

```text

```

## Scénario E — Routage automatique policy-first

Avec la policy du scénario D :

1. Session sans source sensible → poser une question publique.
2. Session avec source `internal` → poser une question interne.
3. Session avec source `confidential` → poser une question confidentielle.
4. Session avec source `restricted` → poser une question restreinte.

Résultat attendu :

- public : route autorisée premium/Gemini selon préférence ;
- internal : route souveraine/local ;
- confidential : route souveraine/local explicitement autorisée ;
- restricted : local uniquement ;
- tooltip affiche `reason`, `sensitivity`, `policyRuleIds`, `connectionSlug`, `model`.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

Notes :

```text

```

## Scénario F — Fail-closed

Configurer temporairement une policy restrictive :

```json
{
  "version": 1,
  "enabled": true,
  "defaultSensitivity": "restricted",
  "requireExplicitAllowFor": ["restricted"],
  "rules": []
}
```

Créer une session et envoyer un message.

Résultat attendu :

- la requête est bloquée ;
- aucun fallback silencieux vers un provider non autorisé ;
- l’erreur explique que `routingPolicy` ne laisse aucune route autorisée.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

Notes :

```text

```

## Scénario G — Régression non-router

Vérifier rapidement :

- création de session classique sans policy ;
- sources activées/désactivées ;
- permission mode Explore / Ask / Execute ;
- streaming long ;
- reload app et reprise session ;
- suppression d’une connexion non utilisée.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

Notes :

```text

```

## Critères de sortie

Le pilote client peut démarrer si :

- A, B, D, E, F passent ;
- C passe sur au moins une source réelle ;
- aucun crash Electron ;
- aucune route non autorisée observée ;
- les éventuels `BLOCKED` concernent uniquement credentials/providers externes non disponibles.

## Résumé d’exécution

Date d’exécution : `____-__-__`

Validateur : `________________`

Version/commit : `________________`

| Scénario | Statut | Commentaire |
|---|---|---|
| A — Connexions |  |  |
| B — Switch manuel |  |  |
| C — Sensibilité source |  |  |
| D — routingPolicy |  |  |
| E — Routage automatique |  |  |
| F — Fail-closed |  |  |
| G — Régression |  |  |
