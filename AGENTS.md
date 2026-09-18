# Instructions projet — Robb Agents

## Contrat de développement et de promotion

Toujours identifier explicitement la cible avant de lancer, construire ou
installer l’application. Les trois niveaux suivants ne sont pas
interchangeables.

### 1. Développement courant

- Utiliser **Robb Agents Dev** avec l’identité
  `io.robinswood.robbagents.dev` et le profil isolé `~/.craft-agent-dev`.
- `bun run electron:dev` et les paquets de développement ne doivent jamais
  lire, modifier ou remplacer le profil production `~/.craft-agent`.
- Ne jamais installer un paquet development-channel à la place de
  `/Applications/Robb Agents.app`.

### 2. Staging local sur ce Mac

- L’application `/Applications/Robb Agents.app` sert aussi de staging local
  avant une nouvelle GitHub Release.
- Ce staging utilise volontairement l’identité production et les données
  réelles dans `~/.craft-agent` afin de valider chats, connexions, état
  navigateur et MCP dans les conditions utilisateur.
- Construire ce candidat uniquement depuis un commit propre avec :
  `bash apps/electron/scripts/build-dmg.sh arm64 --local-production`.
- Avant remplacement, conserver une sauvegarde restaurable du bundle installé.
  Utiliser `python3 scripts/staging-retention.py --backup-app` : copie temporaire,
  vérification de signature, publication du checkpoint puis conservation des
  deux sauvegardes les plus récentes seulement. Ne jamais créer une copie en
  cours directement dans un dossier daté : utiliser le préfixe `.partial-`.
  Le nettoyage récurrent est installé par
  `python3 scripts/install-staging-retention.py` (LaunchAgent de l’utilisateur).
  Après lancement, vérifier le commit embarqué, `~/.craft-agent/robb-electron`,
  la présence des sessions/connexions et le démarrage des MCP pertinents.
- Le paquet ad hoc de staging reste local et ne doit jamais être distribué.
- Ne jamais corriger directement `app.asar` ou un exécutable du bundle installé :
  modifier les sources et reconstruire depuis un commit propre. Une nouvelle
  signature seule ne met pas à jour `ElectronAsarIntegrity` dans `Info.plist`.
- La recette doit vérifier cette empreinte d’en-tête avec
  `scripts/validate-electron-package-security.ts`, puis une fermeture complète
  et une réouverture avec contrôle visuel de l’interface.
- Les processus d’agents et MCP locaux sur macOS doivent conserver la protection
  du bundle imposée par `application-protection.ts`, y compris en mode Execute.
  Aucun réglage, retry ou contournement via un autre processus ne doit désactiver
  cette protection. Un échec du contrôle de protection bloque les agents.

### 3. GitHub Release

- Une fusion dans `main` ne constitue pas une GitHub Release.
- Ne créer une version/tag GitHub qu’après validation technique complète du
  staging local et acceptation explicite du résultat utilisateur.
- La publication publique reste fail-closed : signature et notarisation macOS,
  politique de signature Windows explicite (`unsigned`, `pfx` ou `azure`),
  checksums, provenance et parcours installateur CI doivent tous être verts.

## Garde-fous

- Ne pas copier ou fusionner `~/.craft-agent-dev` et `~/.craft-agent` pour
  corriger une confusion de cible ; sélectionner le bon canal de build.
- Ne jamais qualifier le profil development d’erreur : son isolation est le
  comportement attendu. L’erreur est d’installer ce bundle sur la cible
  production/staging.
- Préserver les données et worktrees existants. Toute migration de schéma à
  risque nécessite une sauvegarde distincte et une vérification de retour
  arrière.

Références : `CONTRIBUTING.md` et
`docs/robinswood/market-roadmap-execution-plan-2026.md`.

## Confidentialité du routage automatique

- Les fonctions de routage automatique des fournisseurs, modèles et niveaux de
  raisonnement, ainsi que leurs bascules automatiques, sont réservées à notre
  usage privé. Leur code ne doit pas faire partie de la branche principale
  publique, même derrière un réglage désactivé.
- Développer et conserver ces fonctions uniquement sur une branche privée
  destinée au dépôt privé, avec protection de branche vérifiée. Une branche
  protégée dans un dépôt public ne rend pas son contenu confidentiel.
- Tant que la protection serveur du dépôt privé est indisponible, ne pas
  présenter les gardes locaux comme une protection GitHub équivalente. Ne jamais
  rendre le dépôt privé public pour contourner cette limitation.
- Ne pas publier de commit de staging privé, ni mélanger son historique dans une
  PR publique. Préparer les correctifs publics depuis la branche publique et
  vérifier séparément l'absence de routage automatique.
