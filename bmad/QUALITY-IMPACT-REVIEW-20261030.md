# Revue d’impact du candidat Robb — 30 octobre 2026

## Portée et statut

Cette revue complète RELEASE-QUALITY-REVIEW-20261028.md. Les observations historiques
restent datées ; elles ne prouvent pas une exécution sur le candidat courant.
Le dépôt est le checkout isolé robb-local-reconcile-20261029 sur DEV. La cible
livrée reste Robb sur le Mac, puis la version publique sans module Inqom.
Ni publication, ni installation, ni réussite du gate ne sont attestées par cette revue.

La diffusion 8 du Rulebook, commit fb80719345513a7486d0b47e7fd6018c717dcc2d,
est la référence courante. Les empreintes logiques et versions des exigences sont
liées au contenu exact par quality-policy.json. Aucune règle privée n’est copiée ici.

## Revue des changements et réutilisation

Les changements concernent le typage, le découpage des sources et tests, la restauration
des modules OPS manquants, les documents Python 3.15, les contrôles multilangages,
les dépendances compatibles et les fixtures multiplateformes. Les modifications
concurrentes antérieures restent conservées ; les validations lourdes sont sérialisées.
Les règles sans changement d’exigence conservent leur analyse précédente après cette
revue de périmètre. Une nouvelle empreinte de portée ne transforme pas une preuve
ancienne en résultat courant : les commandes du gate doivent réussir à nouveau.

Les profils spécialisés du catalogue ne sont pas invoqués. Un agent généraliste
à coût réduit participe bien aux lots Python et à la revue ; l’ancienne mention
« aucun agent délégué » est donc corrigée. Leurs garanties transversales restent
couvertes par les règles globales. Aucun service Night Agent n’a été installé.
Les modules OPS sont qualifiés avec profils QA synthétiques et transports simulés.
Les paramètres privés de déploiement ne sont ni inventés ni publiés. L’audit
structurel historique refuse les données absentes et ne devient pas un feu vert
artificiel pour un déploiement auquel il n’a pas accès.

## Exigences transversales renouvelées

- Règle 50 v1.4.0 : typage maximal, absence d’annotations any, 500 lignes de code
  et tests, diagnostics bloquants, versions compatibles et preuve par langage.
  LANGUAGE-QUALITY-REVIEW-20261030.md détaille les contrôles et tests négatifs.
  Les artefacts générés/vendor restent une liste exacte avec provenance ; aucun
  répertoire de code maintenu n’est exempté. Aucun seuil de warning n’est relevé.
- Règle 48 v2.4.0 : mandat conservé, actions proportionnées, autorisations sensibles
  séparées. Le seul helper Electron du checkout DEV a reçu l’accord utilisateur
  pour root:root / 4755. Aucun droit du Mac ou autre connecteur n’est modifié.
  L’accès technique ne donne pas de droit sur les données comptables réelles.
- Règle 43 : commandes et diagnostics via RTK, sorties brutes conservées ; une
  troncature ou un résumé n’est jamais compté comme réussite de contrôle.
- PROCESS : préparation isolée, contrôles du checkout exact, prévol desktop avant
  intégration, qualification réelle et distinction entre testé et livré.
- ARTIFACTS : périmètre, commandes, résultats et limites sont conservés dans les
  reçus et journaux ; le suivi Work non résolu utilise la trace privée temporaire.
- PROJECT-POLICY : ENVIRONMENT.md précise la cible desktop, les commandes et
  autorisations existantes. Aucun champ de fichier n’accorde de permission.

## Résultats acquis et limites

Le typage Python frais analyse 266 fichiers sans erreur, avertissement ou information.
La suite OPS fraîche exécute 54 modules et 474 tests sans échec, avec les avertissements
Python traités en erreurs. Les 5 scripts PowerShell passent analyse syntaxique et lint ;
19 tests vérifient leurs contrôles et le bootstrap isolé des outils.
La suite JavaScript/Electron précédente a réussi 11 071 tests avec 32 skips distincts.
Ces résultats précèdent la dernière mise à jour de dépendances et ne dispensent pas
d’une nouvelle qualification du candidat. Les tests installateur Windows, le staging
Mac et les missions avec connexion habituelle restent des étapes distinctes.

