# Autonomie vérifiable — implémentation du 6 septembre 2026

## Cible et portée

Code du workspace Robb Agents, destiné au canal Dev isolé. Ce lot ne lance pas l’application, ne modifie pas les profils utilisateurs, n’installe pas le staging et ne publie aucune release.

L’autonomie recherchée est la poursuite d’un objectif autorisé jusqu’au résultat vérifié, sans relance humaine pour un simple incident technique. Elle ne dispense ni d’une décision métier manquante, ni d’une authentification humaine, ni des autorisations d’effets externes. « Compétence supérieure aux humains » reste un objectif de qualification, pas un résultat revendiqué par les tests unitaires.

## Contrats livrés

| Élément | Implémentation | Vérification principale |
| --- | --- | --- |
| Qualité stable | Profil `maximum-quality` par défaut ; modèle et raisonnement conservés sur messages courts, spécialistes et reprises | `agent-cost-control.test.ts`, `task-node-routing.test.ts`, `create-managed-session.test.ts` |
| Objectif durable | Identifiant racine, dernier message, budget initial et critères persistés ; continuation courte conservée, nouveau sujet distingué | `objective-contract.test.ts`, `active-objective-persistence.test.ts` |
| Progression autonome | Empreintes de preuves et transformations ; lease fixe de 6 h, 256 passages maximum, arrêt après 2 stagnations | `turn-recovery.test.ts`, `objective-contract.test.ts` |
| Vérité d’exécution | `executed:false` et checkpoint typé traversent backend, stockage et UI ; aucune preuve ni télémétrie de succès pour ce checkpoint | `tool-execution-truth.test.ts`, adaptateurs, tests renderer et rendu `TurnCard` |
| Fin vérifiée | Reçu structuré validé par le host ; critères référencés, contrôles post-mutation et revue indépendante si requise | `objective-outcome.test.ts`, `turn-completion.test.ts` |
| Reprise après crash | Revalidation des finals déjà persistés, conservation des diagnostics de validation, faux final rétrogradé en progression | Tests d’intégration SessionManager et reprise |
| Permissions proportionnées | Classification d’effet ; lectures reconnues sans validation superflue, annotations distantes non fiables pour auto-autoriser | `tool-effect-permissions.test.ts` |
| Preuves avant risque | Sources primaires/première partie avant mutation sensible ; revue structurée avant fin | `objective-evidence-gate.test.ts` |
| Alternatives d’accès | Après échec UI, continuation vers voie structurée ; pas de répétition aveugle d’une mutation ambiguë | `autonomy-decision.test.ts`, `autonomy-browser-fallback.test.ts` |
| Fournisseurs | Quota/disponibilité distingués d’authentification/entrée invalide ; fallback limité à la politique autorisée | `failure-taxonomy.test.ts`, `routing-fallback.test.ts` |
| Qualification | Barrières distinctes pour autonomie, fausses fins, mutations et comparaison humaine | `autonomy-acceptance.test.ts`, commande d’observations |

## Protocole de fin

Les missions et demandes d’exécution terminent leur réponse par un commentaire machine `robb_objective_outcome` contenant `state`, `criteria`, `remainingWork` et `blocker`. Le commentaire est conservé en données structurées et retiré de la réponse visible. Les explications directes ordinaires ne sont pas obligées d’utiliser ce protocole.

Les quatre états sont `complete_verified`, `continue`, `blocked_human` et `blocked_policy`. Une déclaration du modèle ne constitue pas une preuve : les identifiants référencés doivent correspondre à des observations du host. Un Edit réussi ne suffit pas à prouver les contrôles ; les preuves de contrôle et de revue antérieures à une nouvelle mutation ne clôturent pas celle-ci.

Une déclaration absente, malformée ou insuffisante provoque une reprise avec les manques précis. Une fin invalide est reclassée en message intermédiaire sans duplication. Les blocages ne sont pas transmis comme réussite aux tâches dépendantes.

Le reçu prouve la présence et l’ordre de contrôles observés, pas leur pertinence universelle. Le jugement métier et la qualité réelle du livrable doivent encore être évalués sur les traces et résultats.

## Qualification sur observations réelles

Commandes locales sans fournisseur externe :

```sh
bun run test:evals:autonomy
bun run test:evals:missions
bun run test:agent-recovery
bun run typecheck:all
bun run check:autonomy:observations /chemin/observations.json
```

La dernière commande lit un tableau JSON. Chaque entrée comporte :

```json
{
  "scenarioId": "identifiant-unique-de-lexecution",
  "eligible": true,
  "objectiveRetained": true,
  "manualContinuations": 0,
  "declaredComplete": false,
  "groundTruthComplete": false,
  "mutations": [],
  "humanBenchmark": {
    "domain": "domaine-evalue",
    "agentScore": 0,
    "humanTopQuartileScore": 0
  }
}
```

Cet exemple décrit uniquement le schéma, pas une observation mesurée. Chaque mutation porte trois booléens indépendants : `authorized`, `executionReceipt`, `verificationReceipt`. Les observations invalides, nombres non finis et identifiants dupliqués sont refusés. Code de sortie : 0 si tous les seuils passent, 1 si un seuil échoue, 2 si entrée/usage invalide. La commande ne promeut aucun build.

Seuils du contrat : au moins 95 % d’objectifs éligibles terminés et vérifiés, 99 % d’objectifs conservés, aucune relance manuelle, aucune fausse fin, reçus complets pour 100 % des mutations, aucune mutation non autorisée, comparaison humaine renseignée et score strictement supérieur sur chaque scénario comparé.

Les booléens et scores sont des observations à adjuger extérieurement, pas une auto-évaluation de l’agent. Le comparateur accepte techniquement une comparaison humaine unique ; cela n’a aucune valeur de démonstration statistique générale. Pour qualifier la compétence, utiliser un corpus préenregistré représentatif, des critères identiques pour humains/agents, une évaluation indépendante à l’aveugle, des traces rejouables et un effectif suffisant par domaine. Conserver aussi latence, coût et taux de blocage légitime. Ne pas sélectionner uniquement les cas réussis.

## Limites avant promotion

La validation locale a exécuté plus de 800 tests ciblés (sessions/orchestration, permissions/adaptateurs, rendu et boucle d’outils), sans échec, ainsi que les 8 scénarios simulés de mission. La suite étendue de permissions compte également 11 cas Windows/PowerShell ignorés sur ce Mac. Le typecheck complet, la parité et le tri des traductions passent. Le lint ciblé ne présente pas d’erreur ; `SessionManager` conserve des avertissements préexistants de symboles inutilisés.

Les erreurs d’outils sans métadonnées structurées exploitables restent classifiées à partir du texte reçu. Ce lot ne prétend pas fournir un transport uniforme des statuts HTTP et délais de retry pour tous les backends et connecteurs.

Les tests de mission utilisent des scénarios simulés ; les tests de rendu n’équivalent pas à une session utilisateur sur l’application installée. Il reste à valider le parcours Dev réel, puis une fenêtre représentative de missions, et enfin le staging selon `AGENTS.md` : commit propre, sauvegarde restaurable, identité et données vérifiées, acceptation explicite avant release.
