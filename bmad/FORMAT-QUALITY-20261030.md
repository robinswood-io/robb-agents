# Qualification des formats maintenus — 30 octobre 2026

État : contrôles ciblés exécutés sur le candidat DEV ; gate global et intégration non acquis.
Aucune revue de règle n'est validée automatiquement par ce document.

## Commandes reproductibles

- `bun run lint:formats` : 1 073 fichiers CSS/HTML/JSON/YAML et 4 fichiers TOML/SQL/Make, zéro diagnostic.
- `bun test scripts/tests/format-quality.test.ts` : 5 tests, zéro échec.
- `PYTHONPATH=scripts python3 -m unittest scripts.tests.test_static_formats` : 5 tests, zéro échec.
- Typage Python des scripts : 58 fichiers, zéro erreur et avertissement avec basedpyright en mode all.
- ESLint des nouveaux contrôles et Ruff des contrôles Python : zéro diagnostic.

Les commandes utilisent les versions déclarées dans les manifests et
`scripts/python-quality-requirements.txt`. Le contrôle des formats fait partie du
lint et du typage qualité du projet. Il ne remplace pas les tests fonctionnels.

## Couverture et limites

| Format | Contrôle réel | Limite explicite |
| --- | --- | --- |
| CSS | Stylelint 17.16.0, configuration recommandée 18.0.0 | Les quatre directives Tailwind 4 sont déclarées ; leur compilation reste vérifiée par le build. |
| HTML | html-validate 11.17.0, règles recommandées | Les deux rapports historiques rendus sont des livrables archivés, déjà identifiés par le contrat source. |
| JSON | jsonc-parser 3.3.1, syntaxe stricte et clés dupliquées | Commentaires et virgules terminales autorisés seulement dans les configurations TypeScript. |
| YAML | yaml 2.9.1, analyse stricte, clés uniques, erreurs et avertissements rejetés | Ce contrôle structurel ne remplace pas la validation métier des workflows GitHub. |
| TOML | Parseur standard Python 3.15 | Syntaxe, valeurs et clés uniques ; pas de typage métier inventé. |
| SQL | SQLite en mémoire, résolution des tables et colonnes | Extensions, fichiers attachés et pragmas interdits ; budget d'instructions borné. |
| Make | GNU make en mode interrogation sur le texte lu | Aucune recette exécutée ; expansions et includes rejetés avant analyse. |

Les tests négatifs vérifient les syntaxes invalides, les doublons JSON/YAML,
les balises YAML inconnues, les propriétés CSS invalides, l'accessibilité HTML,
les colonnes SQL absentes et l'impossibilité de charger un fichier ou une extension.
Le test Make vérifie qu'une recette créant un fichier ne s'exécute jamais.

## Corrections observées

Les 34 diagnostics initiaux ont été corrigés sans désactiver de règle : structures
HTML, sélecteurs et propriétés CSS redondants, ordre des imports et sélecteurs,
et grammaire standard `corner-shape: superellipse(2)`.
La valeur effective du jeton destructive-foreground a été préservée.

Le navigateur Chromium réel a aussi révélé une lecture prématurée de l'API hôte
lors de l'import du module des miniatures. La lecture intervient désormais au rendu
de `FileThumbnail`, après le bootstrap, sans couche ou module supplémentaire.
Le playground construit s'affiche ; les notifications avec URL longue, fermeture,
mode sombre et suppression ont été exercées sans erreur JavaScript ni requête échouée.
Ce scénario utilise les données synthétiques du playground, pas une mission réelle.

Le build complet réussit. Les imports Node dans le renderer et l'avertissement
CommonJS du chemin PowerShell ont été corrigés. Les avis Vite sur la taille de
certains bundles restent visibles ; leur seuil n'a pas été augmenté.
Les autres suites, le miroir ops, le gate canonique et les missions natives restent
à qualifier avant toute intégration ou publication.