Le bootstrap ShellCheck, PowerShell et PSScriptAnalyzer vérifie les archives officielles
par SHA-256 dans un répertoire temporaire ; aucune installation globale ni sudo.
Les mises à jour du 30 octobre restent dans les mêmes majeures : Tiptap 3.32.2,
Motion 14.9.0, ESLint 10.14.0, ACP SDK 2.2.0, node-html-parser 9.0.6 et
react-resizable-panels 4.15.3. Bun 1.4.4 régénère le lock sans scripts d’installation.
Les seules exceptions humaines restent TypeScript API 6.0.3 et Baileys 7.0.0-rc14.

## Écarts du catalogue et contrôles effectifs

La revue du catalogue relève 31 changements d’empreinte : 17 profils spécialisés
non invoqués, 11 règles globales et les trois documents BMAD. Les règles de
profil gardent leur non-applicabilité propre ; elles ne dispensent pas des règles
transversales. Les modifications sans changement de domaine sont réévaluées :

- Interdiction any v1.0.1 : source-quality et analyse TypeScript couvrent les sources
  maintenues ; le code des tests fait partie de cet inventaire.
- Stack standard v2.0.1 : audit npm/PyPI/runtimes frais obligatoire après les mises
  à jour ; conserver les deux exceptions humaines sans élargissement implicite.
- Dépréciation de packages v1.0.1 : aucune dépublication ou dépréciation d’un package
  publié n’est engagée. Les changements sont internes au workspace.
- Healthchecks Docker et résilience reverse proxy v1.0.1 : aucun service conteneur,
  proxy ou réseau partagé modifié. Les contrôles runtime desktop restent requis.
- Observabilité v1.0.1 : les erreurs restent visibles, classées sans divulguer les
  données privées, et les journaux de contrôle conservent leur code retour.
- Prévention d’erreurs v1.0.1 : validation des entrées, refus des scans incomplets,
  approbations liées au contenu, tests négatifs et reprises idempotentes.
- GitHub Actions v1.0.1 : bootstrap isolé, caches de binaires avec empreintes,
  mémoire Node plafonnée à 4 Gio. La qualification s’exécute directement sur DEV.
  Le job qualité est préparé pour le runner local et le checkout exact ; son
  activation sensible reste distincte. Les builds macOS/Windows gardent leur
  qualification de plateforme propre.

Les règles 47 et 49 sont revues pour le chemin commercial Flow. Aucun tarif au temps
ni facturation n’est ajouté. Une salutation nominative exige une civilité et un nom
vérifiés ; sinon la formule reste « Bonjour, ». Le contrôle est réappliqué au contenu
réel juste avant transport, y compris si le modèle de message correspond. Les tests
restored_content_guards et flow_v2_delivery couvrent les données supposées, le contenu
modifié et le refus avant transport. Les approbations portent une empreinte versionnée
incluant la preuve de civilité ; une ancienne approbation ne vaut pas pour ce contenu.
Aucun email externe ni changement comptable réel n’a été exécuté pour cette qualification.

## Parcours Electron du 30 octobre

Le navigateur réel attaché à Electron a ouvert le renderer du profil QA isolé.
Le scénario officiel vérifie la navigation, le thème, l’autorisation/révocation du
partage distant, le QR desktop, les contrôles de modèles et la projection des tâches
déléguées. Les pages de démonstration utilisent des fixtures ; ce résultat n’est pas
présenté comme une mission avec modèle réel. Le dernier parcours réussit sans erreur
console, erreur de page ou requête échouée. Aucun profil personnel n’a été copié.

Deux essais avaient échoué sur HTTP 504 « Outdated Optimize Dep ». Le package UI lié
était découvert tardivement : optimizeDeps.entries analyse maintenant son entrée dès
le démarrage. Le nouveau parcours part d’un cache froid et conserve les assertions
sur toutes les erreurs. Référence technique : https://vite.dev/config/dep-optimization-options.
Les avertissements de taille des bundles restent visibles ; le seuil Vite n’est pas
relevé, aucun langage de coloration ni fonctionnalité n’est retiré pour les masquer.

## Préconditions des tests et plateformes

