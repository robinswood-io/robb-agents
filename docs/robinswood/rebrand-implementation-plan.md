# Plan d’implémentation rebrand minimal — Robb Agents

Date de référence : 2026-07-07
Statut : Rebrand minimal + packaging Electron validés le 2026-07-07 — nom app/menu/titres renderer/WebUI/viewer/onboarding/settings visibles `Robb Agents`, backend visible `Robb Agents Backend`, config par défaut isolée `~/.robb-agents`, NOTICE/fork attribution, icônes Robinswood, catalogue source `.icon` Robinswood, bundle id `io.robinswood.robbagents`, artefacts `Robb-Agents-*`, update endpoint Robinswood, garde-fous CI. Build DMG ARM64 réel validé localement ; notarisation/signature Developer ID et compilation Liquid Glass `robinswood-Assets.car` prouvée restent à faire avant distribution externe.

## Objectif

Créer une distribution privée clairement Robinswood, tout en :

- respectant Apache 2.0 ;
- évitant toute confusion avec les marques Craft/Craft Agents ;
- minimisant les conflits avec upstream ;
- évitant un renommage interne massif des packages.

## Principes

1. Rebrand visible utilisateur d’abord.
2. Pas de renommage des packages internes sauf nécessité build/legal.
3. Garder les mentions d’attribution upstream dans NOTICE/LICENSE.
4. Documenter les écarts Robinswood.
5. Tester packaging Electron après chaque petit changement.

## Phase 1 — Surface visible

À modifier en premier :

- nom app affiché : `Robb Agents` ;
- titre fenêtre ;
- icône app ;
- écran onboarding — rebrandé dans les valeurs i18n visibles ;
- textes client-facing qui disent encore `Craft Agents` hors attribution — nettoyés pour les principales surfaces app/onboarding/settings/provider labels/WebUI/viewer/messages de passerelle.

À ne pas modifier en Phase 1 :

- noms de packages npm ;
- imports internes `@craft-agent/*` ;
- chemins techniques si non visibles ;
- nom du protocole deeplink sauf nécessité packaging — conservé à `craftagents` pour éviter une migration risquée.

## Phase 2 — Packaging

À vérifier :

- bundle identifier macOS ;
- app id Windows/Linux ;
- nom d’artefact build ;
- icônes multi-format ;
- notarisation/signature si distribution externe.

## Phase 3 — Legal / attribution

À livrer :

- conserver LICENSE Apache 2.0 ;
- ajouter/mettre à jour NOTICE Robinswood ;
- mentionner que Robb Agents est un fork privé basé sur Craft Agents OSS ;
- vérifier absence d’usage trompeur des marques Craft/Craft Agents dans surfaces commerciales.

## Tests rebrand

- build Electron macOS — validé le 2026-07-07 avec `Robb-Agents-arm64.dmg` ;
- lancement app — smoke-test packagé validé avec config isolée ;
- vérification nom dans menu app — couvert par `robinswood-branding.test.ts` ;
- vérification titres renderer — couvert par `robinswood-branding.test.ts` et Vite dev (`<title>Robb Agents</title>`) ;
- vérification icône bundle — SHA-256 de l’`icon.icns` packagé identique à `resources/robinswood-icon.icns` ;
- vérification chemin config si changé — `CONFIG_DIR` conserve l’override `CRAFT_CONFIG_DIR` mais utilise désormais `~/.robb-agents` par défaut; `window-state.json` utilise le `CONFIG_DIR` centralisé ;
- vérification onboarding — reste dans l’E2E fonctionnel complet ;
- validation CI Robinswood — verte jusqu’à `Robinswood Validate #28856581945`.

### Validation packaging du 2026-07-07

Commande build : `apps/electron/scripts/build-dmg.sh arm64`.

Commande smoke reproductible : `python3 scripts/robinswood-packaged-smoke.py --launch --launch-seconds 8`.

Résultat :

- DMG : `apps/electron/release/Robb-Agents-arm64.dmg` (`256M`) ;
- app montée : `Robb Agents.app` ;
- bundle id : `io.robinswood.robbagents` ;
- exécutable : Mach-O `arm64` ;
- signature : ad-hoc, notarisation non effectuée faute certificat Developer ID ;
- Liquid Glass : `robinswood-Assets.car` absent, fallback attendu vers `robinswood-icon.icns` ; catalogue source Robinswood présent dans `resources/robinswood-icon.icon/` ;
- smoke launch : binaire packagé démarré et stable pendant 12s avec `CRAFT_CONFIG_DIR` isolé.

### Préflight signature/notarisation

Commande non-bloquante : `python3 scripts/robinswood-signing-preflight.py`.

Commande release stricte : `python3 scripts/robinswood-signing-preflight.py --strict`.

État au 2026-07-07 :

- `xcrun notarytool` disponible via Xcode ;
- metadata `electron-builder.yml` Robinswood OK ;
- aucun certificat `Developer ID Application` détecté dans le keychain ;
- variables requises absentes : `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` ;
- matériau de signature absent : `APPLE_SIGNING_IDENTITY` ou `CSC_LINK`.

Conclusion : distribution externe macOS bloquée tant que les credentials Apple Developer / certificat Developer ID ne sont pas installés. Les builds locaux restent possibles en signature ad-hoc.

## Risques

| Risque | Mitigation |
|---|---|
| Conflits upstream massifs | éviter renommage package/import |
| Rupture auto-update/build | changer packaging en petits commits |
| Ambiguïté trademark | surfaces visibles Robinswood + attribution claire |
| Perte config existante | ne changer chemins config qu’après migration explicite |

## Ordre de commits recommandé

1. `chore: add Robinswood NOTICE attribution` — fait dans `feat: brand visible app as Robb Agents`.
2. `feat: brand app shell as Robb Agents` — fait pour app name/menu macOS.
3. `test: add Robinswood branding checks` — fait (`robinswood-branding.test.ts`).
4. `chore: add Robinswood app icons` — fait (SVG/PNG/ICNS/ICO Robinswood).
5. `build: configure Robinswood Electron bundle metadata` — fait (bundle id, productName, artifactName, maintainer, update URL).

## Critère de sortie

Le rebrand minimal est terminé quand :

- l’utilisateur voit `Robb Agents` dans les surfaces principales ;
- LICENSE/NOTICE sont propres ;
- l’app packagée démarre ;
- upstream reste mergeable sans renommage interne massif.
