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
  Après lancement, vérifier le commit embarqué, `~/.craft-agent/robb-electron`,
  la présence des sessions/connexions et le démarrage des MCP pertinents.
- Le paquet ad hoc de staging reste local et ne doit jamais être distribué.

### 3. GitHub Release

- Une fusion dans `main` ne constitue pas une GitHub Release.
- Ne créer une version/tag GitHub qu’après validation technique complète du
  staging local et acceptation explicite du résultat utilisateur.
- La publication publique reste fail-closed : signatures, notarisation,
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
