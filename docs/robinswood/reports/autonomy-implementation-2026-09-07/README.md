# Autonomie : implémentation des enseignements des 100 tâches

Date : 7 septembre 2026. Cible : **Robb Agents Dev**, profils de test temporaires isolés. Référence : audit des 100 dernières tâches créées au 6 septembre, conservé séparément dans `../autonomy-100-chats-2026-09-06/`.

Les six axes ont une implémentation et des contrôles exécutables. Cela ne certifie ni une autonomie universelle, ni une supériorité humaine, ni l’état de l’application installée en production. Au terme des contrôles Dev décrits ici, aucun déploiement, remplacement de `/Applications/Robb Agents.app`, tag ou publication n’avait été effectué.

Le candidat a ensuite été installé dans le staging local : voir le [rapport de staging et ses réserves](</Users/thibault/Documents/Robb Agents/docs/robinswood/reports/staging-autonomy-2026-09-07/README.md>).

## Résultat par axe

| Axe | Comportement implémenté | Vérification principale |
|---|---|---|
| 1. Résultat métier observable | Les nouvelles demandes d’action ou de contrôle exigent des critères enregistrés avec `set_completion_criteria`. Chaque critère lie outil, paramètres de cible/version et résultat attendu. Les critères sont additifs et ne peuvent pas être abaissés en cours de tâche. | Minuteur désactivé, mauvaise cible, preuve absente, ancienne ou antérieure à une mutation partielle : fin refusée. Résultat correct : fin acceptée par SessionManager. |
| 2. Objectif durable et reprise | Le texte initial complet et les critères suivent l’objectif d’origine. Les reprises courtes conservent ce contrat. Le marqueur de reprise et la file persistent avant traitement. Les limites de temps, coût et stagnation existantes restent appliquées. | Reprise, rechargement, texte de contexte absent, contrôle après effet de bord et persistance sur disque. |
| 3. Outils fiables | Les contrats de schéma partagés, alias de statut et prérequis navigateur existants sont conservés et testés. Le wrapper Python résout aussi `CRAFT_UV=uv` via PATH. La suite documentaire vérifie le rendu réel de toutes les pages d’un PDF de test. | Parité Claude/Pi, normalisation Edit, guides après compaction, lancement sans variables de runtime, images PNG effectivement générées et inspectées. |
| 4. Coordination et revue | Accusé de réception après écriture durable, sans attendre la réponse du destinataire. Déduplication par objectif, destinataire, contenu et pièces jointes. Origine interne conservée au redémarrage. Livraisons séparées, bornées et reprises au démarrage. Revue liée à l’objectif et à l’empreinte des critères exacts. | Réessai sans double ajout, sauvegarde avant accusé, fenêtre de crash de la file, conservation des pièces jointes, refus de revue d’un autre objectif ou d’anciens critères. |
| 5. Apprentissage vérifié | Les erreurs récurrentes reconnues créent des propositions sourcées. Une autre session doit fournir un rejeu observé et un reçu de revue lié aux empreintes de la proposition et de ses preuves pour les activer. La recherche par objectif exclut propositions, souvenirs expirés, révoqués et sans correspondance. | Journal persistant, déduplication, validation indépendante, rejeu absent/non exécuté, expiration, révocation, contenu hostile cité comme données, politique mémoire du workspace. |
| 6. Comparaison humaine | Banc d’essai avec domaines déclarés, familles réservées à l’évaluation, qualité/temps/coût distincts, au moins 30 familles par domaine et 3 participants humains par cas, comparaison au quartile supérieur et borne de confiance à 95 %. Artéfacts hachés et signature Ed25519 d’un évaluateur indépendant requis. | Refus des petites séries, données synthétiques, doublons, contamination entraînement/évaluation, protocole tardif, signatures absentes, artéfacts modifiés, dépassements de budget et faux succès. |

## Contrats utilisables

Exemple d’enregistrement avant une activation autorisée :

```json
{
  "criteria": [{
    "id": "timer-active",
    "description": "Le minuteur cleanup est activé sur dev avec une prochaine exécution",
    "toolName": "mcp__ops__get_timer",
    "input": {"host": "dev", "timer": "cleanup"},
    "checks": [
      {"path": "enabled", "equals": true},
      {"path": "nextRunScheduled", "equals": true}
    ]
  }]
}
```

L’outil donné ici est un exemple de connecteur, pas un outil installé par ce changement. Le résultat doit provenir de l’outil réel indiqué. Les chemins sont des propriétés JSON, sans code exécutable ; `$text` permet une égalité exacte sur un résultat textuel complet. Le reçu final doit citer l’identifiant réel de cette observation. Un nom d’outil, une assertion de l’assistant ou une ancienne mémoire ne constituent pas une preuve du critère.

