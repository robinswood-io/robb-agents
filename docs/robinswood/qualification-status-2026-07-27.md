# Statut de qualification — Fondation Missions v1

Date : 2026-07-27  
Périmètre : Robb Agents, exécution gouvernée des missions, connecteurs,
preuves, reprise, Control Room, export/restauration et chaîne de release  
Révision testée : arbre de travail local basé sur `0f6e866`

## Décision

La fondation demandée par le brief est **implantée et qualifiée localement**.
Les chemins qui ne peuvent pas encore être exécutés avec une preuve forte
restent refusés par défaut. Le statut **production-ready n'est pas accordé** :
les tenants fournisseurs, endpoints d'interopérabilité, identités de modèle,
certificats de signature et pilote client nécessaires n'étaient pas disponibles
dans cet environnement.

## Capacités livrées

- contrat Mission v1, graphe durable, checkpoints et replay en lecture seule ;
- broker de capabilities à usage unique, approbations liées au payload,
  générations de révocation et kill switches ;
- classification R0/R1/W1/W2/W3 et autonomie A0-A4, deny-by-default ;
- isolation persistée par session et passerelle centrale d'outils ;
- registre de packs connecteurs durable, signé et révocable ;
- runtime HTTP hôte avec allow-list d'origine, refus des redirects et des
  destinations privées, leases secrets tardifs et reçus rapprochés ;
- preuves d'exécution signées, idempotence stable et reprise sans duplication ;
- quarantaine des tâches restaurées et suppression des droits liés à l'hôte
  dans les bundles portables ;
- Control Room, supervision et états de gouvernance visibles dans l'interface ;
- contrats de release, SBOM, provenance, contrôles de signature et validation
  des installateurs ;
- verticale de référence de rapprochement opérationnel et financier.

## Vérifications locales exécutées

| Vérification | Résultat observé |
|---|---|
| `bun run typecheck:all` | code retour 0, tous les packages TypeScript compilent |
| `npm test` | code retour 0, toutes les suites du workspace passent |
| `bun run lint` | code retour 0, 0 erreur, 133 avertissements préexistants |
| `bun run validate:ci` | code retour 0 ; typecheck, contrats, package audit, outils documentaires, release et installateurs validés |
| `bun audit --audit-level high` | code retour 0, 0 vulnérabilité haute ou critique |
| `bun run test:recovery:campaign` | 1 000/1 000 décisions sûres, taux 1, 0 violation, p95 0,001125 ms |
| `bun run test:otlp:collector` | logs, métriques et traces corrélés ; 3 requêtes, même `eventId` |
| wrapper Playwright officiel `robb-agents` | page chargée, titre `Robb Agents`, Control Room et supervision validés, aucun débordement |
| console navigateur | 0 erreur console, 0 erreur page, 0 requête échouée |
| `git diff --check` | code retour 0 |
| scan ciblé des ajouts TypeScript interdits | aucun `any`, `as any`, `@ts-ignore` ou `@ts-expect-error` ajouté |
| scan ciblé des ajouts pour secrets à forte signature | aucune correspondance |

Capture navigateur :
`/tmp/playwright-screenshots/robb-agents-subagents-1785174592848.png`.

Le test d'installateurs exécuté par `validate:ci` passe avec un test ignoré sur
la plateforme locale. Les signatures et installations réelles multi-OS restent
donc une gate externe, et non une preuve locale implicite.

## Durcissement des dépendances

`postcss` est verrouillé sur `8.5.23`, `brace-expansion` sur `5.0.8` et `tar`
sur `7.5.22`. Comme Minimatch 3 attendait l'ancien export CommonJS callable, le
patch versionné `patches/minimatch@3.1.5.patch` accepte les deux formes d'export.
La compatibilité est vérifiée par l'installation figée, un test fonctionnel de
l'expansion d'accolades, le lint, le typecheck, la totalité des tests et les
gates CI.

`gitleaks` n'est pas installé sur l'hôte. Cette absence est déclarée ; elle
n'est pas masquée par le scan regex ciblé. Les tests de bundles couvrent en plus
la non-portabilité des droits et la quarantaine après restauration.

## Gates externes non exécutées

Les variables de qualification suivantes sont absentes :

- sandbox Microsoft : base URL et token ;
- sandbox non-Microsoft : base URL et token ;
- interopérabilité : endpoints MCP, A2A et AG-UI ;
- évaluation : fournisseurs, modèles et clés cible/judge.

Restent également nécessaires :

1. OAuth, mutations, reçus et rapprochement sur tenants Microsoft et
   non-Microsoft réels ;
2. révocation pendant une connexion réelle et campagne DNS rebinding ;
3. conformance MCP/A2A/AG-UI contre les endpoints de qualification ;
4. évaluation des modèles cible et juge identifiés ;
5. signature Developer ID, notarisation macOS, signature Windows et
   installation depuis les artefacts publiés ;
6. contrôle des quotas CPU, mémoire et disque par workers OS multi-plateforme ;
7. exercice de restauration du control plane managé ;
8. pilote client limité avec SLO observés et décision humaine documentée.

Aucun de ces points ne possède de fallback permissif. Une mutation externe
générique depuis le `TaskRunner` reste refusée jusqu'au raccordement explicite
du worker gouverné correspondant.

## Preuves associées

- architecture : `docs/robinswood/architecture/0001-enterprise-mission-boundaries.md` ;
- fondation : `docs/robinswood/enterprise-mission-foundation-v1.md` ;
- revue indépendante :
  `docs/robinswood/independent-security-review-closure-2026-07-27.md` ;
- verticale :
  `examples/missions/operational-financial-reconciliation/task.yaml` ;
- scripts et contrats de release : `scripts/` et `.github/workflows/`.

## Conclusion

Le travail local vérifiable est complet et reproductible. Le passage à un
libellé de qualification fournisseur, pilote ou production dépend uniquement
des preuves externes listées ci-dessus ; il ne doit pas être affirmé avant leur
exécution réussie et datée.
