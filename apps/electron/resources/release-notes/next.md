# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Faster, self-healing interactive browser** — Text entry now uses a single CDP insertion, fast click navigations are observed without race conditions, stale accessibility refs recover once by semantics, and post-action diagnostics run concurrently. Security challenges no longer trigger on sparse pages alone and can be handed to the user with a non-blocking `resume` wait.

## Bug Fixes

## Breaking Changes
