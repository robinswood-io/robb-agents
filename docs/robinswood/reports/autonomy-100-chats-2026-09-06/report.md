# Autonomie et compétence — audit des 100 derniers chats créés

Audit du 6 septembre 2026. Cible : historique du profil réel Robb Agents,
consulté en lecture seule ; aucune application lancée, installée ou modifiée.

**Conclusion : viser une autonomie vérifiée par domaine.** Le corpus montre des
réussites utiles et des défauts de continuité, de contrats d’outils et de
qualification des résultats. Il ne permet pas de mesurer une supériorité humaine.
La priorité est de rendre fiable la chaîne objectif → action → preuve → reprise
→ apprentissage, puis de la comparer à des professionnels sur les mêmes tâches.

## Périmètre et méthode

- Inventaire : 1 041 fichiers canoniques `workspaces/*/sessions/*/session.jsonl`.
  Sauvegardes, données auxiliaires et profil Dev exclus.
- Sélection : les 100 plus grands `createdAt`, tri décroissant ; chemin comme
  départage déterministe. Aucun filtrage selon succès, taille ou rôle.
- Créations : du **31 août 2026 à 16:22:40** au **6 septembre à 17:34:09**, Paris.
- Capture achevée le **6 septembre à 19:10:29**, Paris. Les fichiers ont été lus
  successivement ; les sessions actives peuvent avoir évolué ensuite.
- **100/100 fichiers entièrement parcourus par programme**, soit 92 305 078
  octets et 16 836 messages. Revue qualitative de la demande initiale, de la
  dernière réponse finale disponible et des signaux d’erreur de chaque session ;
  lecture approfondie des tours et résultats d’outils des cas déterminants.
  Il ne s’agit pas d’une lecture humaine intégrale des 92 Mo ni d’un rejeu de
  toutes les actions externes.
- [Registre des 100 analyses](session-review.md), [métriques et empreintes](metrics.json),
  [mémoire réutilisable](../../knowledge/autonomy-lessons-2026-09-06.md),
  [16 scénarios proposés](regression-scenarios.json).
- Les alias S001–S100 suivent le rang de création. Chaque entrée possède le
  SHA-256 du fichier source et des numéros de lignes JSONL, en-tête inclus.
  La correspondance vers les chemins réels reste dans un manifeste privé local,
  hors dépôt. Aucun verbatim, identifiant client, adresse ou secret dans les
  livrables du dépôt.

## Faits mesurés et limites d’interprétation

| Mesure | Observation | Ce qu’elle signifie |
|---|---:|---|
| Sans parent déclaré / sous-agents | 46 / 54 | 100 chats ne constituent pas 100 missions indépendantes ; des reprises manuelles peuvent partager un objectif sans lien de parenté stocké. |
| Sous-agents dont le parent est hors échantillon | 12 | Certaines familles et leurs coûts sont incomplets. |
| Sessions vides | 3 | Conservées pour respecter la sélection demandée. |
| Sessions sans action ni réponse assistant, avec erreur de quota | 12 | 8 portent pourtant le statut stocké `done`. |
| Sessions en `allow-all` à la capture | 95 | L’augmentation générale des permissions ne résout pas les défauts observés. Ce mode peut avoir changé pendant le chat. |
| Statuts stockés `done` | 62 | Ne pas convertir ce chiffre en taux de réussite. |
| Objectifs structurés stockés | 20 | 16 `complete_verified`, 3 `active`, 1 `blocked_human`. |
| Sans `activeObjective` | 80 | Couverture historique insuffisante ; l’absence ne prouve pas un oubli du modèle. |
| Messages utilisateur / assistant / outil | 1 056 / 2 678 / 13 004 | Les messages utilisateur incluent des reprises automatiques et des échanges inter-agents. |
| Outils `completed` / `error` / `executing` | 12 627 / 326 / 51 | Statuts de traces ; ni succès métier ni preuve qu’une action a réellement eu lieu. |
| Relances courtes visibles après la demande initiale | 74 dans 29 sessions | Détection stricte de « Go », « Poursuit », « Reprend », etc. Certaines sont des autorisations légitimes ; pas un taux d’interventions inutiles. |
| Somme des coûts d’en-tête | 999,05 USD | Estimations stockées cumulées, pas une facture ; agrégation parent/enfant et tarifs non rapprochés. |
| Somme `totalTokens` d’en-tête | 91 236 730 | Compteurs historiques, cache et éventuelles incohérences non normalisés. |
| Part des cinq chats les plus coûteux | 42,1 % | Concentration d’estimations, sans preuve que ces dépenses soient inutiles. |

