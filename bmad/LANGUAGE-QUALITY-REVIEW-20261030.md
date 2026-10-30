# Revue des contrôles par langage — 30 octobre 2026

Cette revue décrit la portée des commandes du projet et leurs limites. Elle ne
remplace ni leur code de sortie, ni le gate sur le contenu exact. Les tests de
qualification ci-dessous sont maintenus dans le dépôt et exécutés par la suite
canonique. Le contrôleur lie la revue à leur contenu et aux commandes résolues.

## Couverture des commandes

`bun run typecheck:quality` exécute les projets TypeScript, les parseurs shell,
le typage Python et les contrôles de formats. `bun run lint` exécute les règles
IPC/outils, l'inventaire des sources, ESLint, les données JSON reconstruites,
le JavaScript généré, Ruff, les formats, les traductions et les linters shell.

| Langage | Typage ou contrôle structurel effectif | Lint effectif |
| --- | --- | --- |
| TypeScript | Configurations strictes résolues, références et couverture des sources par `typecheck:all`; contrôle canonique additionnel des options | ESLint avec les règles du projet, tous les fichiers maintenus, lots sérialisés et zéro avertissement |
| JavaScript | Le CommonJS sprintf est généré depuis sa source TypeScript stricte; `build-sprintf-vendor.ts --check` refuse toute dérive. La fixture upstream inchangée a une provenance et un chemin exact | La source TypeScript est lintée; le générateur vérifie les octets produits. Aucun JavaScript applicatif authored supplémentaire n'est soustrait |
| Python | basedpyright en mode `all`, Python 3.15, interpréteur du projet, scripts applicatifs et tests OPS inclus | Ruff sur les mêmes répertoires, règles par défaut du contrat du dépôt |
| Shell | Bash `-n` sur tous les scripts shell maintenus | ShellCheck 0.11.0, niveau `style`, sans exclusion de diagnostic |
| PowerShell | Parseur natif PowerShell 7.6.9 sur tous les `.ps1`, sans exécuter leur contenu | PSScriptAnalyzer 1.25.0, règles et sévérités par défaut; tout diagnostic fait échouer la commande |
| CSS | Parseur et contraintes des propriétés de Stylelint | Configuration recommandée, directives Tailwind explicites |
| HTML | Parseur HTML et contraintes structurelles/accessibilité | html-validate recommandé |
| JSON | jsonc-parser, grammaire et unicité des clés; reconstruction vérifiée des jeux partitionnés | Mêmes contraintes, conventions JSONC limitées aux fichiers prévus |
| YAML | Parseur strict, unicité des clés, refus des erreurs et avertissements | Même contrôle strict |
| TOML | Parseur de Python 3.15, structure et clés uniques | Même contrôle structurel |
| SQL | SQLite en mémoire, résolution des tables et colonnes, extensions/attachements interdits | Même contrôle structurel |
| Make | GNU make en mode interrogation, expansions et inclusions rejetées avant appel | Même contrôle structurel, aucune recette exécutée |

Les formats déclaratifs ne sont pas présentés comme disposant du typage
TypeScript. Les scripts PowerShell sont dynamiques : leur analyse statique ne
prouve pas une installation Windows réelle. Les contrôles installateur Windows
restent une obligation de publication distincte. Les lanceurs `.cmd`, très courts,
relèvent de cette qualification Windows et de la revue des arguments/chemins;
aucun parseur Bash n'est présenté comme un parseur de commandes Windows.

## Efficacité et tests négatifs

- `scripts/tests/format-quality.test.ts` : syntaxes, doublons et propriétés invalides.
- `scripts/tests/test_static_formats.py` : colonnes SQL absentes, extensions refusées,
  recette Make jamais exécutée et entrées déclaratives invalides.
- `scripts/tests/test_powershell_quality.py` : erreur de syntaxe, avertissement de
  lint et fichier absent font échouer le contrôle; un script valide n'est pas exécuté.
- `scripts/tests/sprintf-vendor.test.ts` : le générateur conserve le contrat CommonJS
  et refuse les dérives de son artefact; sa source reste soumise au typage strict.
- Les suites de source-quality vérifient l'interdiction des annotations non sûres
  et le comptage des lignes; le gate inspecte aussi les options TypeScript résolues.

## Environnement reproductible

Les binaires et modules utilisés sont ceux du projet, avant ceux du système dans
le PATH. Le bootstrap CI vérifie les SHA-256 des archives officielles de ShellCheck,
PowerShell et PSScriptAnalyzer, puis les installe uniquement sous RUNNER_TEMP.
Aucune confiance globale de registre ni modification système n'est nécessaire.
Les contrôles obligatoires restent actifs sur une dépendance absente ou invalide.
Le tas Node reste plafonné à 4 Gio; les validations lourdes sont sérialisées.

## État des preuves

Le lint du 30 octobre a contrôlé 3 850 fichiers JS/TS, Ruff, 1 078 fichiers de
formats et les traductions sans diagnostic. Le dernier sous-contrôle shell a
initialement sélectionné l'ancienne version système de ShellCheck; sa reprise
avec le PATH projet a contrôlé 13 scripts sans diagnostic. PowerShell a été ajouté
après cette passe : les 5 scripts passent parseur et lint, avec 19 tests du
contrôle et du bootstrap réussis, sans diagnostic. Le prochain gate
reste requis pour une attestation complète sur le candidat figé.