Les 32 skips Bun sur Linux correspondent à 14 tests de protection d’application macOS,
14 tests de processus/chemins/PowerShell propres à macOS ou Windows et 4 tests
ASAR macOS. Les trois skips unittest concernent renamex_np, les métadonnées/xattrs
macOS et le dry-run de l’installateur Windows. Aucun n’est compté comme succès.
Le test de syntaxe Bash de l’updater macOS s’exécute bien sur Linux.
Les tests natifs de ces systèmes restent requis avant publication de leurs paquets.

La précondition OpenSSL du test TLS doit échouer explicitement si le certificat QA
ne peut pas être généré ; un retour sans assertions ne constitue pas un test réussi.
Le parseur PowerShell requiert son répertoire explicitement fourni au démarrage.
Les tests doivent établir la même précondition plutôt qu’un fallback import.meta
qui est vide dans le bundle CommonJS d’Electron.

Le contrôleur privé épinglé par la release est aligné sur la diffusion 8. Le commit
fb80719345513a7486d0b47e7fd6018c717dcc2d existe déjà dans Aoleon/rulebook-ai,
présence vérifiée via l’API GitHub ; aucun secret ni droit d’accès n’est ajouté.

Les corrections TLS et initialisation PowerShell passent 18 tests ciblés, ESLint,
les typages shared/CLI et le bundling CommonJS ciblé sans avertissement. OpenSSL
était présent : le scénario TLS a réellement exécuté ses assertions. Les trois
fichiers sont figés avant renouvellement de la portée et exécution du gate.

La diffusion 8 conserve à l’identique les contrats 48/50 et l’index (comparaison
binaire avec la diffusion 7). Le delta du contrôleur ajoute les JSON maintenus à
l’inventaire TypeScript et à son empreinte, avec validation dédiée. Le gate sera
rejoué avec ce moteur ; aucune attestation de la version précédente n’est réutilisée
comme attestation du nouveau moteur.

Le serveur standalone configure maintenant explicitement la racine du parseur
PowerShell avant les handlers. Son bundle copie déjà cette ressource. Le test
runtime passe avec pwsh 7.6.9 et analyse réellement Get-Location ; typage serveur
et lint ciblés sont propres. Aucune nouvelle couche de résolution n’est ajoutée.

## Runner local et portée de la revue

Le contrôleur lie la revue au git-common-dir : copier la politique dans un clone
GitHub neuf invalide cette portée. Le job qualité utilise désormais le checkout
DEV existant et son contrôleur canonique. Il vérifie le commit immuable et l’absence
de changements avant d’exécuter le code du projet, puis relance le gate et verify.
Le checkout n’est ni remis à zéro ni remplacé ; les changements concurrents bloquent
la publication. Les sources et règles ne sont pas transférées pour fabriquer une revue.

Le chemin self-hosted vérifie seulement le helper Electron déjà autorisé. Il refuse
les mauvais droits, les propriétaires/groupes incorrects et les liens externes ;
il n’exécute ni installation ni chmod. Les 20 tests CI ciblés, Ruff et le typage
Python passent. Le helper réel DEV a été vérifié avec zéro sous-commande et des
métadonnées inchangées. Aucun accès supplémentaire au dépôt privé n’est requis.

Le runner officiel 2.338.2 est préparé avec le SHA-256 de l’archive officielle,
et sa version est vérifiée. Son inscription pour un job éphémère est une action
sensible distincte, non déduite de l’accord sur le helper. Le workflow n’est pas
présenté comme exécuté avant cette activation et les résultats GitHub réels.

## Correctifs du premier gate diffusion 8

Le gate du 30 octobre (17:36–17:54 UTC) a validé typage, lint, environnement et
actualisation des dépendances. Il a refusé les tests, le shell et la politique TS.
Les six liaisons de type implicite ont reçu leur type précis ; les deux règles
ESLint shared sont désormais contrôlées, sans exclusion de leur code maintenu.
La configuration TS commune hérite des options strictes déjà présentes à la
racine ; les cinq configurations résolues conservent leurs fichiers et options
sémantiques. Les valeurs false explicites préservent les défauts antérieurs.
Le générateur TLS utilise deux fichiers temporaires distincts et échoue avec une
cause explicite si OpenSSL manque. Les 82 tests CLI passent, dont le rejet TLS.
Les wrappers shell utilisent CDPATH vide explicite ; les 23 sources passent.
Les tests de politique de publication sont séparés des tests d'intégrité runtime
(171 et 334 lignes). Les quatre clones CI restent épinglés ; le checkout local
est vérifié contre le commit attendu et doit être propre. Les signatures Windows
restent contrôlées sous le nom PowerShell approuvé Assert-ValidAuthenticodeSignature.
Les régressions ciblées passent (25 tests, quatre cas ASAR réservés à macOS).
Le lint des dix fichiers TS corrigés passe en lots isolés sous 4 Gio. Le lot
multipaquet ayant atteint cette limite reste enregistré comme échec, sans hausse
de mémoire. La suite globale et le gate doivent confirmer l'ensemble de ce delta.

