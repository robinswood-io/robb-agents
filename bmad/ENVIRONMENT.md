# Environnement et frontières de la release Robb 0.12.11

Cible explicitement imposée par Thibault : application desktop sur ce Mac, sans Orion.
Préparation : worktree release-v0.12.11 ; intégration : dépôt Robb Agents local.
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
Règle 48 v2.3.0 : la cible Mac autorisée et le contrat desktop priment sur
les recettes Docker/DEV distant ; aucun runtime partagé distant n'est requis ou modifié.
Le thème desktop et ses tokens existants sont conservés sous le contrat projet ;
aucune migration cosmétique Tailwind/NestJS n'est introduite par cette release.

## Prévol, promotion et preuve

Le prévol desktop officiel est scripts/robb-local-staging.py preflight, puis install/verify.
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
Après le crash WindowServer, les contrôles globaux et compilations sont réalisés sur
les runners GitHub existants. Le budget Node de 8 Gio est limité au job Linux Robb ;
le contrôleur hérite du budget hôte et termine le processus AST avant chaque lot de lint.
Le mode stage-signed utilise exactement --release (production, Developer ID, notarisation),
sans création de release GitHub. Seuls les artefacts macOS sont construits pour ce mode.
Aucun artefact development n’est relabellé ou installé dans le profil habituel.
Le run/verify canonique CI doit passer sur le commit exact avant installation locale,
puis le prévol desktop et les missions natives qualifient la cible Mac.
Le module privé préservé peut être réinjecté localement avec la même identité stable ;
il ne transite jamais par les artefacts publics ni la CI. Sa signature doit être revérifiée.
La sortie de tests synthétiques et le journal de workers sont publiables ; le rapport
canonique complet et les règles privées restent exclus des artefacts publics.
