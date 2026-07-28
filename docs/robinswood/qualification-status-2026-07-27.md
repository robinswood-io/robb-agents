# Statut de qualification — Fondation Missions v1

Date : 2026-07-27  
Périmètre : Robb Agents, exécution gouvernée des missions, connecteurs,
preuves, reprise, Control Room, export/restauration et chaîne de release  
Révision testée : arbre de travail local basé sur `f0a55aa`

## Décision

La fondation demandée par le brief est **implantée et qualifiée localement**.
Un couple cible/juge réel est aussi qualifié sur le corpus français, et un
paquet macOS arm64 local a été construit, monté et lancé. Les chemins qui ne
peuvent pas encore être exécutés avec une preuve forte restent refusés par
défaut. Le statut **production-ready n'est pas accordé** : les tenants
fournisseurs, endpoints d'interopérabilité, certificats de signature et pilote
client nécessaires n'étaient pas disponibles dans cet environnement.

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
| tests connecteurs et interop locale | 7/7 passent : contrats fournisseurs read-only, refus auth, MCP Tasks 2025-11-25, A2A 1.0, AG-UI et flux malformés |
| évaluation réelle `anthropic/claude-sonnet-4.5` jugée par `openai/gpt-4.1` | gate PASS, 24/24, outil/policy/factualité/destructif/reprise fournisseur à 100 %, p95 9 134,62125 ms, coût moyen 0,0068 USD, couverture prix 100 % |
| paquet macOS arm64 local | DMG et ZIP construits, métadonnées/architecture validées, DMG monté, lancement isolé 12 s, code retour 0 |
| `python3 scripts/robinswood-signing-preflight.py` | configuration hardened runtime/notarisation valide ; Developer ID, matériel de signature, équipe Apple et authentification de notarisation absents |
| `gitleaks dir . --redact=100 --no-banner` avant empaquetage | 0 fuite dans l'arbre source actif |
| scan Gitleaks du paquet macOS après qualification du faux positif Baileys | 346,99 MB analysés, 0 fuite |
| wrapper Playwright officiel `robb-agents` | page chargée, titre `Robb Agents`, Control Room et supervision validés, aucun débordement |
| console navigateur | 0 erreur console, 0 erreur page, 0 requête échouée |
| `git diff --check` | code retour 0 |
| scan ciblé des ajouts TypeScript interdits | aucun `any`, `as any`, `@ts-ignore` ou `@ts-expect-error` ajouté |
| scan ciblé des ajouts pour secrets à forte signature | aucune correspondance |

Capture navigateur :
`/tmp/playwright-screenshots/robb-agents-subagents-1785174592848.png`.

Le test d'installateurs exécuté par `validate:ci` passe avec un test ignoré sur
la plateforme locale. La construction macOS prouve le contenu, le montage et le
démarrage du paquet local, pas la distribution. Les signatures et installations
réelles multi-OS restent donc une gate externe, et non une preuve locale
implicite.

## Durcissement des dépendances

`postcss` est verrouillé sur `8.5.23`, `brace-expansion` sur `5.0.8` et `tar`
sur `7.5.22`. Comme Minimatch 3 attendait l'ancien export CommonJS callable, le
patch versionné `patches/minimatch@3.1.5.patch` accepte les deux formes d'export.
La compatibilité est vérifiée par l'installation figée, un test fonctionnel de
l'expansion d'accolades, le lint, le typecheck, la totalité des tests et les
gates CI.

Gitleaks 8.30.1 est installé et sa configuration versionnée étend les règles par
défaut. Le scan de l'arbre actif trouve zéro fuite. Un client secret OAuth
Google précédemment codé en dur a été retiré : les identifiants sont maintenant
injectés par configuration et l'absence de l'un d'eux provoque un refus sûr.
Le scan d'historique conserve deux constats dans deux commits antérieurs. Leur
rotation côté Google et, si l'autorité l'approuve, la réécriture coordonnée de
l'historique Git restent obligatoires ; aucun baseline ne les masque.

Le scan du paquet a également isolé un faux positif `gcp-api-key` provenant du
dictionnaire de tokens du protocole binaire de Baileys 6.7.23. L'exception est
limitée à cette règle et au chemin exact du worker WhatsApp empaqueté. Les tests
de bundles couvrent en plus la non-portabilité des droits et la quarantaine
après restauration. Le contrôle continu analyse l'arbre source avec l'image
officielle Gitleaks 8.30.1.

## Gates externes non exécutées

Les variables de qualification suivantes sont absentes :

- sandbox Microsoft : base URL et token ;
- sandbox non-Microsoft : base URL et token ;
- interopérabilité : endpoints MCP, A2A et AG-UI ;
- bacs à sable connecteurs : fournisseur, endpoint et token ;
- interopérabilité réelle : protocole, endpoint et authentification éventuelle.

Restent également nécessaires :

1. OAuth, mutations, reçus et rapprochement sur tenants Microsoft et
   non-Microsoft réels ;
2. révocation pendant une connexion réelle et campagne DNS rebinding ;
3. conformance MCP/A2A/AG-UI contre les endpoints de qualification ;
4. qualification d'autres modèles : Gemini 2.5 Flash reste non qualifié sur la
   campagne complète malgré des succès isolés ;
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
- évaluation cible/juge qualifiée :
  `docs/robinswood/evidence/provider-eval-claude45-gpt41-priced-qualified-2026-07-27.md` ;
- paquet macOS local :
  `docs/robinswood/evidence/package-smoke-macos-arm64-2026-07-27.md` ;
- verticale :
  `examples/missions/operational-financial-reconciliation/task.yaml` ;
- scripts et contrats de release : `scripts/` et `.github/workflows/`.

## Conclusion

Le travail local vérifiable est complet et reproductible. Le passage à un
libellé de qualification fournisseur, pilote ou production dépend uniquement
des preuves externes listées ci-dessus ; il ne doit pas être affirmé avant leur
exécution réussie et datée.