La reprise complète JavaScript/Electron valide 11 072 tests (32 cas réservés à
un autre système). Le discover Python, avec le runtime du contrat, valide 207
cas dont trois skips documentés ; les 32 cas documents passent. Les assertions
Python de publication utilisent aussi les noms PowerShell actuels. Une reprise
avec Python système 3.12 avait échoué : elle est conservée comme tentative non
qualifiante, remplacée par le résultat du runtime Python 3.15.2 imposé.

La référence historique à la suppression de provider-routing-guard est conservée
ici, hors configuration runtime : publicScopeAdjustment ne possède aucun lecteur
OPS. La capacité a été retirée du périmètre public à partir du commit
cbb4e2f4c35db85e9d04bd345a32f7c930669b5d (ancien décompte de manifestes : 193),
revue le 30 octobre 2026 à 12:29:08 UTC. Le contrôle de frontière reste inchangé ;
la sélection explicite du modèle et les champs opérationnels baseline sont conservés.

La commande CI release-contract inclut explicitement release-policy.test.ts après
sa séparation, avec suppression de l'import devenu inutilisé. La matrice de
contrat existante Linux/macOS/Windows sélectionne Node 26.13.0 et exécute aussi
les six fichiers de tests de frontières natives. Ce sont les tests existants,
sans nouveau composant applicatif ni nouveau mécanisme de routage. Le lot natif
passe sur Mac (95 succès, 11 cas réservés à Windows), y compris les trois cas
Darwin supplémentaires aux frontières SDK et effets d'outils. Les quatre tests
ASAR et les deux cas d'échange atomique/retour arrière passent également sur Mac.
Les 11 cas Windows et l'essai PowerShell natif demeurent à exécuter en CI Windows.

Le gate de 18:35 UTC sur l’arbre f3c87659 valide typage, lint, tests, environnement,
shell et politique TypeScript ; son seul refus concerne la nouvelle Electron stable.
Electron 45.2.0, publiée à 17:34:55 UTC, et le client S3 3.1161.0 sont intégrés
aux manifestes et au verrou. Le nouvel audit couvre 284 entrées sans écart.
La configuration de packaging épinglait encore Electron 45.0.0 : elle est alignée
sur 45.2.0 et un test compare sa version à celle du paquet réellement installé.
Le contrat release passe sur Linux (56 succès, quatre cas Darwin), ainsi que son
typage. Le helper sandbox officiel de 45.2.0 est identique à celui autorisé :
même SHA-256, même inode réutilisé, propriétaire et droits inchangés ; aucun chmod
ni chown supplémentaire. Le contrôle global doit être renouvelé après ce delta.
La suite France conserve 60 tests et leurs assertions. Les connexions SQLite
de ses fixtures utilisent une fermeture garantie, y compris en cas d’échec.
Le lot final passe avec PYTHONWARNINGS=error et PYTHONTRACEMALLOC=1 : aucun
ResourceWarning, aucune tentative externe ; Ruff et basedpyright ciblés passent.
Le parcours natif Electron 45.2.0 passe sous sandbox : gouvernance, appairage
distant, modèle/raisonnement et projection de délégation ; zéro erreur console,
page ou requête. Le premier essai avait navigué avant la fin de restauration UI.
Le scénario attend désormais le landmark de navigation après l’onboarding, puis
rejoint Gouvernance ; toutes les assertions sont conservées, sans nouveau composant.
Ces fixtures UI ne remplacent pas les missions complètes avec le modèle réel.