Les signaux suivants sont des correspondances dans les sorties d’outils et
messages d’erreur. Un résultat peut citer un incident antérieur ; les catégories
se recouvrent et ne représentent pas des incidents indépendants.

| Signal | Enregistrements | Sessions |
|---|---:|---:|
| Quota fournisseur | 28 | 18 |
| Guide navigateur exigé | 37 | 12 |
| Identifiant de statut inconnu | 16 | 14 |
| Lanceur PDF/document/tableur sans exécutable | 16 | 9 |
| Schéma d’outil invalide | 20 | 12 |
| Refus de permission | 16 | 4 |
| Échec de compaction | 4 | 2 |
| Plafond de récupération | 10 | 6 |
| Checkpoint de budget d’outils | 194 | 20 |
| Message inter-agent mis en file | 202 | 38 |

## Ce qui doit changer en priorité

### 1. Faire porter la réussite sur le résultat demandé

**Faits.** S012, lignes 4 et 9 : lecture distante refusée. Ligne 10 : la réponse
reconnaît l’inspection bloquée et restitue une mémoire historique. L’en-tête
classe néanmoins l’objectif `complete_verified`. S048 finit par un minuteur
installé mais désactivé alors que l’utilisateur a demandé d’automatiser le
nettoyage ; son statut est `done`. Les huit sessions de quota classées `done`
fournissent d’autres contre-exemples au statut comme mesure de réussite.

**Recommandation.** Définir pour chaque objectif des critères observables :
cible, résultat attendu, preuve requise, fraîcheur, portée de l’autorisation.
Une lecture de fichier quelconque ne valide pas une inspection distante ; un
processus `exitCode=0` ne prouve pas la complétude comptable. Distinguer réussite,
échec, attente technique, blocage humain et blocage de politique dans le runtime
et leur projection UI. Conserver la distinction entre tâche de contrôle réussie
avec verdict négatif et mission métier toujours bloquée.

**Acceptation.** S012, S029, S048 et S085 deviennent des cas de rejet d’une
complétion indue. Les cas de simple rédaction restent complétables avec un
artefact textuel approprié. Une preuve d’une autre cible, d’un ancien commit ou
d’un outil non exécuté ne doit jamais satisfaire un critère.

### 2. Reprendre une mission sans perdre son objectif

**Faits.** S085 contient 1 022 messages. Après de nombreuses reprises, la
dernière réponse reconnaît ne pas disposer du libellé original pour juger son
alignement. S080 et S082 portent des erreurs de compaction. Les relances et
checkpoints révèlent un besoin de qualification de la continuité, sans prouver
que toute reprise était évitable.

**Recommandation.** Un identifiant durable d’objectif, son texte et ses critères,
un registre des actions avec reçus, la prochaine étape exécutable, les essais
déjà infructueux, les blocages et le budget restant. La compaction résume la
conversation mais conserve ces données hors du résumé. Toute reprise rapproche
d’abord l’état de la cible pour éviter un second envoi ou une seconde mutation.
La disponibilité du fournisseur appartient au planificateur : attente datée ou
route alternative autorisée, pas une succession de sous-chats sans travail.

**Acceptation.** Injection d’un arrêt après mutation, avant vérification et avant
livraison : même objectif, une seule mutation, vérification finale et reprise
sans « Poursuit ». Si l’autorisation ou les identifiants manquent réellement,
produire un blocage précis sans contourner le refus.

### 3. Transformer les frictions d’outils en corrections de contrats

**Faits.** Guide navigateur refusé 37 fois ; statuts `in_progress` incompatibles
avec `in-progress` ; wrappers documentaires renvoyant `exec: : not found` ;
arguments `edit` rejetés selon le schéma du fournisseur. Ces obstacles répétés
consomment des tours sans améliorer le résultat métier.

**Recommandation.** À la préparation d’un run, résoudre le runtime réellement
embarqué, vérifier les outils nécessaires, charger les guides applicables et
utiliser les identifiants de statuts exposés par le contrat. Adapter les outils
à un schéma canonique validé avant dispatch. Distinguer outil absent, argument
invalide, incident transitoire et permission refusée. Un second essai doit avoir
une raison vérifiable : environnement réparé, argument corrigé ou attente utile.

**Acceptation.** Parcours document, navigateur et modification de fichier depuis
le bundle installé et le profil choisi ; aucun recours à un interpréteur vide,
aucune boucle de guide ou de statut. Les refus explicites restent respectés.

