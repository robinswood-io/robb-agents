# Contrat produit — tâche durable Robb

Date : 2026-08-12
Statut : implémenté localement ; synchronisation distante dépendante des connecteurs

## Décision

Robb reste le moteur et la source de vérité. Une tâche n’est plus seulement un
`task.yaml` exécutable : elle est matérialisée comme un objet de travail durable,
lisible par l’interface et projetable vers un cockpit externe.

Le contrat canonique est construit par
`packages/shared/src/tasks/durable-task.ts`. Le `task.yaml` conserve la définition
exécutable ; `task-meta.json` conserve les métadonnées produit mutables ; chaque
run garde son snapshot de spec, son journal append-only et ses sorties de nœuds.

```text
tasks/<slug>/
  task.yaml                         définition exécutable courante
  task-meta.json                    révision, archive, prochaine action, liens externes
  runs/<runId>/spec.json            définition immuable utilisée par le run
  runs/<runId>/run-log.jsonl        transitions, tentatives, décisions et preuves
  runs/<runId>/nodes/<nodeId>.json  résultat durable de chaque nœud
```

## Objet canonique

`DurableTaskSnapshot` expose :

- identité : `id`, `slug`, `revision`, titre et description canonique ;
- contrat : objectif, critères d’acceptation, sources et projet ;
- exécuteur : runner, agent, wrapper, modèle et connexion ;
- cycle de vie : statut, archive, dates et prochaine action ;
- Conductor : nœuds, arêtes, dépendances, état, tentative et session par nœud ;
- résultat : verdict vérifié et résumé ;
- preuve : chemins d’artefacts, hash de preuve et preuve utilisateur normalisée ;
- interop : identifiants Craft Tasks, Google Tasks et Temporal ;
- état visuel : tonalité, libellé, progression et besoin d’attention.

Les tâches historiques sont migrées paresseusement : leur premier accès crée
`task-meta.json` sans réécrire `task.yaml`. Toute mutation de métadonnées
incrémente `revision`. Un synchroniseur peut fournir `expectedRevision` ; une
écriture obsolète est refusée au lieu d’écraser une mise à jour plus récente.

## Cycle de vie et archive

Les états d’exécution sont dérivés du journal, jamais d’un texte produit par le
modèle : `ready`, `running`, `paused`, `waiting-approval`, `verifying`,
`completed`, `failed` ou `stopped`. `archived` est un état produit séparé.

Archiver :

1. est refusé tant qu’un run est actif ;
2. archive la session orchestratrice visible ;
3. renseigne `archivedAt` sans supprimer définition, sorties ni preuves ;
4. exclut la tâche de `tasks:listDurable` par défaut ;
5. reste réversible via `tasks:updateMetadata` avec `archived: false`.

## Conductor et réparation ciblée

La vue Résultats affiche le graphe et, pour chaque nœud : dépendances, état,
nombre de tentatives, session liée, sortie, références de preuve et décision de
réparation.

Une réparation ciblée crée toujours un nouveau run :

1. le run source doit être terminal ;
2. le nœud demandé et tous ses dépendants forment le front de réparation ;
3. les sorties confirmées situées hors de ce front sont réutilisées ;
4. les mutations externes exigent une approbation explicite ;
5. une mutation réutilisée exige une preuve réconciliée valide ;
6. aucune seconde exécution ne peut partager simultanément la même session
   orchestratrice.

Le run source reste immuable et les événements `run-replayed` / `node-reused`
rendent la réparation auditable.

## Cockpit externe

`tasks:getCockpitProjections` produit trois formes sans céder la propriété de
l’objet :

| Cible | Identité stable | État | Contenu |
|---|---|---|---|
| Craft Tasks | `externalRefs.craftTaskId` | todo / in-progress / done / cancelled | description, acceptation, prochaine action, progression, vérification |
| Google Tasks | `externalRefs.googleTaskId` | needsAction / completed | titre et notes de synthèse |
| Temporal | `externalRefs.temporalWorkflowId` ou ID déterministe | workflow + search attributes | révision, projet, run, critères et preuves |

Le connecteur fournisseur doit effectuer l’upsert puis enregistrer l’identifiant
retourné avec `tasks:updateMetadata`. La projection et le contrôle de concurrence
sont implémentés ; l’écriture réseau vers un tenant Craft/Google/Temporal reste
un adaptateur de déploiement, car elle requiert l’API et les credentials du client.

## Preuve utilisateur standard

Chaque résultat et rapport Markdown expose exactement cinq dimensions :

1. action demandée ;
2. action tentée ;
3. mutation appliquée ;
4. vérification utilisateur réelle ;
5. limite restante.

Une réussite de processus ou un texte du modèle n’est pas une preuve de mutation.
Les mutations reposent sur les checkpoints confirmés et, pour un système externe,
sur une preuve signée puis réconciliée.

## Serveur long-running

Le superviseur central est démarré et arrêté avec le serveur. Les runtimes Pi et
le worker WhatsApp s’y enregistrent avec propriétaire et délai maximal
d’inactivité. Il fournit :

- activité automatique sur stdin/stdout/stderr/messages ;
- arrêt de l’arbre enfant après inactivité, SIGTERM puis SIGKILL borné ;
- CPU et RSS du parent et des enfants ;
- détection des enfants directs non enregistrés sur deux relevés consécutifs ;
- état via `server:getStatus` et contrôle via `server:getHealth` ;
- rapport JSON récurrent dans `<config>/health/long-running.json`.

Variables opérateur :

- `CRAFT_AGENT_PROCESS_IDLE_TIMEOUT_MS` : inactivité maximale d’un runtime agent
  (30 minutes par défaut) ;
- `CRAFT_HEALTH_REPORT_PATH` : chemin du rapport de santé récurrent.

Le worker WhatsApp utilise 12 heures par défaut, surchargeables par
`workerIdleTimeoutMs`, car un canal connecté peut légitimement rester silencieux.

## Critères d’acceptation

- [x] une tâche historique est lisible comme `DurableTaskSnapshot` sans migration destructive ;
- [x] titre, description, acceptation, sources, projet, exécuteur et prochaine action sont exposés ;
- [x] sessions, graphe, états, résultats et preuves survivent au redémarrage ;
- [x] archive et désarchive ne suppriment aucune preuve ;
- [x] la réparation ciblée ne modifie jamais le run source et refuse les replays ambigus ;
- [x] les projections Craft/Google/Temporal conservent l’identité et la révision Robb ;
- [x] la vue Résultats rend l’objet durable, le graphe et la preuve utilisateur visibles ;
- [x] les processus enregistrés ont timeout, nettoyage d’arbre, métriques et rapport santé ;
- [ ] les upserts réels Craft/Google/Temporal sont qualifiés sur des tenants de test.
