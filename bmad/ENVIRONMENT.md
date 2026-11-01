# Environnement et frontières de la release Robb 0.12.11

Cible explicitement imposée par Thibault : application desktop sur ce Mac, sans Orion.
Préparation : checkout isolé robb-local-reconcile-20261029 sur DEV ; intégration : Robb local.
Staging : /Applications/Robb Agents.app, identité io.robinswood.robbagents,
profil ~/.craft-agent ; connexion habituelle autorisée uniquement pour nouvelles sessions QA.
Le développement Dev isolé conserve io.robinswood.robbagents.dev et ~/.craft-agent-dev.
Aucun profil fusionné, aucune écriture comptable, aucun changement des autres connecteurs.
Le module commercial local est préservé et exclu du paquet public demandé.

## Runtimes

Node 26.13.0, Bun 1.4.4, Python 3.15.2, RTK OSS 1.1.0, uv 0.13.6.
Compilation TypeScript native 7.0.2 ; API 6.0.3 pour le lint uniquement.
Les deux seules exceptions approuvées sont dans dependency-exceptions.json.
Les commandes et vérifications résolues sont dans quality-policy.json.
Règle 48 v2.7.0 : la cible Mac autorisée et le contrat desktop priment sur
les recettes Docker de déploiement. DEV sert au développement et aux validations lourdes ;
le staging desktop et sa signature restent une étape distincte sur le Mac.
Le thème desktop et ses tokens existants sont conservés sous le contrat projet ;
aucune migration cosmétique Tailwind/NestJS n'est introduite par cette release.

## Prévol, promotion et preuve

Le prévol desktop officiel est scripts/robb_local_staging.py preflight, puis install/verify.
Il exige le commit propre exact, la signature stable, le bundle cible et une sauvegarde.
Le prévol Docker du rulebook vise les montages /srv/workspace ; il ne qualifie pas
une application macOS. Cette distinction ne supprime aucun contrôle desktop.
Construire selon AGENTS.md avec Developer ID Application du trousseau existant.
Vérifier commit embarqué, processus réel, verrou du profil et présence des connexions/MCP.
L'utilisateur a déjà autorisé les arrêts/redémarrages nécessaires et la publication publique.
La signature locale reste locale ; aucune exportation de certificat privé n'est implicite.

La publication exige le même quality gate run puis verify sur le commit CI exact,
le staging local vérifié, les signatures/notarisation macOS, la politique Windows,
les checksums, la provenance et les tests installateurs. Un tag seul ne prouve rien.
Le contrôleur et ses règles restent dans le dépôt privé épinglé ; aucun secret ni
contenu de règle privée ne doit être empaqueté ou imprimé dans les logs publics.
Work non résolu : journal temporaire release-readiness-20261028.md hors dépôt,
avec artefacts techniques versionnés ici ; aucun rattachement à un projet sans rapport.

## Qualification après saturation du Mac
Après le crash WindowServer, le checkout DEV isolé exécute les contrôles et builds Linux.
Les validations lourdes sont sérialisées ; Node utilise un tas maximal de 4 Gio.
Le Mac conserve l'orchestration, les rapports et la qualification du staging signé.
Le PATH de qualification sélectionne les outils installés du projet, notamment
ShellCheck 0.11.0 et PowerShell 7.6.9, avant les versions système.
Le helper Electron du checkout DEV a reçu l'autorisation ciblée root:root / 4755 ;
la qualification conserve le sandbox Electron et ne change aucun droit du Mac.
L'exécution directe sur DEV ne vaut pas enregistrement d'un runner GitHub :
la requête des runners du dépôt ne retourne actuellement aucun runner disponible.
La publication reste soumise aux contrôles CI et aux artefacts signés ci-dessous.
Le mode stage-signed utilise exactement --release (production, Developer ID, notarisation),
sans création de release GitHub. Seuls les artefacts macOS sont construits pour ce mode.
Aucun artefact development n’est relabellé ou installé dans le profil habituel.
Le run/verify canonique CI doit passer sur le commit exact avant installation locale,
puis le prévol desktop et les missions natives qualifient la cible Mac.
Le module privé préservé peut être réinjecté localement avec la même identité stable ;
il ne transite jamais par les artefacts publics ni la CI. Sa signature doit être revérifiée.
La sortie de tests synthétiques et le journal de workers sont publiables ; le rapport
canonique complet et les règles privées restent exclus des artefacts publics.

## Job qualité du runner local

Le job de release qualité vise le label self-hosted robb-release sur DEV. Il utilise
le checkout préparé ci-dessus et une copie privée propre du contrôleur canonique
épinglé, sous /home/ubuntu/robb-release-controllers/<commit>. Cette copie est
indépendante du checkout central mutable ; son commit et sa propreté sont
vérifiés avant et après run/verify. Aucune réinitialisation du dépôt ni copie automatique de revue dans un
clone n’est effectuée. Le helper doit déjà porter les droits autorisés ; le job
local les vérifie sans les modifier. Les binaires du PATH projet sont préparés
avant activation. L’inscription éphémère du runner demeure distincte du gate direct.

## Routage de release sur les runners internes
Tous les jobs du workflow release exigent self-hosted et le label dédié robb-release.
Linux X64 utilise DEV ; macOS ARM64, macOS X64 et Windows X64 exigent chacun un
hôte natif qualifié. Les labels sont des exigences, pas une preuve de disponibilité.
Aucun repli implicite sur les runners hébergés GitHub n'est autorisé.
Les contributions externes ne doivent pas être routées vers DEV partagé : leur CI
reste distincte et son isolation doit être établie avant une migration de runners.
Le contrôleur privé épinglé est celui de la diffusion 18, commit
4d60a6151f4f44b02767032fcb49448f7709e417. Les contrôles applicatifs restent inchangés.

Le packaging Windows de la CI des pull requests exige le label distinct
robb-ci-isolated (self-hosted, Windows, X64), jamais le runner de release.
Ce label doit être réservé à une machine jetable par job, sans secrets de release,
accès au réseau privé, données utilisateur ni checkout partagé. L'isolation et
la destruction doivent être vérifiées avant enregistrement. Le jeton du job est
limité à contents:read et checkout ne conserve pas ses identifiants Git.
L'existence de ce runner Windows isolé reste à établir ; aucun hôte n'est inscrit
par la modification du workflow. Les autres jobs de tests sans packaging restent
inchangés ; leur routage n'est pas présenté comme migré.

Exception explicite du 1 novembre 2026 : Thibault autorise le build macOS local
signé et la publication pour tous les systèmes pris en charge. Builds locaux
sérialisés, tas Node plafonné à 4 Gio, arrêt sous pression mémoire ; aucun
allègement du gate, du prévol, des sauvegardes, des signatures ou des essais natifs.
