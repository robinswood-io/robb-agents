# Réparation du démarrage du staging — 7 septembre 2026

**Robb Agents s’ouvre de nouveau.** Le candidat intact `eaf673c998b178102115adf457c931aad98902b0` est restauré dans `/Applications/Robb Agents.app`, sur le profil réel. Une fermeture complète puis une réouverture ont été effectuées, et la fenêtre a été inspectée visuellement après chacune des deux ouvertures.

## Cause prouvée

L’archive installée a été modifiée vers 11 h 21, après la livraison du staging. La tâche « Efficacité et rentabilité TRAID » (`260904-young-cloud`) avait remplacé 19 octets dans `dist/main.cjs` pour corriger la classification d’une comparaison `>=`. Elle avait recalculé les empreintes internes ASAR et re-signé le bundle, mais pas actualisé l’empreinte de l’en-tête dans `Info.plist`.

`codesign --verify --deep --strict` acceptait donc encore le bundle, tandis qu’Electron échouait avant tout démarrage applicatif : `Integrity check failed for asar archive entry '<header>'`, suivi d’un SIGTRAP. L’écart entre l’en-tête réel et la déclaration de `ElectronAsarIntegrity` est confirmé. Le défaut a été reproduit une fois avec le bundle défectueux.

## Réparation et contrôles

- Bundle défectueux conservé ; point de sauvegarde actuel des 1 087 fichiers persistants critiques, vérifié par SHA-256.
- Réinstallation du candidat complet intact, avec ses signatures et métadonnées d’origine. Le profil actuel n’a pas été remplacé par une ancienne sauvegarde.
- Arrêt de la reprise TRAID qui avait modifié l’application. Son marqueur de reprise est supprimé et la conversation reste disponible. Aucun nouveau message métier n’a été envoyé.
- Archive restaurée : `a27d9d35d14dbe8b9fd7dda225eb8d70503654ad837932da1f774961409651e4` ; empreinte de l’en-tête égale à celle déclarée dans `Info.plist`.
- Fermeture de l’ancien processus puis démarrage d’un nouveau PID, vérifiés. Liste des tâches, navigation du workspace, historique et zone de saisie visibles après réouverture.
- 1049 chats et 201800 messages présents avant réparation conservés ; aucun fichier critique manquant.
- Lecture d’un ancien historique par le serveur installé et 4 connexions authentifiées confirmées.

## Correction durable de la validation

Le validateur `scripts/validate-electron-package-security.ts` compare maintenant l’en-tête ASAR au manifeste `ElectronAsarIntegrity` de macOS. Il accepte le bundle restauré et rejette le bundle défectueux que son ancienne version acceptait. Quatre nouvelles régressions couvrent un paquet valide, une archive repackée avec empreintes internes cohérentes, une déclaration absente et des déclarations invalides.

La suite de contrats de release compte **58 tests passés** ; le contrôle TypeScript des scripts passe. `AGENTS.md` précise l’interdiction des corrections directes du bundle et l’obligation de vérifier une fermeture et une réouverture avec inspection de l’interface. Ces contrôles de construction ne constituent pas un verrou permanent sur le système de fichiers.

## État restant

La reprise TRAID demeure arrêtée. La modification de son expression régulière n’a pas été promue par un patch de l’archive : une correction fonctionnelle devra être faite dans les sources et passer par la construction officielle. L’alerte mémoire déjà observée reste présente (heap de 1,64 Go pour un seuil de 1,5 Go) ; elle est distincte de la cause de démarrage prouvée ici. Aucune publication publique n’a été effectuée.

[Résultats structurés](</Users/thibault/Documents/Robb Agents/docs/robinswood/reports/staging-launch-repair-2026-09-07/verification.json>). Les journaux natifs et captures de la seule fenêtre Robb Agents restent dans le dossier privé : `/Users/thibault/Library/Application Support/Robb Agents/Staging Backups/20260907-launch-repair/validation`.