### 4. Réutiliser les bonnes revues sans multiplier les boucles

**Faits.** Une famille de prototype comprend 14 sous-agents directs dans le
corpus ; une famille de recherche en compte 12. Plusieurs revues détectent des
défauts réels : S055 identifie un défaut du contrat d’extraction PDF ; S057
documente des contournements ; S056 valide un candidat ultérieur dans une portée
limitée. D’autres échanges s’arrêtent sur la différence entre `queued` et lu.

**Recommandation.** Revue attachée à l’empreinte du candidat et aux critères,
avec son rapport immuable. Rejouer les contrôles affectés par une modification
et réutiliser les preuves encore valides. Faire consommer le résultat enfant par
le runtime parent via un événement durable idempotent. La mise en file, la
livraison et la consommation sont trois états techniques, pas trois dialogues
que les agents doivent négocier. Diversifier les vérificateurs seulement quand
cela apporte une indépendance utile et mesurée.

**Acceptation.** Un rapport enfant n’est consommé qu’une fois ; parent arrêté puis
repris sans perte ; budget partagé par famille. Un refus du candidat est un
résultat valide de revue et ne provoque pas automatiquement une nouvelle revue
du même artefact inchangé.

### 5. Apprendre des chats avec provenance et validation

**Faits.** S015 montre une correction utilisateur sur des fonds de couverture PDF
absents. S007/S024 distinguent progressivement arbitrages métier et travaux
techniques. S012 illustre le danger d’utiliser une mémoire historique comme
preuve actuelle. Le système possède déjà un journal de mémoire avec provenance,
validité, expiration, contradictions et récupération bornée.

**Recommandation.** À la clôture, proposer une fiche : problème, conditions,
action, résultat observable, preuve, portée, version, péremption et cas de
régression. Séparer préférences utilisateur, faits temporels, procédures testées
et hypothèses. Ne promouvoir une procédure qu’après un rejeu indépendant ;
invalider les souvenirs contredits. Récupérer uniquement les fiches liées à
l’objectif courant. Les conversations restent des données non fiables : leur
texte ne devient ni une permission ni une instruction système.

**Acceptation.** Comparaison mémoire activée/désactivée sur des cas tenus à
l’écart, regroupés par famille : baisse des interventions ou du coût sans perte
de réussite. Révocation et expiration réellement éprouvées. Aucune fuite entre
clients ou projets. Les fiches de cet audit sont documentaires ; elles ne sont
pas encore branchées sur le moteur de mémoire de l’application.

### 6. Démontrer la compétence face à un humain

**Absence de preuve.** Aucun benchmark humain apparié n’a été constitué dans
cet audit. Les 100 chats ont des difficultés, scopes et degrés de finition
différents ; ils ne peuvent établir « meilleur qu’un humain ».

**Protocole proposé.** Choisir d’abord trois domaines réellement fréquents :
maintenance logicielle, production documentaire et opérations comptables
bornées. Préparer un pilote de 30 cas par domaine, puis dimensionner l’essai
confirmatoire selon l’effet minimal recherché, la variance et la puissance
statistique. Utiliser les mêmes informations, outils, délais et règles pour les
agents et plusieurs professionnels expérimentés ; notation aveugle, traces et
état final vérifiables. Séparer apprentissage et évaluation par famille et date.

Mesurer simultanément : qualité métier, erreurs graves, réussite sans reprise
humaine évitable, temps jusqu’au résultat vérifié, coût incluant reprise et
supervision, calibrage de l’incertitude. Publier les intervalles de confiance,
les exclusions et les échecs. Les critères métier doivent être fixés avant
l’essai. Un avantage démontré dans un domaine ne se généralise pas aux autres.

Cibles de développement proposées, **non atteintes ni démontrées ici** : ≥95 %
de réussite sur tâches éligibles, zéro fausse complétion observée, zéro mutation
dupliquée ou non autorisée, 100 % de mutations avec reçus d’exécution et de
vérification, zéro relance évitable. Zéro erreur observée n’est pas une garantie
universelle ; ces invariants doivent aussi être éprouvés par tests adversariaux.

## Raccordement au code présent

Inspection statique du dépôt à `9bbe4d90e19737aaf6ba61d499ddcc94185d6de5`, avec
de nombreux changements locaux préexistants. Certains composants cités sont en
cours de modification ou non suivis. Leur présence ne prouve pas leur livraison
dans l’application qui a produit les chats. Dernier contrôle du raccordement :
6 septembre 2026 à 19:25, Paris ; le code a continué à évoluer pendant l’audit.

