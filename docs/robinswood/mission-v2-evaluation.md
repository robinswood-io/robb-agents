# Mission V2 — protocole d’évaluation shadow-mode

## Décision supportée

Ce protocole décide si une version du control plane Mission V2 peut passer à
l’étape de shadow-mode sur des missions réelles. Il ne décide pas encore d’une
activation autonome par défaut : les garde-fous de ressources, les preuves
résolues par l’hôte et les leases multi-processus restent des portes séparées.

## KPI et garde-fous

Trois KPI primaires sont retenus :

1. **taux de réussite des scénarios** = scénarios satisfaisant tous leurs
   contrôles bloquants / scénarios exécutés ;
2. **convergence après correction** = scénarios de correction terminés avec
   tous les contrôles au vert / scénarios de correction ;
3. **fidélité de reprise** = scénarios de panne/reprise atteignant l’état
   attendu sans doublon / scénarios de reprise.

Le diagnostic opérationnel mesure la couverture de télémétrie, le P95 de
tentatives et de durée par scénario, les jetons et le coût. La durée, les jetons
et le coût du corpus déterministe sont synthétiques : ils vérifient le pipeline
de mesure. Les valeurs réelles viennent des événements de complétion des
sessions en shadow-mode.

Les garde-fous sont non compensables :

- aucune fausse réussite ;
- aucun dispatch dupliqué ;
- aucune réutilisation de session dans un contrôle qui doit être indépendant ;
- aucune preuve obligatoire manquante dans une soumission acceptée ;
- aucun dépassement de tentative, correction ou taille du graphe ;
- aucune lignée de correction invalide ;
- aucune corruption du journal projetée comme un état valide ;
- tout scénario complété avec chat d’origine réserve, accepte et livre un seul
  rapport final durable, même après un appel idempotent répété ;
- 100 % des résultats de tentative métrifiés dans le corpus de promotion.

Les seuils sont versionnés dans
`packages/server-core/src/missions/evaluation/corpus.v1.json`. Une moyenne
favorable ne peut jamais compenser un garde-fou en échec.

## Corpus v1

Le corpus couvre huit comportements reproductibles :

1. chemin nominal avec reviewer et superviseur distincts ;
2. rejet d’objectif, corrections liées et nouveau contrôle ;
3. rejet du superviseur final et réouverture de l’objectif ;
4. erreur transitoire read-only avec nouvelle identité de dispatch ;
5. reprise entre réservation durable et exécution sans nouvelle préparation ;
6. mutation ambiguë bloquée sans retry ;
7. preuve obligatoire absente, retry borné puis blocage ;
8. rejet au plafond de correction, avec échec fermé.

Un test séparé altère physiquement un journal et vérifie le rejet de sa chaîne
de checksums.

## Exécution

Campagne déterministe et rapport Markdown :

```bash
bun run test:evals:missions
```

Sortie JSON exploitable en CI :

```bash
bun run test:evals:missions --format json
```

Audit shadow d’un workspace réel, sans mutation :

```bash
bun run test:evals:missions --workspace /chemin/workspace --format json
```

La commande termine avec un code non nul si un seuil de promotion ou un
garde-fou bloque. `--output /chemin/rapport.json` persiste le rapport demandé.

## Sources de mesure

- journal Mission V2 checksummé : états, réservations, dispatches, corrections,
  verdicts, preuves et rapports ;
- événement `work-item-attempt-metered`, persisté dans le même batch atomique
  que le résultat : durée, jetons et coût observés par l’hôte ;
- projection reconstruite : bornes, indépendance, cohérence de réussite et
  couverture des preuves.

## Limites et prochaine campagne

Le corpus v1 est déterministe et orienté contrôle du runtime. Avant activation
par défaut, il faut ajouter un jeu de missions réelles anonymisées et stratifiées
(code, recherche, documents, actions externes), des preuves résolues par l’hôte,
des graders calibrés contre un échantillon humain, et des mesures de coût/latence
réelles par modèle et profil. Les seuils de performance ne devront être fixés
qu’après obtention de cette baseline ; les seuils de sûreté restent à 100 %.
