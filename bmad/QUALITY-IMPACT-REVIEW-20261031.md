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
and signed staging. PR approval, exact canonical run/verify, signed artifact,
official local preflight and three real QA missions remain required before release.