Le run puis verify de l’arbre 7b2ea8a8 passent tous deux, sans refus. Leur durée
combinée dépasse la limite de 40 minutes du job CI quality. Ce seul délai global
passe à 70 minutes pour laisser la préparation et les deux contrôles aboutir.
Les plafonds internes du contrôleur (run 35 minutes, verify 25 minutes), le tas
Node de 4096 Mio, les assertions et les permissions restent inchangés. Une revue
indépendante confirme cette marge proportionnée ; le prochain job réel devra
la mesurer. Ce changement de workflow renouvelle la portée et son attestation,
sans nouvelle analyse des règles ou langages dont les obligations sont inchangées.
Le gate run puis verify est renouvelé avant intégration de cet arbre.

Le run CI 41120867004 du commit 345942f6 valide OSS, upstream et le parcours
installateur Windows, mais révèle des prérequis de tests incomplets. Le job
campagne installe désormais requests et pydantic sous les contraintes du manifeste
Python existant ; les tests installateurs sont invoqués comme module Python.
Un environnement Python 3.15.2 neuf valide les quatre suites campagne et ces
tests installateurs, sans ResourceWarning ; aucun effet externe métier exécuté.
Les fixtures Bash initialisent explicitement leur racine de parseur PowerShell.
Les tests de hardlinks Windows utilisent toujours leurs vrais fichiers ; seul le
profil Seatbelt, format POSIX, reçoit une racine adaptée. Les trois commandes
PowerShell historiques ciblent le dossier temporaire existant : une racine
inexistante reste refusée par le code de sécurité, inchangé. Quotes, payloads
et assertions sont conservés ; une assertion vérifie la substitution du chemin.
Les imports latéraux redondants des tests sont retirés. Contrats de release,
typage shared/session-tools-core et lint ciblé passent sur DEV avec PowerShell
7.6.9 disponible. Les cas Windows exigent encore la nouvelle CI. Le timeout Mac
observé ne se reproduit ni sur le test ciblé ni sur les six fichiers natifs Mac
avec PowerShell 7.6.9 réel (95 succès, 11 cas Windows ignorés, zéro échec). Aucun
délai de test relevé, aucune assertion supprimée. Les garanties applicatives,
permissions, dépendances et langages restent inchangés ; la portée est renouvelée.


## Windows filesystem-root termination correction (30 October 2026)

Evidence: CI 41124465630 job 124299279096 completes all PowerShell cases,
then stops in the first application-protection test until the 20-minute job limit.
The ancestor traversal compared only with `/`; Windows `dirname(D:\)` is a
fixed point, so the loop did not terminate. Stop at the native dirname fixed point
and reject a filesystem-root input before building the Seatbelt profile. Replace
manual path slicing with `basename` when rebuilding a missing canonical path.
This preserves POSIX/macOS behavior and avoids dropping the first component
character after a Windows drive root. The API still accepts POSIX input for its
macOS Seatbelt purpose; no Windows sandbox capability is claimed or added.

Review: no new layer, dependency, permission, provider effect or guard bypass.
Protection against ancestor deletion, application writes, links, launchd and
pre-existing hard links remains in place. Dedicated tests reject a root, exclude
a literal filesystem-root deny and retain the full missing-bundle name. Independent
read-only review found no regression in this delta. DEV focused boundaries, session
typecheck and ESLint with zero warnings pass; native macOS enforcement runs all
19 tests successfully. Exact Windows CI and a new canonical gate remain required.
Gate attempt6 was stopped without a PASS when this source correction became needed;
its partial execution is not reused as a completed qualification.


## Real directories for six Windows positive permission fixtures (30 October 2026)

CI 41127885201 completes the native Windows suite in 22.49 seconds after the
root-termination fix. Six positive cases still reference absent example directories
under C:\Users\test or Balin. The existing symlink-safe containment check correctly
requires a real allowed root; these examples were never created by the fixture.
Use the existing temporary plans directory for Out-File, Set-Content, Unix redirect,
Write and Edit. Derive upper/lowercase variants from the same real Windows path.
All six allowed=true expectations remain, now including the result as a diagnostic.
Negative cases, platform skips, production permissions and command parsing are
unchanged. Review confirms no new abstraction, dependency, exception or guard bypass.
Focused DEV tests, shared typecheck, ESLint with zero warnings and diff-check pass.
The Windows-only cases must pass in native CI; DEV skips are not their qualification.
Gate attempt7 was not launched because CI was red; exact run/verify remains required.


