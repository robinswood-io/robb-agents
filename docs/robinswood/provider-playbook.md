# Provider playbook — Robinswood Agents

Date: 2026-07-06

This document defines the target provider strategy for French client deployments.

## Principle

Robinswood Agents should not push every task to the strongest cloud model. Provider choice must be policy-first:

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
- Google AI Studio;
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

## Naming convention

Connection names should be readable by non-technical users:

- `Local — rapide`
- `Souverain — standard`
- `Premium — analyse complexe`
- `OpenRouter — expérimentation`
- `Claude — haute qualité`

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

## UI requirements

Each assistant response should eventually display or expose:

- connection/provider used;
- model used;
- routing reason;
- fallback reason if any;
- sensitivity tier;
- estimated/actual cost if available.

## Next engineering steps

1. Verify OVHcloud AI Endpoints current OpenAI-compatible base URL format and authentication.
2. Add a branded OVH/custom endpoint preset only after verification.
3. Persist provider/model metadata per assistant response. ✅
4. Implement router policy schema. ✅
5. Wire `resolveRoutingPolicy(...)` into runtime turn creation. ✅
6. Add manual policy labels to sources/workspaces.
7. Add UI/settings editor for workspace `routingPolicy`.
