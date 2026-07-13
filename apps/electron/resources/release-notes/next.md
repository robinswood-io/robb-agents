# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Public installers and verification** — Robb Agents releases are published through GitHub Releases with SHA-256 checksums, an improved per-user Windows installer, and macOS release checks for Developer ID signing/notarization. Public version tags now fail closed without verified signing credentials; unsigned local/CI builds remain test artifacts only. Windows CI also performs an isolated install/uninstall journey and verifies the bundled Mistral Vibe bridge.
- **Safer workspace sharing and diagnostics** — Resource bundles exclude credential- and private-key-shaped files, reject them on import, and report every excluded file. Provider error and SDK-stderr diagnostics redact credential-shaped values before they reach the UI.
- **French-first, more accessible onboarding** — Remaining provider/API-key guidance is localized in French and English. Provider selection now exposes explicit selected states and live setup progress to assistive technologies.

## Bug Fixes

## Breaking Changes
