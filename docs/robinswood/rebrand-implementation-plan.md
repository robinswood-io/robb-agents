# Plan d’implémentation rebrand minimal — Robinswood Agents

Date de référence : 2026-07-06

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

- build Electron macOS ;
- lancement app ;
- vérification nom dans menu app ;
- vérification icône dock/app switcher ;
- vérification chemin config si changé ;
- vérification onboarding ;
- validation CI Robinswood.

## Risques

| Risque | Mitigation |
|---|---|
| Conflits upstream massifs | éviter renommage package/import |
| Rupture auto-update/build | changer packaging en petits commits |
| Ambiguïté trademark | surfaces visibles Robinswood + attribution claire |
| Perte config existante | ne changer chemins config qu’après migration explicite |

## Ordre de commits recommandé

1. `chore: add Robinswood NOTICE attribution`
2. `feat: brand app shell as Robinswood Agents`
3. `chore: add Robinswood app icons`
4. `build: configure Robinswood Electron bundle metadata`
5. `test: add Robinswood branding checks`

## Critère de sortie

Le rebrand minimal est terminé quand :

- l’utilisateur voit `Robinswood Agents` dans les surfaces principales ;
- LICENSE/NOTICE sont propres ;
- l’app packagée démarre ;
- upstream reste mergeable sans renommage interne massif.
