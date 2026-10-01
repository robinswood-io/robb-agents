# Mission V2 — worker connecteur brokerisé

Statut : fondation et point d'injection hôte intégrés, fail-closed. Aucun adaptateur tenant n'est
instancié par défaut dans Electron ou le serveur headless; la qualification réelle reste à faire.

## Frontière d'exécution

Une work item `external-mutation` doit déclarer une `connectorInvocation` structurée : pack,
opération, ressource, payload JSON borné, niveau d'autonomie, preuve requise et stratégie de
compensation. Le schéma rejette les payloads non JSON, supérieurs à 64 Kio, trop profonds ou
contenant plus de 512 champs.

`MissionRuntimeService` continue d'utiliser le worker de session pour les lectures et les écritures
du workspace. Une mutation externe n'est admise que si un `connectorExecutorFactory` hôte injecte
un `BrokeredMissionConnectorExecutor`. Sans ce worker, la création de mission échoue avant le
démarrage.

Le worker ne crée aucune session agent et ne donne aucun accès direct au connecteur. Son chemin est :

1. préparation déterministe de la requête et de la clé d'idempotence ;
2. autorisation par `CapabilityBroker`, sans transport ;
3. décision humaine durable, signée et liée au hash exact de la requête si la policy l'exige ;
4. écriture confinée et durable de l'état `executing` ;
5. `ConnectorExecutionRuntime.invokeAuthorized()` ;
6. réconciliation fournisseur obligatoire et vérification de la preuve signée ;
7. reçu valeur-seule écrit dans `missions/<mission>/connector-executions/` puis résolu/hashé par
   la frontière de preuves Mission.

Les secrets restent dans le lease broker du runtime connecteur. Le journal du worker ne contient ni
secret, ni payload dupliqué, ni réponse fournisseur brute. États, locks et reçus refusent les IDs
hors slug, traversées, composants symlink/reparse et hardlinks; les réécritures utilisent le même
descripteur vérifié, et les reçus sont créés immuables avec `O_EXCL`.

## Reprise et absence de doublon

Après un crash en état `executing`, le worker ne rejoue jamais aveuglément. Il appelle le
`recoverMutation` fourni par l'hôte avec le hash et la clé d'idempotence exacts :

- `confirmed` doit fournir une preuve signée et réconciliée ; le résultat est finalisé sans mutation ;
- `absent` autorise un nouvel essai uniquement si cette absence est autoritative pour la clé exacte,
  et non une absence due à la cohérence éventuelle ;
- `diverged` ou `unknown` bloquent la mission et matérialisent la compensation requise.

Une décision d'approbation écrite juste avant un crash est détectée au redémarrage : la mission
`waiting-approval` est reprise, puis le broker réémet une capability uniquement si le hash, la policy,
la génération d'autorisation, l'expiration et l'identité d'approbateur concordent encore.

## Compensation

La stratégie de compensation est obligatoire dans le contrat Mission. Une divergence de
réconciliation produit l'état durable `compensation-required`; aucune compensation n'est déclenchée
automatiquement, car elle constituerait une seconde mutation. Les packs actuels déclarent une
compensation manuelle. Une future opération inverse devra passer par le même broker, avec sa propre
approbation, sa clé d'idempotence, sa réconciliation et sa preuve.

## Limites de qualification

- Aucun appel Microsoft 365, Google Workspace, Slack, CRM ou ERP réel n'est exécuté par les tests.
- Chaque intégration fournisseur doit implémenter et qualifier une lecture autoritative par clé
  d'idempotence. Sans elle, une reprise ambiguë reste bloquée.
- Les méthodes hôte d'approbation sont exposées sous RBAC dans la Control Room avec un contexte de
  consentement sans valeur brute. Cette UI ne rend pas le transport fournisseur disponible.
- Les stratégies de compensation manuelle ne démontrent pas encore un rollback métier effectif.
- La factory connecteur n'est volontairement pas créée avec une configuration implicite : policy,
  registre signé, secrets, transport sécurisé, réconciliateur et clés doivent être fournis par le
  bootstrap hôte du tenant.
- Le préflight Control Room matérialise cette absence comme des gates connecteur en échec. Il ne
  construit aucun exécuteur et ne doit jamais être interprété comme une qualification tenant.

La validation externe requise reste : un tenant Microsoft et un non-Microsoft, zéro doublon sur
1 000 reprises/basculements, et 100 % des mutations approuvées, réconciliées et compensables.
