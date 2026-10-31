# Robb candidate delta review — 31 October 2026

Baseline: e076e99c117f279e36ca49d5a903a030f1bcba59, rulebook diffusion 11
(977c4d0263be04197c7f5dba9f1219224508ac99), quality 50 v1.4.0,
governance 48 v2.4.0. This delta review retains the prior rule-by-rule reasoning
in QUALITY-IMPACT-REVIEW-20261030.md and the versioned evidence it references.
It does not declare the new commit integrated or release-ready.

## Dependency compatibility
CI 41170843282 passes tests, typing, lint, environment and both language policies;
only dependencies fail because OpenAI 7.47.0 was published during qualification.
Update the root development SDK and Bun lock from 7.46.0 to compatible 7.47.0.
Registry audit: 286 entries, zero issues. Mocked Chat Completions and Responses
calls pass without external requests; provider contract suites pass 11 tests.
Generated lock provenance records the real Bun command and exact hashes.

## Polynomial regex findings from PR 79
Replace overlapping status whitespace, trailing question punctuation, host-contract
whitespace and authenticated body-block scans with disjoint or linear scans.
Only the existing authenticated Gmail envelope may hide body payloads; CRLF and
empty envelopes still fail closed under the unchanged execution gate.
Shell mutation detection scans interpreter starts and action positions once,
preserving same-line matching and the read-only AST classifier.
Explicit Gmail identities require whole email/domain tokens. A single sentence
period is accepted; repeated dots, multiple @ and edge-hyphen DNS labels do not
supply identity through a substring. Existing capitalized-brand handling remains.
SDK missing-binary extraction retains supported message variants and paths with
spaces, without overlapping whitespace/capture regex. Whitespace-only text does
not identify an executable path. No orchestrator or dependency is added.
Evidence on DEV: robb-ci-gate-fixes-20261031/codeql/policy-tests-final.log
(864 tests / 40 files), policy-linear-final.log (including long inputs),
typechecks.json and eslint.json. Spawn tests: 27 pass. The new candidate still
requires canonical CI run/verify and CodeQL before these findings count as closed.

## Two CodeQL password-hash classifications
Alerts 96 and 97 apply js/insufficient-password-hash to non-password identities.
In google-code-assist-auth.ts, SHA-256 keys a memory-only 30-second bearer-token
cache; there is no password database or password comparison. In execution-route.ts,
SHA-256 identifies canonical route configuration and the dispatch gate rejects
drift. OAuth email/account/organization IDs are metadata, not passwords.
The route digest is not an anonymization guarantee. Preserve account fields and
credential binding rather than weaken drift detection or add a costly password KDF.
These two findings are false positives for this rule, with no crypto code change.
Official rule: https://codeql.github.com/codeql-query-help/javascript/js-insufficient-password-hash/
Triage must record this rationale per finding; no query, workflow, threshold,
assertion, type check or lint rule is disabled or excluded.

## Windows installed footprint
PR run 41172631464 exceeds the unchanged 1 GiB installed budget at 1.02 GiB.
Exclude platform binaries under dist/resources/bin from the ASAR collector;
extraResources already copies those exact binaries to the path used by runtime.
Keep wrappers, native binaries, install/uninstall smoke and recursive size audits.
Branding/packaging contract: 17 tests pass. Only the next Windows installer run
can establish the actual installed size; configuration reasoning alone cannot.

## Rule and integration impact
Re-review the affected execution, security/authority, dependency and packaging
boundaries under rules 27, 44, 48 and 50 plus the project AGENTS/contracts.
All prior reviewed rules and justified non-applicabilities remain valid after this
bounded diff review. Language commands and strict coverage remain unchanged;
source scope and evidence hashes must bind the new files and current rule versions.
No connector writes, accounting data, profiles, permissions or private modules change.
DEV tests remain serialized with the 4 GiB Node heap. The Mac remains orchestration
and signed staging. Protected-branch review remains required before merging main. Exact canonical
run/verify, signed artifacts, official local preflight and three real QA missions
remain required before release under the published release controls.

## Cross-architecture SDK version resolution
Signed staging run 41174259742 passes canonical run/verify, but macOS x64
requests the nonexistent native SDK version undefined. The fallback still reads
root dependencies after SDK moved to devDependencies. Both macOS and Linux
fallbacks now read version from the already installed SDK package manifest.
No dependency, fetching policy, runtime path or packaging boundary changes.
Both shell scripts pass bash syntax and ShellCheck; actual resolution returns
0.3.316 and npm pack retrieves its Darwin x64 package with the native executable.
The new source still requires canonical run/verify and real signed builds.

