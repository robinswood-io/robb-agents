# Évaluation sécurité et robustesse — 24 juillet 2026

## Synthèse

L’audit a identifié trois risques directement corrigeables : consommation prématurée
des validations privilégiées, conversion documentaire reposant sur une chaîne
JavaScript vulnérable et expiration concurrente des transferts fragmentés.

Les correctifs sont intégrés et vérifiés. L’audit Bun est passé de 47
vulnérabilités (2 critiques, 22 hautes, 22 modérées et 1 faible) à 0.

## Renforcements intégrés

### Validation des opérations privilégiées

- rejet des identifiants de demande déjà en attente ;
- liaison explicite de l’approbation à la session et au hash attendus ;
- conservation de la demande lorsque la session ou le hash ne correspondent pas ;
- consommation de la demande uniquement après validation complète ;
- tests de non-régression sur les doublons, les mauvaises sessions et les mauvais
  hashes.

### Conversion documentaire

- suppression de `markitdown-js` et de sa chaîne de dépendances vulnérable ;
- invocation du convertisseur Python embarqué avec `execFile`, sans shell ;
- résolution vers des chemins de confiance uniquement ;
- délai maximal de 60 secondes et sortie limitée à 10 Mio ;
- rejet des conversions vides et tests des principaux cas d’échec.

### Transferts fragmentés

- génération de timer pour neutraliser les callbacks d’expiration obsolètes ;
- rafraîchissement de la durée de vie avant et après les écritures disque ;
- test de non-régression sur les fragments reçus près de la limite d’expiration.

### Persistance des sessions et thème

- lecture incrémentale des en-têtes JSONL jusqu’à 1 Mio, au lieu de masquer les
  sessions dont les métadonnées dépassent le premier bloc de 8 Kio ;
- fermeture garantie du descripteur de fichier, y compris en cas d’erreur ;
- liaison explicite des variantes Tailwind sombres à la classe `html.dark` ;
- tests de non-régression sur les gros en-têtes et les sources CSS du thème.

### Dépendances et surfaces Electron

- mises à jour et overrides des dépendances signalées par l’audit ;
- validation plus sûre de l’origine lors des demandes de permission navigateur ;
- ouverture des URL externes filtrée par protocole ;
- contrôle des messages de supervision distante : HMAC, rejeu, expiration,
  taille, compression, limitation de débit et HTTPS hors boucle locale.

### Fiabilité de la validation

- exécution de chaque workspace de test dans un processus Bun frais afin
  d’isoler les modules, watchers et variables d’environnement ;
- isolation des suites dépendantes de la configuration globale ;
- correction des mocks de configuration et de système de fichiers qui rendaient
  le résultat dépendant de l’ordre d’exécution.

## Preuves de vérification

| Contrôle | Résultat |
|---|---|
| `bun audit` | 0 vulnérabilité |
| `npm run typecheck:all` | exit 0 |
| `npm run validate:dev` | exit 0 |
| Tests ciblés sécurité, documents, navigateur, transferts, sessions et thème | 103 réussis, 0 échec |
| Suite complète | exit 0, tous les workspaces et les 6 suites isolées réussissent |
| `npm run electron:build` | exit 0 |
| `npm run lint` | exit 0, 133 avertissements |
| `git diff --check` | exit 0 |

La validation UI officielle n’a pas été exécutée : aucun template Robb Agents ou
Craft n’est présent dans le skill Playwright officiel. Le script propre au dépôt
ne constitue pas un substitut accepté par le protocole de validation.

## Risques résiduels priorisés

### P1 — Absence de validation UI officielle

Ajouter un template Robb Agents au skill Playwright officiel, couvrant au
minimum le démarrage Electron, l’onboarding, une session, les permissions et les
réglages de gouvernance. Le critère attendu est : page chargée, 0 erreur console
et capture produite.

### P1 — Dette de lint

Résorber les 133 avertissements, en priorité les dépendances de hooks React, les
accès directs à `localStorage` et les désactivations ESLint devenues inutiles.
Faire ensuite échouer la CI sur tout nouvel avertissement.

### P1 — Garde-fous de chaîne d’approvisionnement

Ajouter à la CI :

- `bun audit` bloquant ;
- scan de secrets avec Gitleaks ;
- analyse statique CodeQL ;
- SBOM CycloneDX ou SPDX pour chaque release ;
- signature et provenance des artefacts d’installation.

### P2 — Performance et résilience

- découper les bundles Electron supérieurs à 500 kio ;
- ajouter des campagnes de fuzzing sur les enveloppes signées et les DTO RPC ;
- tester les coupures réseau et les reprises de la supervision distante ;
- définir des budgets de temps, mémoire et taille pour les opérations longues.

## Critères de sortie recommandés

Une release client doit exiger simultanément :

1. typecheck, lint sans nouvel avertissement, tests et audit avec exit 0 ;
2. validation Electron officielle avec 0 erreur console ;
3. scan de secrets et analyse statique sans finding critique ou haut ;
4. SBOM et signature des artefacts ;
5. test de reprise d’une session et d’un transfert interrompus.
