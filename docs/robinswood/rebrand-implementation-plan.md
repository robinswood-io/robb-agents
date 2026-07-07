# Plan d’implémentation rebrand minimal — Robinswood Agents

Date de référence : 2026-07-07
Statut : Rebrand minimal + packaging Electron validés le 2026-07-07 — nom app/menu/titres renderer `Robinswood Agents`, NOTICE/fork attribution, icônes Robinswood, bundle id `io.robinswood.agents`, artefacts `Robinswood-Agents-*`, update endpoint Robinswood, garde-fous CI. Build DMG ARM64 réel validé localement ; notarisation/signature Developer ID restent à faire avant distribution externe.

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

- nom app affiché : `Robinswood Agents` ;
- titre fenêtre ;
- icône app ;
- écran onboarding si nécessaire ;
- textes client-facing qui disent encore `Craft Agents` hors attribution.

À ne pas modifier en Phase 1 :

- noms de packages npm ;
- imports internes `@craft-agent/*` ;
- chemins techniques si non visibles ;
- nom du protocole deeplink sauf nécessité packaging.

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
- mentionner que Robinswood Agents est un fork privé basé sur Craft Agents OSS ;
- vérifier absence d’usage trompeur des marques Craft/Craft Agents dans surfaces commerciales.

## Tests rebrand

- build Electron macOS — validé le 2026-07-07 avec `Robinswood-Agents-arm64.dmg` ;
- lancement app — smoke-test packagé validé avec config isolée ;
- vérification nom dans menu app — couvert par `robinswood-branding.test.ts` ;
- vérification titres renderer — couvert par `robinswood-branding.test.ts` et Vite dev (`<title>Robinswood Agents</title>`) ;
- vérification icône bundle — SHA-256 de l’`icon.icns` packagé identique à `resources/robinswood-icon.icns` ;
- vérification chemin config si changé — non changé volontairement hors env de smoke-test ;
- vérification onboarding — reste dans l’E2E fonctionnel complet ;
- validation CI Robinswood — verte jusqu’à `Robinswood Validate #28856581945`.

### Validation packaging du 2026-07-07

Commande : `apps/electron/scripts/build-dmg.sh arm64`.

Résultat :

- DMG : `apps/electron/release/Robinswood-Agents-arm64.dmg` (`256M`) ;
- app montée : `Robinswood Agents.app` ;
- bundle id : `io.robinswood.agents` ;
- exécutable : Mach-O `arm64` ;
- signature : ad-hoc, notarisation non effectuée faute certificat Developer ID ;
- Liquid Glass : `robinswood-Assets.car` absent, fallback attendu vers `robinswood-icon.icns` ;
- smoke launch : binaire packagé démarré et stable pendant 12s avec `CRAFT_CONFIG_DIR` isolé.

## Risques

| Risque | Mitigation |
|---|---|
| Conflits upstream massifs | éviter renommage package/import |
| Rupture auto-update/build | changer packaging en petits commits |
| Ambiguïté trademark | surfaces visibles Robinswood + attribution claire |
| Perte config existante | ne changer chemins config qu’après migration explicite |

## Ordre de commits recommandé

1. `chore: add Robinswood NOTICE attribution` — fait dans `feat: brand visible app as Robinswood Agents`.
2. `feat: brand app shell as Robinswood Agents` — fait pour app name/menu macOS.
3. `test: add Robinswood branding checks` — fait (`robinswood-branding.test.ts`).
4. `chore: add Robinswood app icons` — fait (SVG/PNG/ICNS/ICO Robinswood).
5. `build: configure Robinswood Electron bundle metadata` — fait (bundle id, productName, artifactName, maintainer, update URL).

## Critère de sortie

Le rebrand minimal est terminé quand :

- l’utilisateur voit `Robinswood Agents` dans les surfaces principales ;
- LICENSE/NOTICE sont propres ;
- l’app packagée démarre ;
- upstream reste mergeable sans renommage interne massif.
