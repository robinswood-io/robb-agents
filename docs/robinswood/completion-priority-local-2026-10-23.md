# Corrections prioritaires de complétion — staging local, 23 octobre 2026

## Cible et version

Mandat : corriger localement Robb Agents sur ce Mac, conserver le moteur simple,
puis vérifier des missions complètes avec la connexion habituelle autorisée.
Aucun déploiement distant, publication publique, nouvelle clé ou migration de profil.

Base locale : `a1177f09`, puis snapshot isolé `0447142` des cinq fichiers déjà
modifiés avant cette intervention. Ce snapshot ne constitue pas un commit dans
le dépôt principal. Les changements concurrents du dépôt principal doivent être
préservés par fusion à trois versions et contrôle de leurs empreintes avant écriture.

## Problèmes corrigés

- Le mode natif convertissait une fin prématurée en réussite. Il respecte maintenant
  le classificateur et la reprise automatique bornée existants, en direct et après
  redémarrage.
- Le journal existant des plans conserve les étapes ouvertes même si une mise à
  jour les omet. Une étape ouverte empêche la clôture ; aucun nouveau stockage,
  ordonnanceur ou moteur de planification n'est ajouté.
- Les reprises rappellent la demande initiale, les amendements acceptés et le
  travail restant. Les consignes demandent de couvrir toutes les cibles, tous les
  livrables et toutes les vérifications avant la réponse finale.
- Les critères explicitement enregistrés restent contrôlés même sans le contrat
  historique activé globalement. Leur revue indépendante existante doit couvrir
  la demande entière ; son empreinte inclut la demande et les amendements.
- Les conversations natives ne reçoivent aucun reçu JSON ni revue supplémentaire
  obligatoires. La garde existante contre les revues récursives s'applique aussi
  au mode natif ; le test de fraîcheur des revues suit cette sémantique native.
- Trois erreurs de typage préexistantes sont corrigées sans changer les droits :
  garde d'union d'autorité, prédicat de fournisseur et forme de la liste des modèles.

## Vérification exécutée

`bun test` sur les 13 fichiers des domaines complétion, reprise, critères, reçus,
revue déléguée et question native : **386 réussis, 0 échec**, 2 455 assertions.
Les nouveaux scénarios comprennent une omission d'une seconde cible, un plan
vidé, une preuve partielle, une revue FAIL, une revue périmée, une reprise native
après redémarrage, ainsi qu'une mission à deux fichiers avec reprise automatique,
vérification des octets et persistance réelle de la clôture.

Commandes effectivement exécutées avec le préfixe `rtk` :

```sh
rtk bun test packages/server-core/src/sessions/{turn-completion,plan-completion,request-coverage,objective-completion-policy,turn-recovery,objective-outcome,objective-acceptance-criteria,delegated-review-outcome,session-objective-outcome-integration,review-delegation-policy,review-delegation-integration,reviewer-collection-cache,native-question-prompt}.test.ts
rtk node scripts/run-typescript.mjs native --noEmit -p packages/server-core/tsconfig.json
rtk node scripts/run-typescript.mjs native --noEmit -p scripts/tsconfig.json
rtk bun run server:build:subprocess
rtk git diff --check
```

Le premier essai réel avec le profil Dev a échoué avant les outils : connexion
OAuth expirée. Aucun secret n'a été copié entre profils. Après le choix explicite
de la connexion habituelle, trois missions ont réussi avec le vrai modèle :

1. Lire deux cibles distinctes et conserver leurs états vrai/faux dans un livrable.
2. Produire et relire trois livrables à partir d'un CSV, calculer le total et livrer les liens.
3. Reprendre une mission, conserver le brouillon sans réécriture, livrer une version
   amendée et un manifeste dont les deux empreintes sont vérifiées indépendamment.

Le script reproductible est `scripts/robb-completion-live-check.ts`. Il crée
uniquement de nouvelles sessions QA et n'initialise pas les anciennes sessions.
Le profil habituel exige son option explicite `--local-staging`.

## Limites et livraison

Les appels réels ont utilisé le runtime de sessions sans interface Electron. Ils
ne constituent ni une validation du parcours graphique, ni un taux de réussite
général. Sans plan ou contrat explicite, la couverture de toute demande reste
une responsabilité du modèle ; les consignes seules ne la prouvent pas.

La fermeture d'un plan est une déclaration du modèle ; elle ne remplace pas
la vérification indépendante des livrables. Les scénarios QA la réalisent.
Une étape renommée doit être clôturée sous son intitulé initial pour ne pas
laisser une obligation ouverte dans le journal.

Le candidat Electron doit être construit depuis ce commit propre avec le script
officiel `build-dmg.sh arm64 --local-production`, puis installé par le helper de
staging avec sauvegarde restaurable et contrôle du commit embarqué. Une mission
utilisateur active doit atteindre un point d'arrêt sûr avant remplacement.
Le compte rendu de livraison externe précise ce qui a effectivement été installé.

Le rattachement Work n'a pas été résolu ; cette note versionnée et les preuves
locales servent de trace temporaire, sans écriture dans un projet sans rapport.
