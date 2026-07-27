# Clôture de la revue sécurité indépendante — Fondation Missions v1

Date : 2026-07-27  
Relectrice indépendante : Curie (`security_review`)  
Périmètre : runtime de missions, RPC, approbations, connecteurs, secrets,
preuves d'exécution, reprise et exports  
Nature de la revue : analyse statique indépendante complétée par des tests
locaux ciblés ; aucun tenant fournisseur ni artefact signé n'a été substitué
par un mock

## Résultat exécutif

La revue a identifié neuf familles de risques : quatre critiques et cinq
élevées. Les chemins génériques locaux sont maintenant fermés par défaut et
les primitives de gouvernance sont testées. La mutation externe depuis le
`TaskRunner` reste volontairement refusée tant qu'un nœud connecteur structuré
n'est pas raccordé au runtime hôte gouverné. Cette absence de fallback est un
contrôle de sécurité, pas une preuve de qualification fournisseur.

Statut local : **les neuf constats sont fermés ou neutralisés par refus sûr**.  
Statut externe : **non qualifié** sans tenants Microsoft et non-Microsoft,
certificats de signature/notarisation et pilote client.

## Clôture des constats

| # | Sévérité | Constat indépendant | Traitement livré | Preuves locales | Résiduel explicite |
|---|---|---|---|---|---|
| 1 | critique | RPC de mission fondé sur des booléens de confiance client | `assertRequestWorkspace` puis `assertSpaceAction` sur chaque lecture, écriture, exécution, validation, approbation et kill switch | Inspection statique de `packages/server-core/src/handlers/rpc/tasks.ts` et `packages/server-core/src/handlers/rpc/tasks.execution-guard.test.ts` | La fédération OIDC/SAML d'entreprise dépend d'un fournisseur d'identité externe |
| 2 | critique | L'acceptation d'un plan pouvait élargir implicitement `safe` vers `allow-all` | `permissionModeAfterPlanApproval` maintient `ask`; `allow-all` ne survit que s'il était déjà explicite | `packages/shared/src/agent/mode-types.test.ts`, `packages/shared/src/agent/core/__tests__/pre-tool-use-task-isolation.test.ts` | Aucun |
| 3 | critique | Reçus d'approbation déclaratifs forgeables ou rejouables | `CapabilityBroker` lie l'identité, le workspace, la mission, le pack, l'opération, la cible, le payload, la policy, la génération, le budget et l'idempotency key; capability HMAC courte et à usage unique; consommation persistée par chaîne append-only | `packages/shared/src/governance/capability-broker.test.ts`, `packages/shared/src/governance/durable-use-ledger.test.ts`, `packages/shared/src/connectors/http-drivers.test.ts` | Les approbations d'une mutation W3 exigent encore un fournisseur d'identité forte réel pour être qualifiées |
| 4 | critique | URL de base ou redirection connecteur permettant SSRF/exfiltration | Origines issues du manifeste signé, validation de destination, refus d'IP privée, redirects interdits, lease secret résolue tardivement dans le runtime hôte | `packages/shared/src/connectors/http-drivers.test.ts`, `packages/shared/src/connectors/oauth.test.ts`, `packages/shared/src/connectors/sandbox-e2e.test.ts` | Le DNS rebinding doit encore être exercé contre les sandboxes fournisseurs réelles |
| 5 | élevée | Registre connecteur uniquement mémoire et révocation non propagée | `DurableConnectorPackRegistry` append-only signé, verrou inter-processus, rechargement par génération, install/rotate/revoke/uninstall et arrêt des runtimes périmés | `packages/shared/src/connectors/durable-pack-registry.test.ts`, `packages/server-core/src/services/connector-execution-runtime.test.ts` | La propagation multi-hôte nécessite le futur control plane managé |
| 6 | élevée | Idempotence liée à une tentative et preuve déclarative du modèle | Idempotency key stable par opération logique, preuve signée liée au payload et au reçu fournisseur, rapprochement obligatoire; aucun retry automatique d'une mutation ambiguë | `packages/shared/src/governance/execution-proof.test.ts`, `packages/shared/src/tasks/mission-control.test.ts`, `packages/server-core/src/tasks/TaskRunner.test.ts` | Le `TaskRunner` refuse encore les mutations externes au lieu de les router implicitement |
| 7 | élevée | Kill switches optionnels et absence de drain déterministe | Registre durable global/workspace/mission, vérification avant dispatch et interruption d'un travail en vol | `packages/shared/src/governance/kill-switch-registry.test.ts`, `packages/server-core/src/tasks/TaskRunner.test.ts` | La diffusion multi-hôte relève du futur service managé |
| 8 | élevée | Credentials globaux, collisions, courses et suppression après erreur de déchiffrement | Clés segmentées par workspace et finalité, création atomique, permissions `0600`, verrou de writer et quarantaine du fichier illisible sans destruction de l'original | `packages/shared/src/credentials/backends/secure-storage.test.ts`, `packages/shared/src/governance/workspace-governance-store.test.ts`, `packages/server-core/src/tasks/execution-proof-runtime.test.ts` | La rotation d'un coffre central externe n'est pas testable sans ce coffre |
| 9 | élevée | Secrets et contenus externes bruts dans sessions, résultats ou exports | Les leases ne contiennent pas de valeur, les preuves ne contiennent que des hashes et reçus bornés, les événements utilisent des références, et l'isolation de session persiste l'enveloppe de confiance. Un bundle portable retire les droits liés à l'hôte ; une session de tâche importée est placée en quarantaine jusqu'à une nouvelle admission par le `TaskRunner`. | `packages/shared/src/credentials/secret-lease-broker.test.ts`, `packages/shared/src/governance/execution-proof.test.ts`, `packages/shared/src/sessions/__tests__/execution-isolation-persistence.test.ts`, `packages/shared/src/sessions/__tests__/bundle.test.ts` | Les scans sur exports de tenants réels restent une gate de qualification |

