# Pack vertical transactionnel — rapprochement opérationnel et financier

Ce dossier est le premier pack vertical qualifiable de Robb Agents. Il couvre la collecte de données CRM/ERP et documentaires, la préparation d'une correction, trois mutations externes brokerées, leur réconciliation, puis la production d'un rapport compatible avec le Proof Passport.

Deux variantes Mission V2 sont fournies :

- `mission.microsoft365.json` utilise Microsoft Graph (`microsoft365/files.update`) pour le justificatif documentaire ;
- `mission.google-workspace.json` utilise Google Drive (`googleWorkspace/drive.update`) sans modifier le graphe métier.

Les mutations CRM, ERP et documentaires passent exclusivement par `connectorInvocation` et `BrokeredMissionConnectorExecutor`. Chaque opération possède une approbation hôte durable, une clé d'idempotence dérivée du contrat, une preuve d'exécution signée, une réconciliation fournisseur et une stratégie de compensation explicite. Les politiques d'egress structurées sont fail-closed et produisent un Privacy Receipt sans valeur métier brute.

## Niveau de qualification

Le niveau livré est **`contract-offline`** : schémas, manifestes, politiques, mocks et scénarios de reprise sont vérifiés localement, sans appel réseau. Il ne constitue pas une qualification Microsoft 365, Google Workspace, CRM ou ERP sur un tenant réel. Les gates tenant restent obligatoires et sont listées dans `pack.manifest.json`.

## Vérification locale

Depuis la racine du dépôt :

```bash
bun examples/missions/operational-financial-reconciliation/validate.ts
bun test examples/missions/operational-financial-reconciliation/qualification.test.ts
```

Le validateur charge les deux Mission V2, les politiques de capacité et d'egress, les mocks contractuels et vérifie leur cohérence avec les manifestes de connecteurs du runtime. Les tests exercent aussi l'approbation avant mutation, la reprise après crash sans doublon, la divergence avec compensation obligatoire, les reçus de confidentialité et la vérification hors ligne d'un Proof Passport.

## Statut de `task.yaml`

`task.yaml` est conservé comme **référence historique TaskRunner v1** et aide à comparer l'ancien DAG. Il n'est ni la source de vérité du pack, ni un contrat Mission V2, ni une preuve de qualification. Les fichiers `mission.*.json` sont les seules spécifications exécutables par le runtime Mission V2.
