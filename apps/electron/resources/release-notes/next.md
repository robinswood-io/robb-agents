# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **GPT-6 Astra for OpenAI connections** — Astra is now selectable with both OpenAI API keys and ChatGPT/Codex accounts, with compatible reasoning and prompt-cache requests while GPT-5.6 Sol remains the default.
- **Current provider models** — Adds Claude Opus 5, Claude Fable 5.1, Gemini 3.8 Flash through the official Antigravity CLI, and the documented Mistral Medium 3.5 model ID. Existing session selections are preserved.

## Improvements

- **Provider capabilities and cost metadata** — Preserves image capabilities from the Pi catalog, updates GPT-5.6 Sol pricing and prompt-cache requests, and sends the correct reasoning parameter for Mistral Medium 3.5.
- **Autonomous execution checkpoints** — Agent turns now batch routine discovery, reserve verification capacity before mutations, continue cost checkpoints automatically, and hand completed work to review without overwriting an explicit workflow status.
- **Faster, bounded tool workflows** — Read-only session calls can run in capped parallel batches, delegated sessions expose event-driven waiting, source tools advertise output budgets, and SSH/browser guidance favors bounded results, sync operations, semantic actions, and native waits.

## Bug Fixes

- **Provider and session recovery** — Provider errors preserve the selected connection and model, while stale portable long-response paths and false terminal “continue next turn” responses are repaired automatically.
- **Mistral Vibe session context** — Session instructions reach the official ACP agent, and messages sent during a response are queued instead of silently dropped.
- **External agent capability checks** — Vibe and Antigravity reject unsupported image attachments with a clear message. Ineffective effort controls are hidden, and Vibe rejects tool permissions that require argument rewriting unsupported by ACP.
- **Reliable tool contracts** — Session status aliases and both Edit argument dialects are normalized, the browser guide no longer causes a sacrificial first call when its contract is already loaded, and packaged document tools resolve their bundled runtime even when shell environment hints are absent.

## Breaking Changes