## Bounded native-test deadlines and completed-denial evidence (30 October 2026)

CI 41129918369 validates all native Windows cases (91 pass, 17 platform skips),
including the six corrected plan fixtures. Its macOS encoded-Python denial test is
interrupted by Bun at 5000 ms although the sandbox child has a 15000 ms timeout.
The earlier CI 41120867004 also interrupted the two-pipeline PowerShell test after
9648 ms under the same 5000 ms default; each parser invocation is bounded at 10000 ms.
Align only these native-test deadlines: 20000 ms around the two sandbox-run test
families and 25000 ms per separately tested non-write PowerShell command. The five
existing command expectations remain. Each now requires successful parsing before
asserting no write target, so a parse failure cannot masquerade as a successful test.
Sandbox deny cases now assert no process error or signal before the nonzero exit,
permission-denial diagnostic and unchanged archive. The action table uses its exact
literal union, removing an unnecessary non-null assertion. No production deadline,
job timeout, platform skip, permission, dependency or guard is relaxed or changed.

Native local macOS sandbox enforcement: 19 pass, zero fail. Focused DEV native tests,
shared/session typechecks, ESLint with zero warnings and diff-check pass. This small
change adds no layer and preserves cleanup. Exact CI and the canonical run/verify
remain mandatory; the failed CI and unstarted gate attempt8 are not a qualification.

## Diffusion 9 controller admission (30 October 2026)
The user-provided diffusion 9 pins controller
386f4e73dc1d9c3c11c93103f6871adf83519073. Contracts 48/50 and the canonical
rule index are byte-identical to diffusion 8. The reviewed controller delta
keeps the complete source snapshot and generated-declaration admission before
selecting lintable batches. Workers retain before/after snapshot checks and
error/exit propagation; batch digest maps contain only that batch's sources.
Added controller tests reject unknown declarations and changes outside a batch,
and cover complete maintained-source inventory and declaration-only revalidation.
The other diffusion changes concern controller repository dependency manifests,
locks and their review evidence, not Robb's runtime or dependency lock.
Only the immutable release controller reference and this review/attestation change.
No Robb application source, test assertion, permission, exclusion, timeout or
quality command is changed. Existing functional evidence on 487f3fb remains
attributed to that commit: all seven CI jobs succeeded. The new exact candidate
still requires its CI and quality gate run/verify under diffusion 9 before
integration. This static impact review does not assert that the gate has passed.

## Diffusion 10 controller admission (31 October 2026)
The user-provided diffusion 10 pins controller
4106cdc99eb240483160b27924347ef2f7f0fd1d. Contracts 48/50 and the rule index
remain byte-identical. The reviewed controller adds optional rule-review fragments.
Robb keeps its existing inline policy and does not enable fragments. For this
policy, loading and the review contract retain their existing behavior. The
controller still validates coverage, fingerprints, engine hashes and review scope;
optional fragments cannot promote pending reviews and validate paths and digests.
The changed engine invalidates the previous attestation: review scope is renewed
after this impact review, without changing rule versions, review statuses,
languages, vendor exceptions or any functional/type/lint control. No application
code, dependency, permission, timeout or test assertion changes in this delta.
The seven-job CI and complete run/verify PASS on parent 2868fef remain historical
evidence for unchanged code, not a PASS for this new controller/candidate pair.
The authorized ephemeral DEV release runner must execute canonical run/verify on
the exact new candidate before signed staging artifacts or local integration.

## Release installer test entrypoints (31 October 2026)
Release CI still invoked test_installers.py directly in the macOS, Linux and
Windows jobs. A clean native Python 3.15.2 import-only diagnostic fails with
ModuleNotFoundError for scripts.json_sources, before collecting tests. Use the
standard module entrypoint already qualified in robinswood-validate.yml:
python3 -m unittest scripts.tests.test_installers. All ten installer contracts
remain enabled, with their existing platform skips; no sys.path manipulation,
PYTHONPATH workaround or assertion change is introduced. Native macOS execution
passes ten tests with one Windows-only skip and warnings treated as errors.
The obsolete stage run 41149843964 was cancelled before artifact construction;
its ephemeral runner completed cleanup and deregistered. This cancelled attempt
is not a quality PASS. The corrected exact candidate requires canonical CI
run/verify and signed staging before local integration. The application, its
dependencies, permissions and public/private boundaries are unchanged.


