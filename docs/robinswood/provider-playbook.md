# Provider playbook — Robb Agents

Date: 2026-07-06

This document defines the target provider strategy for French client deployments.

## Principle

The public distribution uses the connection, model and reasoning selected for the
session. Task content, cost and failures do not change that selection. Subtasks,
reviews and context summaries inherit it unless an explicit model is supplied.
Provider availability and confidentiality requirements must be checked when
configuring and selecting the connection.

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
- select another approved connection explicitly when local capability is insufficient.

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
- explicitly selected premium models;
- experimentation and non-sensitive complex tasks;
- comparison of configured model capabilities.

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

## Visible selection and provenance

The model picker exposes the configured provider, model and reasoning controls.
Each assistant response retains the effective provider/model and available costs.
Historical decision metadata remains readable but does not activate a selector.

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
