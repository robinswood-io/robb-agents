# Provider capabilities verified on 2026-09-08

The provider catalogs and request adapters now cover the current documented
models below. Existing session selections are retained. A catalog entry is not
proof that an account has access, quota, or the same capabilities through every
authentication method.

## Model and request contracts

| Provider path | Current entries verified | Runtime behavior |
| --- | --- | --- |
| Anthropic SDK and Pi API | `claude-opus-5`, `claude-fable-5-1`; existing Sonnet 5 and Haiku 4.5 retained | 1M context and 128K maximum output for the new snapshots; adaptive thinking, images and tool use. Fable always thinks. Opus 5 is the default for new native connections; existing choices are preserved. |
| OpenAI API and ChatGPT/Codex transport | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Sol remains the default. Runtime registration uses the existing provider transport and auth refresh contract. Astra rejects disabled reasoning and sampling parameters; GPT-5.6 and Astra use the new prompt-cache schema. |
| Mistral API | `mistral-medium-3-5`, `mistral-medium-2604`, `mistral-small-latest` | Medium 3.5's canonical ID is registered. The adapter converts the SDK's legacy prompt mode to `reasoning_effort: high` when reasoning is enabled; disabled reasoning stays disabled. Vision, tool-call IDs, thinking history and cache accounting are covered by a simulated transport test. |
| Official Antigravity CLI | Gemini 3.8 Flash high/medium/low, 3.7, 3.6 and 3.1 Pro | CLI 1.1.27's `agy models` output confirmed the available IDs. The model suffix selects effort; a separate ineffective reasoning control is hidden. Gemini 3.5 entries absent from that output are removed from suggestions. |
| Official Mistral Vibe ACP | `mistral-vibe` | The authenticated Vibe profile owns model selection. Host instructions reach the ACP conversation. Mid-turn user input remains in the host queue. A tool requiring rewritten arguments is rejected because ACP permission options cannot apply that rewrite. |

The native Pi catalog now preserves explicit image capabilities. Vibe and
Antigravity currently accept text through their Robb bridges; image attachments
are rejected with an actionable error before a subprocess starts instead of
being silently discarded. Their reasoning events can still be displayed even
though Robb does not expose an independent effort control.

Sources: [Anthropic models](https://platform.claude.com/docs/en/models/overview),
[Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview),
[Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview),
[OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[Mistral Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04),
[Mistral reasoning](https://docs.mistral.ai/studio/conversations/reasoning),
[Antigravity headless CLI](https://www.antigravity.google/docs/cli/headless/).

## Cost metadata and limits

Standard USD per million tokens, verified against the official model pages:

| Model | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | 10 | 1 | 12.50 | 50 |
| GPT-5.6 Sol | 4 | 0.40 | 5 | 20 |
| GPT-5.6 Terra | 2 | 0.20 | 2.50 | 12 |
| GPT-5.6 Luna | 0.20 | 0.02 | 0.25 | 1.20 |
| Claude Opus 5 | 5 | 0.50 | 6.25 | 25 |
| Claude Fable 5.1 | 10 | 0.25 | 12.50 | 50 |

Claude cache-write rates above are for five-minute retention. Sol prices are
promotional through at least November 21, 2026 and need revalidation afterward.
These are API list-price estimates, not measured subscription charges.
Sources: [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), and the
Anthropic model pages above.

Pi 0.80.3 does not account for OpenAI cache-write tokens or long-context price
multipliers. Astra retains a conservative 272K operational context cap; the
provider's advertised maximum is 1,050,000. Cost counters must not be represented
as complete invoice reconciliation. Pi also maps Robb's `max` effort to `xhigh`;
the native Claude SDK preserves its supported `max` setting.

## Features requiring separate implementation

- OpenAI asynchronous tools, WebSocket steering and configuration-update items
  are available in the provider API but are not implemented by adding model IDs
  to the pinned Pi transport. Existing Pi steering is an agent-loop operation.
- Fable 5.1's per-message effort, turn-scoped system messages and progress-update
  beta modes are not enabled. No silent migration of existing Fable 5 sessions
  is introduced; its newer thinking history has compatibility restrictions.
- Unknown future Anthropic models still depend on local registry metadata for
  limits and capabilities; the model-list fetcher does not consume all new
  metadata fields returned by `/v1/models`.
- Antigravity availability remains account/CLI dependent. `agy models` succeeded,
  but no inference, quota or end-to-end installed-application test was performed.

## Verification scope

Local verification of this candidate passed 178 focused provider, selection and
bridge tests, 54 release-contract tests, 8 source-boundary tests, and 10 installer
tests (one platform-specific skip). Shared, Electron, Pi and release-contract
TypeScript checks, locale parity and OSS validation passed.
The full Electron development build also passed without installing or launching
the application.

CI now runs the catalog, image-capability, thinking-option, request-normalization,
provider-registration and external-bridge regression suites explicitly. The
Mistral transport test exercises the actual SDK serializer and interceptor with
a fake fetch implementation across 15 model/effort combinations. Vibe and
Antigravity bridge tests use simulated CLI/ACP subprocesses with temporary data.
No provider inference, credential change, staging installation or release is
required by these tests.

Before promotion, run the provider CI step, the shared/Electron/Pi TypeScript
checks, the public source boundary check, and the repository's release and
installer contract checks. A successful test suite establishes those contracts;
account access and the installed user experience require a separate Dev/staging
acceptance run.
