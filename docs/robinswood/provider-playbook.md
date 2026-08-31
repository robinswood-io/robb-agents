# Provider playbook — Robb Agents

Date: 2026-07-06

This document defines the target provider strategy for French client deployments.

## Principle

Robb Agents should not push every task to the strongest cloud model. Provider choice must be policy-first:

1. client confidentiality policy;
2. source/data sensitivity;
3. task difficulty;
4. tool/vision/context requirements;
5. latency;
6. cost.

The UI should make provider/model usage visible and auditable.

## Baseline provider classes

### 1. Local / on-device

Purpose:

- private drafts;
- low-risk reformulation;
- local RAG over sensitive files where acceptable;
- cheap classification/summarization.

Typical setup:

- provider type: `pi_compat` / custom OpenAI-compatible endpoint;
- base URL examples:
  - Ollama default: `http://localhost:11434`;
  - local gateway / vLLM / llama.cpp proxy depending on client setup;
- protocol: OpenAI-compatible when available.

Policy:

- preferred for sensitive content if quality is enough;
- fallback to sovereign endpoint if local model confidence is insufficient.

### 2. Sovereign / French or EU endpoint

Purpose:

- client-sensitive workloads requiring external compute;
- French/EU data-residency positioning;
- medium-complexity tasks where local models are insufficient.

Candidate providers:

- OVHcloud AI Endpoints;
- client-owned vLLM/TGI gateway hosted in France/EU;
- other EU providers validated case-by-case.

Important:

- Do **not** hardcode an OVH base URL until the exact current OpenAI-compatible endpoint format is verified against the client/provider docs.
- Treat OVH as a configurable custom endpoint first.
- Require explicit model ID(s) per endpoint.

Target preset name once verified:

- `OVHcloud AI Endpoints` or `OVH / endpoint souverain`.

### 3. OpenRouter / model marketplace

Purpose:

- broad model access;
- flexible premium fallback;
- experimentation and non-sensitive complex tasks;
- cost/quality routing.

Typical setup:

- base URL already present upstream:
  - `https://openrouter.ai/api/v1` for OpenAI-compatible flows;
  - upstream also has Pi/OpenRouter routes.

Policy:

- allowed only for workspaces/sources where external marketplace routing is permitted;
- disallowed by default for highly sensitive client documents unless policy explicitly allows it.

### 4. Direct premium providers

Purpose:

- highest-quality reasoning;
- coding/agentic tasks;
- client deliverables requiring strong synthesis;
- complex multi-source analysis.

Candidate providers:

- Anthropic;
- OpenAI;
- Google Gemini via the official Antigravity CLI and Google account quota;
- Google Gemini Code Assist OAuth for separately licensed organizations;
- Google AI Studio API key for API-key use cases;
- Mistral Vibe via the official subscription-backed ACP agent;
- Mistral AI Studio API key only where pay-as-you-go API access is explicitly desired;
- Azure/OpenAI EU where available and approved.

Policy:

- use for high-difficulty tasks or client-facing deliverables;
- require explicit client/workspace authorization.

## Recommended initial client setup

For each client workspace, configure at least three connections:

1. **Local / Fast**
   - Cheap, private, low-risk tasks.
2. **Souverain / Standard**
   - OVH or client EU endpoint once validated.
3. **Premium / Complex**
   - OpenRouter or direct premium provider, only if allowed by policy.
   - Google account/subscription access uses the official Antigravity CLI (`google-antigravity`, backed by `piAuthProvider: google-antigravity`). Google owns the credential in the OS keyring; Robb uses the sandboxed headless NDJSON stream and does not extract the token.
   - Organization Gemini Code Assist remains separate (`google-gemini`, backed by `piAuthProvider: google-gemini-code-assist`) and requires an assigned Standard/Enterprise license plus a Google Cloud project.
   - Google AI Studio API keys remain available through the generic API-key provider preset (`piAuthProvider: google`) and are separate from the subscription/account OAuth path.
   - Mistral Vibe uses the official local `vibe-acp` agent after a browser sign-in to the user’s Mistral plan. Robb stores no Mistral credential and never extracts Vibe’s local token. This is the primary Mistral route for subscription use; it is not an OpenAI-compatible custom endpoint.
   - Mistral AI Studio/API-key access (`piAuthProvider: mistral`) remains a separate, explicit pay-as-you-go option. Its recommended API tiers are Mistral Medium 3.5 (complex/agentic), Mistral Small 4 (standard), and Ministral 3B (utility); Devstral and Codestral can be selected for coding-focused work.

## Naming convention

Connection names should be readable by non-technical users:

- `Local — rapide`
- `Souverain — standard`
- `Premium — analyse complexe`
- `OpenRouter — expérimentation`
- `Claude — haute qualité`
- `Mistral Vibe — abonnement`
- `Google Antigravity — compte`
- `Mistral API — pay-as-you-go`