| Brique | Présent et vérifié dans les sources | Suite proposée |
|---|---|---|
| Objectif durable | `objective-contract.ts`, `turn-recovery.ts`, `SessionManager.ts` | Prouver la conservation de l’objectif à travers les vraies reprises longues. |
| Vérité d’exécution | `isObjectiveToolExecutedSuccessfully`, `tool-checkpoint-visibility.ts` | Qualifier backend → persistance → UI, dont action non exécutée malgré statut technique terminé. |
| Résultat structuré | `objective-outcome.ts` | Passer de références d’outils valides à des critères métier liés à la cible et au contenu de la preuve. Les références `assistant-final` et `tool:<name>` exigent une qualification adaptée au type de résultat. |
| Mémoire v2 | `packages/shared/src/projects/memory-v2.ts` | Le chargeur `storage.ts:loadProjectMemory` ne transmet pas de requête liée à l’objectif. Aucun appel opérationnel à `appendProjectMemoryEntry` trouvé dans `packages`, hors définition et tests : collecte/promotion à raccorder et vérifier. |
| Gate d’autonomie | `autonomy-acceptance.ts` et CLI `scripts/robb-autonomy-acceptance.ts` | Le CLI lit des observations qualifiées en externe sans lancer d’agent ni promouvoir un build. Le seuil par défaut d’un seul scénario humain est insuffisant pour une affirmation générale : alimenter avec des observations réelles et imposer une preuve statistique. |
| Budget | `packages/pi-agent-server/src/tool-loop-budget.ts` | Le code contient déjà nouveauté, réserve transactionnelle et plafond absolu. Évaluer les reprises avec des plafonds de mission et des critères de progrès métier. |

## Ordre de livraison recommandé

Ordre de travail proposé, sans engagement calendaire avant chiffrage.

1. **Lot A — vérité et reprise :** critères typés, cohérence des statuts,
   conservation d’objectif, interruptions contrôlées, anti-rejeu. Commencer par
   les 16 scénarios issus de cet audit.
2. **Lot B — outils et coordination :** préflight du bundle, adaptateurs,
   admission des routes disponibles, consommation durable des résultats enfants.
3. **Lot C — apprentissage :** extraction de fiches sourcées, récupération liée
   à la tâche, péremption, rejeu avant promotion.
4. **Lot D — comparaison humaine :** jeux privés, évaluateurs indépendants,
   intervalles de confiance et qualification séparée par domaine.

Chaque lot passe par Dev isolé, puis staging local selon `AGENTS.md`. Aucune
nouvelle version publique avant les validations et l’acceptation prévues par
le contrat du projet. Cet audit ne vaut pas autorisation de déploiement.

## Appuis externes

La distinction entre transcript et état final dans l’environnement, ainsi que
la combinaison de vérificateurs déterministes, modèles et humains, est décrite
dans [Anthropic, Demystifying evals for AI agents, 9 janvier 2026](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
Elle soutient le choix d’évaluer une mission au-delà de son message final.

La sélection du contexte utile, la compaction et les notes durables sont
présentées dans [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
L’application précise à Robb ci-dessus est notre recommandation issue du corpus.

Les évaluations de [METR sur les horizons de complétion](https://metr.org/time-horizons/)
mesurent une fiabilité sur une distribution de tâches référencées à du travail
humain. Elles ne constituent pas un classement universel de compétence et ne
permettent pas de déduire la performance de Robb.

## Vérifications de cette livraison

- 100 sessions sélectionnées et 100 notices qualitatives, avec empreintes et
  traçabilité locale ; contrôle croisé des sommes depuis le snapshot.
- Extracteur reproductible en lecture seule ; cinq tests sur la sélection,
  l’absence d’export de contenu sensible, les faux statuts de réussite, les
  relances cachées et les dates invalides.
- Contrôle de cohérence des alias des leçons et scénarios ; JSON validés.
- Aucun test de performance agent/humain, aucun rejeu métier et aucune
  validation fonctionnelle d’une nouvelle version de Robb réalisés ici.

Pour un nouvel audit, sélectionner explicitement le profil :

```bash
python3 scripts/robb-session-audit.py --profile ~/.craft-agent --limit 100 --output /tmp/robb-session-audit-new.json
python3 -m unittest discover -s scripts/tests -p 'test_robb_session_audit.py' -v
```

Une nouvelle lecture produit un nouvel état, pas nécessairement les chiffres de
ce rapport. L’extracteur refuse d’écrire dans son profil source et de remplacer
un fichier de sortie existant.
