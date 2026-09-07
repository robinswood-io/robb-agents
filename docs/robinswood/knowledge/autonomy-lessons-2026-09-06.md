# Mémoire projet — autonomie et compétence

Source : [audit des 100 derniers chats créés, 6 septembre 2026](../reports/autonomy-100-chats-2026-09-06/report.md).
Portée : conception et qualification de Robb Agents et de ses parcours OSS.
Cette mémoire est documentaire ; elle ne modifie ni le modèle ni la mémoire
runtime de l’application. Les observations concernent un snapshot historique,
pas l’état présent des systèmes externes.

Lire à la demande pour les travaux d’autonomie, outils, mémoire ou évaluation.
Consulter les sources avant de considérer une observation comme toujours vraie.
Les recommandations ci-dessous doivent être évaluées, puis révisées si elles
sont contredites. Elles n’accordent aucune permission opérationnelle.

| ID | Observation sourcée | Enseignement à réutiliser | Validation / invalidation |
|---|---|---|---|
| K01 | S012 : inspection refusée, réponse de blocage, objectif stocké comme vérifié. S029 : quota seul avec `done`. | Séparer état de conversation, résultat de contrôle et résultat métier. Ne jamais apprendre qu’un statut prouve une réussite. | Contrat par critère/cible ; rejeter les preuves hors scope et les erreurs de quota comme complétion. |
| K02 | S048 : automatisation demandée, minuteur final désactivé. | Un livrable doit satisfaire le verbe de la demande : préparer, installer et activer ont des critères différents. | Vérifier état activé et prochaine exécution quand le scope l’autorise. |
| K03 | S085 : après 1 022 messages, absence du libellé original dans la preuve finale. | Garder objectif, autorisations, critères, résultats et prochaine étape hors des résumés susceptibles d’être tronqués. | Test d’interruption/compaction avec même objectif et résultat final pertinent. |
| K04 | S029, S030, S032, S035–S037, S041, S049, S053, S069, S070, S079 : échecs de quota dans la cohorte. | Vérifier disponibilité des routes avant délégation ; conserver le travail en attente ou utiliser une route équivalente autorisée. | Jamais de changement de frontière de confiance ou contournement d’un refus de sécurité. |
| K05 | S025, S055, S062 : frictions navigateur ; signaux similaires dans 12 chats. | Préparer guide et capacité navigateur avant action ; utiliser des contextes propres pour les contrôles qui l’exigent. | Ne pas confondre cache d’interface, panne d’outil et défaut de l’application ; pas de mutation durant une revue strictement passive. |
| K06 | S028, S039, S075 : erreurs des wrappers documentaires. | Vérifier les dépendances réellement embarquées du bundle choisi et produire des erreurs exploitables. | Canaris PDF, extraction et tableur ; invalider une recette si le runtime change. |
| K07 | S015 : retour utilisateur sur les fonds du PDF livré. | Valider le fichier rendu : couvertures, sauts, contenu et pièces jointes. Une propriété CSS ne prouve pas le rendu final. | Inspection du livrable exact, y compris avertissements du moteur de rendu. |
| K08 | S007, S024 : distinction entre travaux techniques et décisions métier ; S009 contient un reçu de transmission. | Prévoir un contrat métier par opération, autorisation bornée, état préalable et rapprochement après écriture. | Une recette comptable dépend du dossier, de la période et des règles en vigueur ; ne pas importer une doctrine depuis un chat. |
| K09 | S055/S051 : correction puis revue du PDF ; S057/S056 : rejet puis acceptation d’un candidat différent. | Attacher une revue à la version exacte ; préserver ses défauts comme cas de régression ; réutiliser seulement les preuves encore valides. | Une nouvelle version invalide les contrôles concernés. Un rejet correct est une réussite du contrôleur. |
| K10 | S060, S063, S076, S099 : échanges autour de `queued` et de l’accusé de réception. | Confier livraison et consommation des résultats enfants au runtime durable, avec idempotence et reprise. | Un message mis en file n’est pas une preuve de lecture ; éviter les ping-pongs d’accusés. |
| K11 | S073/S097 : validité technique et insuffisance de preuve économique explicitement séparées. | Distinguer tests, simulations, observations prospectives et résultat commercial ; calibrer l’incertitude. | Un test de logiciel n’établit pas une performance métier ni un avantage humain. |
| K12 | S021, S039, S071 : traces de livraison avec reçus ; S034 : brouillon conservé selon le scope. | Définir la preuve de livraison appropriée : artefact exact, destinataire/cible, statut externe et portée de l’action. | `SENT` prouve une émission, pas la lecture ou la satisfaction du destinataire. |

Pour chaque nouvelle fiche issue d’un chat, conserver : type épistémique
(observation, préférence, procédure testée ou hypothèse), sources et lignes,
scope projet, versions concernées, preuve de validation, conditions de péremption
et scénario de régression. Une préférence durable explicitement donnée par
l’utilisateur n’est pas traitée comme une simple inférence statistique.

La promotion automatique de mémoire, la récupération liée à l’objectif et le
benchmark humain restent des travaux à implémenter/qualifier. Ne pas considérer
l’existence de ce fichier comme leur mise en production.

État du 7 septembre 2026 : les six axes ont une implémentation Dev et une campagne de régression documentées dans [le dossier de livraison](../reports/autonomy-implementation-2026-09-07/README.md). Les tests portent sur des fixtures isolées ; la qualification humaine et la recette de production restent distinctes.

## K13 — intégrité du bundle hôte, observation du 7 septembre 2026

Une tâche a modifié directement le JavaScript installé puis re-signé le bundle, avec des empreintes ASAR internes correctes mais une déclaration `ElectronAsarIntegrity` obsolète. Résultat observé : SIGTRAP avant démarrage, malgré un contrôle de signature positif. La correction durable porte sur les sources et le pipeline de construction ; la recette doit vérifier le lien Info.plist/en-tête ASAR et une réouverture réelle. Portée : paquets Electron macOS avec validation ASAR embarquée. [Preuves et régressions](../reports/staging-launch-repair-2026-09-07/README.md). Cette observation n’autorise pas une auto-modification du bundle.
