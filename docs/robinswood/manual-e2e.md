# Validation manuelle E2E — Robb Agents

Date de référence : 2026-07-06

Ce document décrit la validation manuelle à exécuter dans l’app Electron avant de considérer le fork Robinswood prêt pour un pilote client.

## Objectif

Vérifier en conditions réelles que :

- les connexions IA agentiques se créent correctement ;
- le switch manuel de provider fonctionne entre deux tours ;
- le choix du modèle et du raisonnement persiste pendant les tâches et les reprises ;
- le badge provider/modèle expose une explication claire ;
- une erreur fournisseur ne change pas silencieusement la sélection.

## Pré-requis

### Build / lancement

Depuis le repo :

```bash
cd ~/Developer/robinswood-agents
bun install --frozen-lockfile
bun run typecheck:electron
bun run electron:dev
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
| `google-antigravity` | Gemini via compte Google / quota Antigravity | `providerType: pi`, `authType: none`, `piAuthProvider: google-antigravity` |
| `google-gemini` | Gemini Code Assist pour organisation licenciée | `providerType: pi`, `authType: oauth`, `piAuthProvider: google-gemini-code-assist` |

Notes credentials :

- ne jamais committer de clés API ;
- vérifier que chaque connexion passe le bouton de validation ;
- si une connexion réelle n’est pas encore disponible, noter `BLOCKED` et la raison.

## Scénario A — Création de connexions

### A1. Google Antigravity

1. Ouvrir Settings → AI.
2. Cliquer Add connection.
3. Sélectionner Google Gemini.
4. Si nécessaire, terminer la connexion Google dans le terminal Antigravity ouvert par Robb.
5. Valider la connexion.

Résultat attendu :

- connexion créée sous slug `google-antigravity` ou variante unique si slug déjà pris ;
- `authType: none` car l’identifiant reste dans le trousseau géré par Antigravity ;
- `piAuthProvider: google-antigravity` ;
- aucun champ clé API Google AI Studio n’est demandé ;
- modèle par défaut Gemini résolu ;
- validation de connexion OK.
- flux réel `agy` sandboxé et réponse Gemini reçue.

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

## Scénario C — Conservation du choix explicite

1. Choisir une connexion, un modèle et un raisonnement.
2. Envoyer successivement une question simple et une demande complexe.
3. Faire exécuter une revue `call_llm` et une sous-tâche sans override de modèle.
4. Tester une compaction et une erreur temporaire dans un profil Dev isolé.

Attendu : le fournisseur, le modèle et le raisonnement choisis restent stables.
Un modèle indisponible produit une erreur exploitable. Aucun modèle alternatif
n'est sélectionné sans paramètre explicite. Les anciens historiques restent lisibles.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

## Scénario D — Régression générale

Vérifier rapidement :

- création de session classique ;
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

- A, B, C et D passent ;
- aucun crash Electron ;
- aucun changement silencieux de modèle observé ;
- les éventuels `BLOCKED` concernent uniquement credentials/providers externes non disponibles.

## Résumé d’exécution

Date d’exécution : `____-__-__`

Validateur : `________________`

Version/commit : `________________`

| Scénario | Statut | Commentaire |
|---|---|---|
| A — Connexions |  |  |
| B — Switch manuel |  |  |
| C — Choix explicite conservé |  |  |
| D — Régression générale |  |  |
