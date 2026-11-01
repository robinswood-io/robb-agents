# Sources JSON maintenues

Ces fichiers courts définissent les données JSON volumineuses déjà utilisées par
Robb et par les outils présents dans le dépôt. Les chemins des consommateurs
restent ceux de `index.json`. Le contrôle reconstruit les mêmes valeurs JSON,
avec préservation des types scalaires, de l’ordre des listes et des métadonnées.

- Modifier les partitions du domaine concerné, puis exécuter
  `python3 scripts/json_sources.py write` pour reconstruire les fichiers consommés.
- Exécuter `python3 scripts/json_sources.py check` pour vérifier la reconstruction
  sans écriture. Ce contrôle refuse une partition absente ou trop longue.
- Lorsqu’un outil existant produit une nouvelle configuration consommée,
  `python3 scripts/json_sources.py capture` en extrait les sources à relire avant
  de versionner le changement. La capture ne modifie pas les fichiers consommés.

`header.json` conserve la structure et les métadonnées ; les listes sont réparties
par propriété dans des partitions de 450 lignes au maximum. `manifest.json`
déclare les partitions dans leur ordre exact. Les fichiers consommés sont des
sorties dérivées, identifiées individuellement dans le contrat de qualité.

Ce traitement intervient lors de la maintenance et des contrôles du dépôt.
L’exécution des missions continue à lire les mêmes chemins JSON.