## Lucide stable update
Run41177750879 passes six checks, including all tests and strict TypeScript,
but rejects two Lucide1.65.0 declarations after stable1.66.0 was published
at2026-10-31T06:12:30Z. Update root and viewer manifests to1.66.0 and regenerate
bun.lock with bun install. No icon usage, styling, component API or architecture
changes. The full typecheck and fresh286-dependency audit pass before relaunch.
Keep canonical run/verify, signed builds and real UI acceptance mandatory.

## Pinned controller isolation
Run41180045934 passes all seven canonical checks on3fedd538, but verify rejects
a concurrent central-controller update from977c4d0 to92a699aa. Robb source and
fingerprint are unchanged. Keep the published session policy11/977c4d0 and
the existing exact CI pin; never reset the central checkout or weaken verify.
The DEV release runner now uses a separate private clone at the pinned commit,
with its controller dependencies installed from the unchanged package-lock.
Check controller HEAD and clean status before run, before verify and after verify.
Regression tests must reject mid-run drift and must never emit a PASS receipt
for a changed or dirty controller. The project checkout remains in place and
its existing concurrent-change checks remain enabled. No rules or private logs
enter public artifacts. Retain the user ceiling of500 lines for every maintained
test, despite the newer central contract permitting reviewed larger suites.
Impact is limited to CI isolation and its regression tests, under rules27/48/50
and the project environment contract. Dependencies, UI, accounting data, secrets,
permissions and application architecture are unchanged. Reuse earlier analyses
of unchanged rules after this diff review; bind the renewed scope and evidence
to the exact final source. Canonical run/verify, signed builds, official preflight
and the three native missions remain mandatory before publication.

## Published policy generation12
The user explicitly activates generation12/92a699aa during the preceding CI run.
Load quality50v1.5.0 and governance48v2.5.0; update the exact controller pin and
its independent private clone, without modifying the shared central repository.
Review the changes to rules48/50 and quality_adaptations: the new test_suite
classification permits only individually reviewed coherent suites. Robb uses no
such adaptation and keeps every maintained test at500 lines or fewer. Strict
typing, no-any, lint, functional tests, dependency and safety checks are unchanged.
The controller runtime package-lock is unchanged and npm ci succeeds in the new
clone. Renew the two canonical rule hashes, environment evidence and reviewed
source scope after the full candidate diff review. Historical proofs retain their
original controller and commit; they do not attest the new policy generation.
The preceding run passes typecheck, lint, environment, dependencies, shell and
TypeScript policy, but fails five runtime tests; investigate their complete
failures before rerunning. No timeout or assertion is relaxed by this migration.

## Published policy generation13 and runtime test stability
Generation13/aa499d6689353a00689d2eb943e3db6c8e118fda supersedes generation12
by explicit user instruction. Governance48v2.5.0 and quality50v1.5.0 are unchanged.
The controller diff only extends its Git inventory/read timeout from2s to10s,
with its own regression tests and review evidence. The private independent clone
is clean and its unchanged runtime lockfile installs successfully. The exact CI
pin now selects generation13. No central checkout or shared permissions change.
Run41182902740 onca60ff7 passes six canonical checks and fails five runtime tests.
All five pass in isolation with unchanged deadlines:23 tests in14.32s, then the
1,000-checkpoint test in166.82s under its original300s timeout, with no dispatch.
That stress process uses1percent CPU, indicating waiting rather than CPU work;
this does not alone establish a production defect or an interference root cause.
The retry test now shares the existing injected clock across restart, checks the
persisted retry deadline and no premature dispatch, then advances to that deadline.
The supersession test awaits the existing completion event for the second result,
filtered by session, complete reason and final text. It keeps all terminal assertions.
The synchronous durable recovery suite runs in its own Bun process through the
existing isolated list. A runner test proves discovery exactly once in that process.
No fsync, checkpoint,1,000-case count, assertion or test timeout is removed or raised.
The initial27-test check used a default Bun and is not the qualified runtime proof.
The repeated qualified Bun1.4.4 check passes38 tests across8 files in9.61s,
including the editor identity/helpers/menu suites. The24 CI regression tests and
shell syntax/lint pass; the fresh286-dependency audit reports zero issues.
The full canonical suite
remains required; isolated success is not represented as global qualification.
Impact concerns test synchronization and process isolation, rules27/48/50 and the
CI environment pin. Application runtime code, data, connectors,
permissions and production architecture are unchanged. Reuse unchanged rule reviews
only after this diff review; renew their content scope and evidence hashes. No new
orchestrator, wrapper service or production abstraction is introduced.

The fresh registry audit finds prosemirror-view1.42.9 published on2026-10-31 at
08:49:50UTC after the previous successful audit. Update only its compatible patch
override from1.42.8 and the resolved Bun lock/tree. Preserve the existing editor
API and all compatibility checks; the canonical typecheck, tests and native UI
missions cover the installed candidate. No further version exception is added.
