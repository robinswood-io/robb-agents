# Notes de source — audit Robb Agents 0.11.6

## Décision et fenêtre

- Audit local, en lecture seule ; aucun correctif, redémarrage ou changement de configuration n'a été appliqué à l'application.
- Première exécution certaine de 0.11.6 : 18 août 2026 à 10:29:57 CEST, d'après `~/.craft-agent/logs/auto-update.log`.
- Snapshot quantitatif figé : 18 août 2026 à 11:08:21 CEST (`1787044101000` ms Unix).
- Processus observé : `/Applications/Robb Agents.app`, PID 62020, démarré à 10:38:36 CEST.
- Les sessions ne stockent pas `appVersion` ou `clientVersion`. L'attribution à 0.11.6 est donc temporelle et non intrinsèque.

## Périmètre des conversations

Neuf sessions ont une activité postérieure à la borne :

1. `260818-swift-dusk`
2. `260818-young-boulder`
3. `260818-fit-spruce`
4. `260818-misty-wolf`
5. `260818-onyx-trout`
6. `260818-tall-pond`
7. `260818-vast-creek`
8. `260818-long-heron`
9. `260818-silver-titanium`

`260818-slim-cobalt` a été modifiée après installation mais n'a aucun événement postérieur à la première exécution certaine ; elle est exclue des agrégats.

Les sessions `long-heron`, `tall-pond`, `vast-creek` et `silver-titanium` ont été créées sous 0.11.6. Pour les sessions préexistantes, seuls les événements postérieurs à 10:29:57 sont attribués à cette version.

## Sources brutes

- Transcripts applicatifs : `~/.craft-agent/workspaces/my-workspace-2/sessions/260818-*/session.jsonl`
- Transcripts natifs Pi : `~/.craft-agent/workspaces/my-workspace-2/sessions/260818-*/.pi-sessions/*.jsonl`
- Journal de mise à jour : `~/.craft-agent/logs/auto-update.log`
- Bundle installé : `/Applications/Robb Agents.app/Contents/Resources/app.asar.unpacked/dist/main.cjs`
- Worktree analysé : `/Users/thibault/Documents/Robb Agents`

## Reconciliations principales

### Modèle

- 9/9 entêtes et métadonnées de routage annoncent `pi/gpt-5.6-sol`.
- 302/302 messages assistant natifs du créneau enregistrent `openai-codex`, `gpt-5.5`, `openai-codex-responses`.
- Les quatre sessions créées sous 0.11.6 enregistrent `model_change` vers `gpt-5.5` dès le démarrage.
- Test runtime en lecture seule : `resolvePiModel(..., "gpt-5.6-sol", "openai-codex")` ne résout aucun modèle ; `gpt-5.5` se résout avec une fenêtre de 272 000 tokens.

Références code :

- `packages/shared/src/config/models-pi.ts:54-114`
- `packages/pi-agent-server/src/model-resolution.ts:19-72`
- `packages/pi-agent-server/src/index.ts:480-526,639-676`
- `packages/server-core/src/sessions/SessionManager.ts:8367-8455`

### Contexte

- `young-boulder` : erreur contexte à 10:53:22, compactage à 274 742 tokens à 10:55:12, reprise à 10:55:30 ; 110,8 s jusqu'au compactage et 127,8 s jusqu'à la reprise.
- `misty-wolf` : erreur contexte à 10:58:45, compactage à 277 547 tokens à 11:00:31, reprise à 11:00:42 ; 106,1 s et 117,5 s.
- Le catalogue UI annonce 1 048 576 tokens pour GPT-5.6 ; le modèle effectivement utilisé est plafonné à 272 000.

### Coûts

Comparaison des trois sous-chats terminés et intégralement exécutés sous 0.11.6 :

| Session | Coût UI (USD) | Coût natif estimé (USD) |
|---|---:|---:|
| `long-heron` | 0,234840 | 3,046973 |
| `tall-pond` | 0,551059 | 2,475162 |
| `vast-creek` | 0,288126 | 1,928937 |
| Total | 1,074025 | 7,451072 |

L'interface capture 14,414 % de l'estimation native, soit une sous-estimation de 85,586 % et un facteur de 6,9375. Ces valeurs sont des estimations du SDK, pas la facture fournisseur.

Références code :

- `packages/shared/src/agent/backend/pi/event-adapter.ts:91-92,346-357,475-483`
- `packages/server-core/src/sessions/SessionManager.ts:9259-9278,9333-9349`

### Outils

Agrégat figé : 305 événements d'outil, 23 erreurs, soit 7,54 %, réparties dans 7/9 chats actifs.

| Session | Outils | Erreurs | Finales à la borne |
|---|---:|---:|---:|
| `swift-dusk` | 4 | 0 | 3 |
| `young-boulder` | 48 | 4 | 0 |
| `fit-spruce` | 25 | 4 | 4 |
| `misty-wolf` | 50 | 2 | 1 |
| `onyx-trout` | 56 | 6 | 1 |
| `tall-pond` | 21 | 2 | 2 |
| `vast-creek` | 37 | 4 | 2 |
| `long-heron` | 28 | 1 | 3 |
| `silver-titanium` | 36 | 0 | 0 |

Classification manuelle : au moins huit erreurs de quoting ou syntaxe Bash/SSH/Python/SQL, trois erreurs de chemin/permission, deux timeouts, une incompatibilité RTK `find`, une incompatibilité de dépendances, six retours non nuls utiles ou métier et deux erreurs API/configuration.

## Build et observabilité

- Version du bundle : 0.11.6 ; `dist/main.cjs` installé est identique au dist local au niveau SHA-256.
- Signature ad hoc, aucun TeamIdentifier, rejet de `spctl`.
- Git HEAD `9b77cf2` reste en 0.11.5 ; aucun tag local 0.11.6 ; 71 fichiers modifiés et 12 non suivis.
- Le flux stable publié expose encore 0.11.5.
- `apps/electron/src/main/logger.ts:71-75` désactive les transports fichier et console en production.
- `packages/shared/src/agent/pi-agent.ts:239-265` conserve stderr dans un tampon RAM de 8 Kio.
- `packages/shared/src/sessions/types.ts:27-69` ne persiste aucune version d'application ou de build.

## Données du graphique

Le graphique « Chats affectés par type de problème » compte des chats, pas des événements : modèle 9, outils 7, contexte 2, autorisation 1. Les catégories se chevauchent et ne doivent pas être additionnées.

## Limites

- Les sessions ont continué après le snapshot ; les compteurs ultérieurs ne sont pas mélangés avec ceux du rapport.
- La capture d'écran macOS de l'application était noire faute d'autorisation de capture. L'ergonomie visuelle et l'accessibilité n'ont donc pas été évaluées.
- L'absence de crash ou d'erreur persistée ne prouve pas l'absence d'erreur interne, compte tenu du trou de journalisation.
- Les actions externes observées ont été analysées dans les transcripts ; aucune action externe n'a été reproduite.

## Reproductibilité du livrable

- Source structurée : `report-source.json`
- Sortie : `report.html`
- Générateur : `deliver-with-overflow-fix.mjs`
- Le correctif local du générateur ajoute uniquement `overflow-x:hidden` pour contourner un débordement du bandeau `100vw` lorsqu'une barre de défilement verticale est présente.
- Vérification finale : validation, packaging et rendu passés ; vues 1440 px et 390 px ; interaction clavier du dialogue de source passée.
