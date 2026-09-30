# Autonomous public release 0.12.9

This release preserves an explicit provider/model/reasoning selection. It contains no automatic model-selection engine. Historical receipt and selection provenance remain readable, but retired workspace routing settings do not drive execution.

The host records the user's objective and execution authority. In Execute mode with external actions enabled, permission, plan and clarification handoffs are unavailable. A missing credential, indispensable fact or exhausted recovery must end as incomplete, not as verified success. Explore and Ask modes retain their own behavior.

Provider dispatch and external tool operations have durable identities. Recovery reconciles accepted dispatches and existing receipts before reissuing work. Unknown external outcomes remain unknown until observation supplies evidence. Objective acceptance uses host-owned observations and excludes coordination and unrelated chats as proof. Retry, context and monetary limits remain bounded and observable.

References consulted while preparing the implementation:

- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): durable checkpoints and replay boundaries informed the separation between stored execution state and live runtime objects.
- [OpenAI Agents SDK interruptions](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/): serialized interruption state informed recorded authority and resumed-operation fences. Robb's Execute policy intentionally does not introduce an interactive approval step.
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and [ChatGPT model inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): model IDs and provider serialization are registered against the pinned runtime. The app uses that runtime's validated context/reasoning limits; catalogue registration does not promise account entitlement.

Customer-specific authorization exceptions and database tuples were removed from runtime policy. Regression data uses synthetic addresses and a synthetic mail payload; those compatibility grants are not shipped in the public application.

Validation covers explicit selection, unauthorized overrides, objective criteria, interrupted dispatch, tool receipt identity, budget exhaustion, installer rollback and an isolated native application journey. On 2026-09-30, the isolated native app completed a GPT-6.1 Sol journey through the existing ChatGPT OAuth connection: it read a synthetic 12-row CSV, computed 650, wrote a Markdown report and a JSON result, verified both with tools, and persisted `complete_verified` with zero automatic continuations and no user-input request.

Local tests and one reference journey establish these specific behaviors; they do not establish global SDK conformance or universal autonomous task success.

Conversation questions now share the message timeline. Answered and cancelled requests retain their creation position; only pending interactive forms are placed at the reachable end. Reverse pagination does not move historical answers to the latest page. An isolated native UI journey displayed two answered questions between their original messages and subsequent replies, with the full question and answer still expandable.

The initial CodeQL analysis identified potentially expensive regular expressions and a fast digest of API authentication material. Delimited payload parsing and boundary matching now use bounded or linear scans. API summary caches use opaque process-scoped identities rather than persisted credential digests, and terminal reconciliation uses HMAC. Two password-hash alerts are false positives verified against their SARIF data flows: capability identity receives a host-generated credential `bindingId`, never the credential value; execution identity receives OAuth account/organization identifiers, never an OAuth token or password. Their identity fences are retained, and their review is recorded individually rather than disabling the security analysis.

The repository was already public before this release. No private ancestor or private distribution artifact is introduced into this release branch. The historical visibility preflight also reports pre-existing public operations endpoints and security-fixture literals; repository history is not rewritten as part of this release.

Local release checks passed: `bun run test` (including isolated lifecycle tests), `bun run validate:ci`, the public source-boundary scan and its unit tests, `git diff --check`, and a source-only Gitleaks scan with the repository policy. The native result files were independently reread and recalculated. Signing, notarization and platform installer publication are separate CI gates; a local ad hoc package is never a public asset.
