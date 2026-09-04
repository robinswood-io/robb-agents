# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Autonomous execution checkpoints** — Agent turns now batch routine discovery, reserve verification capacity before mutations, continue cost checkpoints automatically, and hand completed work to review without overwriting an explicit workflow status.
- **Faster, bounded tool workflows** — Read-only session calls can run in capped parallel batches, delegated sessions expose event-driven waiting, source tools advertise output budgets, and SSH/browser guidance favors bounded results, sync operations, semantic actions, and native waits.

## Bug Fixes

- **Provider and session recovery** — Mid-stream quota and availability failures now switch to another configured connection, while stale portable long-response paths and false terminal “continue next turn” responses are repaired automatically.
- **Reliable tool contracts** — Session status aliases and both Edit argument dialects are normalized, the browser guide no longer causes a sacrificial first call when its contract is already loaded, and packaged document tools resolve their bundled runtime even when shell environment hints are absent.

## Breaking Changes