## CI refusal corrections and secure dependency migration (31 October 2026)

Stage run 41151280496 refused tests, dependencies and typed lint. The permission
fixture now explicitly sets its outside file to 0644 before testing refusal;
this isolates the assertion from the runner's private umask without weakening
production permission handling. Both umask 022 and 077 targeted runs pass.
OpenAI 7.46.0, Claude Agent SDK 0.3.316 and Electron 45.2.1 replace the preceding
compatible releases. Provider contract tests pass; seven sandboxed Electron
canvas tests pass with Bun 1.4.4, including real bitmap capture. The Electron
sandbox helper has the same verified bytes as the previously authorized helper;
its existing authorization does not grant permissions to other executables.

GHSA-3g3m-2fjr-6pw4 requires replacing affected glob 9-14.0.1 installations.
The Bun override selects that range only and installs glob 14.0.3, preserving
callback-based glob 7 for legacy installer consumers. GHSA-g3hv-75wg-m249 requires
minimatch 11.0.1 or later; the override installs current stable 11.0.3 throughout
the dependency tree. The existing Bun patch mechanism preserves the callable
CommonJS entrypoint in minimatch and adapts glob 7's six matcher uses to the
modern non-regex matcher. ESM exports and the secured matching algorithm are
unchanged. No separate runtime service, abstraction layer or weakened control
is added. The override audit retains each version selector while resolving the
actual package name for registry checks and installed versions.

Four regression tests verify CommonJS/ESM, callback/sync legacy glob, async/sync
modern glob, dot/ignore behavior, bounded adversarial preprocessing, and synthetic
archive roundtrips through ASAR 3 and 4. TypeScript release-script checks, ESLint
with zero warnings, Python Ruff and seven dependency-audit boundary tests pass.
Bun audit reports no dependency vulnerability. The GHSA test asserts structural
bounds and matching, not a general performance benchmark. The removed makeRe
API is not reintroduced; the reviewed installed parent sources do not call it.

The package-name normalization also preserves the original manifest path in every
inventory row. A regression covers root and workspace dependencies, so the two
previously authorized compatibility exceptions remain bound to their exact
manifests. The final direct audit checks 286 entries without issues. The four glob
compatibility tests, script typecheck and zero-warning ESLint pass on the 11.0.3
lock; its CommonJS adapter changes exports only, preserving upstream matcher code.
Upstream release: https://github.com/isaacs/minimatch/releases/tag/v11.0.3.

The installed Pi package also contains a prebuilt CLI/RPC bundle with an older
embedded matcher. Robb imports the SDK root instead, builds pi-agent-server
from its own entrypoint, and stages only that output; Electron excludes the
installed node_modules tree. This is a static packaging review, not permission
to use the upstream CLI bundle or a completed build attestation. The exact signed
artifact still requires inspection and full mission qualification.

Rules 00 and 50 retain strict typing, no any, physical source limits, all tests
and all audits. Rules 43/48 retain the 4 GiB Node limit, serialized DEV work,
synthetic-only accounting fixtures and the public/private connector boundary.
The controller candidate splits sequential typed-lint batches at the nearest
configured project root, retaining every file, its order and all checks. Its
separate qualification and publication must precede the final Robb run/verify.
Earlier green commits and targeted checks above do not attest the new candidate;
canonical run/verify, native release jobs and local real missions remain required.

The release workflow now pins Rulebook controller
977c4d0263be04197c7f5dba9f1219224508ac99. Its lint scheduler separates contiguous
batches by their nearest TypeScript configuration without changing the global
snapshot, file coverage, worker validation or the 4 GiB heap. The controller's own
supervisor test publishes its readiness marker atomically; assertions are retained.
The root Rulebook SDK lock is also updated to the supported compatible release.
Canonical rules 48/50 are unchanged. This pin preparation does not attest a Robb
CI run or a publication: controller publication and the exact Robb gate remain
mandatory before building and staging the release.