## Invariants de sécurité vérifiés localement

1. Une opération non classée est refusée.
2. Une policy peut relever un risque signé, jamais l'abaisser.
3. Une approbation est liée au payload canonique et ne vaut qu'une fois.
4. Une capability périmée, altérée, révoquée ou de génération ancienne est refusée.
5. Un connecteur révoqué arrête les runtimes déjà chargés.
6. Un secret n'entre ni dans la capability ni dans la preuve d'exécution.
7. Une destination finale hors origine signée ou une redirection est refusée.
8. Un contenu de modèle ne constitue jamais une preuve de mutation.
9. Une mutation ambiguë n'est jamais rejouée automatiquement.
10. Une reprise de mission ne réutilise qu'un checkpoint confirmé et vérifié.
11. Les kill switches sont vérifiés avant dispatch et pendant le travail.
12. Les écritures locales restent dans les chemins réels autorisés; les
    traversées et échappements par lien symbolique sont refusés.
13. Les outils réseau, processus, navigateur, MCP direct et sous-agents sont
    refusés dans une session de tâche isolée.
14. `allow-all` ne contourne pas l'enveloppe d'isolation persistée.
15. Un nœud en lecture ne reçoit aucun chemin d'écriture.
16. Une demande de CPU ou mémoire explicite est refusée en l'absence de worker
    OS capable de l'imposer.
17. Une mutation externe du `TaskRunner` est refusée tant que le runtime
    connecteur hôte n'est pas raccordé par un contrat structuré.
18. Un export portable ne transporte aucun droit d'exécution lié à l'hôte ;
    une tâche restaurée reste en quarantaine jusqu'à réautorisation locale.

## Campagne de reprise

Les tests locaux couvrent 1 000 checkpoints de mutation ambiguë. Le résultat
attendu et vérifié est une seule émission initiale par checkpoint et zéro
nouvelle émission lors de la reprise. La reprise se termine en revue ou en
échec sûr, jamais par une seconde mutation externe.

Références :

- `packages/shared/src/tasks/durable-execution.test.ts`
- `packages/server-core/src/tasks/TaskRunner.test.ts`

## Limites de qualification

Les éléments suivants ne sont pas déclarés « terminés en production » :

- flux OAuth, mutations et rapprochements contre un tenant Microsoft réel ;
- même campagne contre un système non-Microsoft réel ;
- DNS rebinding et révocation pendant une connexion fournisseur réelle ;
- exécution sous quota CPU/mémoire/disque par worker OS multi-plateforme ;
- signature macOS, notarisation, signature Windows et installation depuis les
  artefacts effectivement publiés ;
- exercice de sauvegarde/restauration sur un control plane managé ;
- pilote client limité avec SLO observés.

Ces gates requièrent des dépendances externes. Elles ne sont pas contournées et
ne disposent d'aucun chemin permissif de secours.