Avoid exposing raw provider slugs in client-facing labels.

## Router policy schema

Implemented foundation: `WorkspaceConfig.routingPolicy?: RoutingPolicy`.

The schema is deliberately policy-first: hard allow/deny constraints are evaluated before preferences/fallbacks.

```ts
{
  version: 1,
  enabled: true,
  defaultSensitivity: 'internal',
  requireExplicitAllowFor: ['confidential', 'restricted'],
  rules: [
    {
      id: 'confidential-local-or-sovereign',
      when: { sensitivity: ['confidential', 'restricted'] },
      allowConnectionSlugs: ['local-fast', 'sovereign-standard'],
      allowProviderTypes: ['pi_compat'],
      preferConnectionSlugs: ['sovereign-standard', 'local-fast']
    },
    {
      id: 'public-complex',
      when: { sensitivity: ['public'] },
      allowConnectionSlugs: ['premium-complex', 'openrouter-experimentation'],
      preferConnectionSlugs: ['premium-complex']
    }
  ],
  fallbackConnectionSlug: 'sovereign-standard'
}
```

Current implementation lives in `packages/shared/src/config/routing-policy.ts` with validation and pure resolution helpers. `SessionManager` now applies the policy before backend creation/reuse when a workspace explicitly enables `routingPolicy`.

`routingPolicy` can be edited from Workspace Settings → Router IA, or directly in workspace `config.json`.

A complete JSON example for client workspaces is maintained at `docs/robinswood/routing-policy.example.json` and covered by `packages/shared/tests/routing-policy-example.test.ts`.

Sources can also declare a manual sensitivity hint from the Source detail page UI, or directly in their `config.json`:

```json
{
  "routingSensitivity": "confidential"
}
```

Allowed values are `public`, `internal`, `confidential`, `restricted`. When multiple sources are enabled for a session, the runtime uses the highest configured source sensitivity for the turn before resolving `routingPolicy`.

## UI requirements

Each assistant response now displays/exposes:

- connection/provider used;
- model used;
- routing reason;
- sensitivity tier;
- matched policy rule IDs.

Still to add:

- fallback reason if any;
- estimated/actual cost if available.

## Private provider contract controls

Three subscription-backed paths depend on endpoints that are not public API
contracts. Their endpoint, headers, exact Pi SDK version, fallback and canary
requirements are centralized in
`packages/core/src/provider-contracts.ts`:

- ChatGPT Codex backend (`/backend-api/codex/responses`): search falls back to
  DuckDuckGo when disabled; an OpenAI API-key connection continues to use the
  official Responses API.
- GitHub Copilot `proxy-ep`: model discovery falls back to the exact Pi SDK
  static catalog when disabled.
- Google Code Assist `v1internal`: requests fail closed when disabled because a
  Code Assist OAuth token cannot be moved transparently to the public Gemini
  API. Configure a separate Google AI Studio connection for that official path.

Emergency controls preserve the existing behavior when unset. Values `1` and
`true` disable; `0` and `false` explicitly enable. Any other non-empty value is
treated as malformed and disables the private path:

- `ROBB_DISABLE_UNSTABLE_PROVIDERS` (master);
- `ROBB_DISABLE_CHATGPT_CODEX_BACKEND`;
- `ROBB_DISABLE_GITHUB_COPILOT_PROXY`;
- `ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL`.

The scheduled `Provider contract canaries` workflow checks auth, model listing,
search and tool calls where each contract supports them. Configure repository
secrets `ROBB_CANARY_CHATGPT_ACCESS_TOKEN`, `ROBB_CANARY_GITHUB_TOKEN`, and
`ROBB_CANARY_GOOGLE_CODE_ASSIST_ACCESS_TOKEN`. Reports contain only redacted
diagnostics. Set repository variable `ROBB_PROVIDER_CANARIES_REQUIRED=1` after
the secrets are installed to make skipped required checks fail the workflow.
Optional model overrides are `ROBB_CANARY_COPILOT_MODEL` and
`ROBB_CANARY_GOOGLE_CODE_ASSIST_MODEL`.

## Next engineering steps

1. Verify OVHcloud AI Endpoints current OpenAI-compatible base URL format and authentication.
2. Add a branded OVH/custom endpoint preset only after verification.
3. Persist provider/model metadata per assistant response. ✅
4. Implement router policy schema. ✅
5. Wire `resolveRoutingPolicy(...)` into runtime turn creation. ✅
6. Add validated example `routing-policy.example.json`. ✅
7. Add manual policy labels to sources/workspaces. ✅ (`routingSensitivity` on sources)
8. Add source sensitivity UI. ✅
9. Add UI/settings editor for workspace `routingPolicy`. ✅
10. Add Google Gemini account/subscription OAuth flow via Gemini Code Assist. ✅