Les revues d’objectifs comportant des critères enregistrés doivent retourner `objectiveId` et `acceptanceSha256`, fournis par le contrat de l’hôte, et couvrir les identifiants des critères. La vérification indépendante reste soumise à la qualité du dossier transmis au relecteur.

`project_learning` propose les actions `propose`, `list`, `validate`, `revoke`. Une proposition reste inactive. La validation doit référencer un résultat réel de `call_llm` ou `reviewer` émis dans une autre session et lié à un rejeu réussi dans cette session. Les propositions automatiques sont limitées à trois catégories d’erreurs reconnues, 100 propositions pendantes par projet et une durée de vie bornée. Le réglage mémoire du workspace et sa rétention sont consultés à chaque utilisation de la mémoire structurée. Le fichier legacy `MEMORY.md` reste géré séparément.

Le reçu d’un message entre agents indique `receiptId` et `status` (`queued`, `processing`, `processed`, `failed`). `processed` signifie fin de traitement du message ; il ne prouve pas la réussite métier de la mission déléguée. Les pièces jointes sont copiées dans un paquet privé haché, écrit atomiquement avant le reçu. Une modification de son contenu est refusée lors d’une reprise.

## Vérifications exécutées

- `verification.json` : résultat des groupes de tests, empreintes des journaux et correspondance E01–E16. Les scénarios sont couverts par des régressions automatiques ; les événements historiques ne sont pas rejoués sur les systèmes clients.
- `validation-extra.json` : contrôle TypeScript complet, suites complémentaires et parcours Playwright dans Dev. [Capture du parcours](dev-validation.png).
- La validation UI contrôle l’isolation, vingt lectures concurrentes des paramètres, la création d’une session de test et sa présence après rechargement. Elle n’utilise aucun fournisseur réel.
- Une course de création du document de gouvernance au premier démarrage a été trouvée dans Dev et corrigée par le partage de l’initialisation en cours entre instances du même processus. Les transactions de modification conservent leur verrou et leur contrôle de révision.

Reproduire les régressions :

```sh
bun run test:autonomy:audit
bun run typecheck:all
bun run test:doc-tools
```

Les tests documentaires nécessitent les dépendances Python des wrappers. Dans un bac à sable interdisant l’écriture du cache utilisateur, fournir un `UV_CACHE_DIR` de test. Notre exécution a utilisé une copie locale du cache et `UV_OFFLINE=1`. Le lanceur de régressions isole chaque profil et évite de propager ces variables aux tests Node/Bun.

## Qualification humaine encore ouverte

Le modèle `benchmark-template.json` ne contient aucun résultat inventé. `rubric.md` décrit les éléments à compléter et figer avant les mesures. La signature de l’évaluateur atteste aussi la réalité des participants, l’aveuglement, le respect du protocole et la séparation des familles ; ces propriétés ne peuvent pas être déduites des scores seuls.

```sh
bun run check:autonomy:humans benchmark.json independent-reviewer.pub.pem
bun run check:autonomy:observations observations.json benchmark.json independent-reviewer.pub.pem
```

Ces commandes lisent et qualifient les données ; elles ne déploient rien. Les codes de sortie sont 0 (critères satisfaits), 1 (qualification refusée), 2 (entrée invalide). Sans comparaison humaine indépendante, le contrôle de promotion reste fermé même si les compteurs techniques déclarés sont favorables. Les fixtures de tests ne doivent jamais être utilisées comme mesures de performance.

## Limites à conserver visibles

- Les critères sont rédigés à partir de la demande par l’agent ; leur pertinence métier ne découle pas d’un simple égaliseur JSON. Les tâches sensibles nécessitent toujours leurs sources et leur revue indépendante.
- La livraison du message est dédupliquée. L’exécution d’une action externe après crash exige encore une clé d’idempotence du service cible ou une observation de son état. Le transport ne promet pas une exécution externe exactement une fois.
- Les objectifs historiques sans les nouveaux champs restent lisibles ; l’exigence systématique de critères s’applique aux nouveaux objectifs détectés comme action ou contrôle.
- Les refus de permission, secrets manquants, décisions métier et plafonds réels restent des limites d’autorité. L’autonomie ne crée pas d’autorisations supplémentaires.
- Le code est validé dans le workspace de développement, qui comportait des modifications préexistantes conservées. La recette du staging local et toute publication restent des étapes distinctes.
