# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **GPT-6 Astra for OpenAI connections** — Astra is now selectable with both OpenAI API keys and ChatGPT/Codex accounts, with compatible reasoning and prompt-cache requests while GPT-5.6 Sol remains the default.

## Improvements

- **Verifiable goals and project learning** — New action and inspection objectives require target-specific completion checks. Independent reviews bind to the exact objective and criteria, while sourced project lessons remain inactive until independently replayed and reviewed.

- **Autonomous execution checkpoints** — Agent turns now batch routine discovery, reserve verification capacity before mutations, continue cost checkpoints automatically, and hand completed work to review without overwriting an explicit workflow status.
- **Faster, bounded tool workflows** — Read-only session calls can run in capped parallel batches, delegated sessions expose event-driven waiting, source tools advertise output budgets, and SSH/browser guidance favors bounded results, sync operations, semantic actions, and native waits.

## Bug Fixes

- **Durable agent delivery** — Agent messages acknowledge persisted receipt without waiting for the recipient, preserve their origin and attachment versions across restarts, and deduplicate retries. Concurrent first-time workspace settings loads now share initialization.

- **Provider and session recovery** — Mid-stream quota and availability failures now switch to another configured connection, while stale portable long-response paths and false terminal “continue next turn” responses are repaired automatically.
- **Reliable tool contracts** — Session status aliases and both Edit argument dialects are normalized, the browser guide no longer causes a sacrificial first call when its contract is already loaded, and packaged document tools resolve their bundled runtime even when shell environment hints are absent.

## Breaking Changes
