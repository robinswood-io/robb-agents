# Extension commerciale Robb Operations

## Frontière d’édition

Le dépôt MIT expose uniquement un contrat d’extension, un chargeur explicite et
les points de raccordement hôte. Il ne contient ni moteur de décision, ni
heuristiques commerciales, ni mécanisme de licence. Sans artefact explicite,
`GET_STATUS` retourne `available: false` et le comportement reste celui de
l’édition open source.

L’implémentation propriétaire est maintenue dans un dépôt Git séparé, ignoré
par le dépôt public. Un paquet commercial doit fournir un bundle absolu,
régulier et non symbolique accompagné d’un manifeste de production.

## Expérience produit

L’utilisateur choisit seulement une connexion, qui représente son compte ou
son abonnement IA. En édition commerciale, cette connexion est verrouillée pour
le planner, les workers, le reviewer et le superviseur de la mission. Aucun
fallback ne peut basculer vers un autre compte.

Le compte choisi reste le périmètre de routage du module. Le composeur existant
conserve ses contrôles ; les routes de mission déjà scellées par l'hôte ne sont
pas modifiées après leur admission.

Dans les modèles disponibles de ce compte, Robb Operations choisit localement :

- la spécialité de l’agent ;
- le niveau `fast`, `balanced` ou `best` ;
- le modèle correspondant ;
- l’effort de raisonnement ;
- les alertes de coût et éventuelles demandes de validation.

Les budgets sont consultatifs par défaut. Le statut et les réglages sont
accessibles via les canaux RPC authentifiés `operations:getStatus`,
`operations:updateSettings` et `operations:resolveApproval`. Le module persiste
ses réglages dans le profil local.

Le contrôleur Mission V2 reste l’autorité durable : il délègue les work items,
exige un reviewer indépendant par objectif, exécute une supervision finale et,
sur verdict négatif, crée des corrections liées au travail rejeté. La boucle est
bornée par `maxCorrectionCycles`, `maxTechnicalAttempts` et `maxWorkItems`.

Le module peut suggérer un compactage préventif et une revue complémentaire.
Ces indications ne remplacent pas les contrôles de compaction, de preuve et de
finalisation déjà présents dans l'hôte ; le raccordement actuel n'enclenche
pas ces deux actions à partir de la seule suggestion commerciale.

## Priorités couvertes

1. budgets session/mission/journée avec alertes non bloquantes par défaut et enforcement configurable ;
2. ledger structuré local, append-only, idempotent et chaîné par hash ;
3. récupération des tours interrompus en état `verify-before-resume` ;
4. détection de secrets avant persistance avec références `secret://` ;
5. routage adaptatif à l’intérieur du compte choisi ;
6. préflight shell typé et classification des erreurs ;
7. score de qualité et machine d’état de finalisation ;
8. provenance explicite des coûts estimés, rapportés et facturés.

## Packaging

Le build commercial produit `index.js` et `build-manifest.json`. La clé publique
Ed25519 de licence est incorporée au bundle de production ; la clé privée reste
hors des dépôts et du packaging. Le build hôte reçoit ensuite :

```bash
ROBB_OPERATIONS_BUNDLE_PATH=/chemin/absolu/index.js \
  bash apps/electron/scripts/build-dmg.sh arm64 --local-production
```

Le staging refuse un manifeste de développement, une empreinte de clé absente,
un chemin relatif ou un lien symbolique. Le bypass d’entitlement de
développement est ignoré dans une application packagée.

## Vérifications minimales avant promotion

- typecheck du contrat public, du serveur, d’Electron et du module privé ;
- tests du registre, du chargeur, du RPC/RBAC et des hooks pré-tour/pré-outil ;
- tests du ledger, de l’idempotence, des budgets, secrets, routes et licences ;
- tests Mission du worker au superviseur avec correction et plafond de boucle ;
- inspection du bundle packagé et lancement sur le profil staging production ;
- aucune publication GitHub avant validation utilisateur explicite.
