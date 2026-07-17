# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Bundled RTK and autonomous execution defaults** — Robb Agents now ships a checksum-verified RTK optimizer inside each supported installer and enables it by default, while retaining an explicit opt-out. New workspaces start in autonomous execution mode with high reasoning, and agents diagnose failures, use safe fallbacks including the integrated browser, and escalate only for truly human-only input.
- **Public installers and verification** — Robb Agents releases are published through GitHub Releases with SHA-256 checksums, an improved per-user Windows installer, and macOS release checks for Developer ID signing/notarization. Public version tags now fail closed without verified signing credentials; unsigned local/CI builds remain test artifacts only. Windows CI also performs an isolated install/uninstall journey and verifies the bundled Mistral Vibe bridge.
- **Safer workspace sharing and diagnostics** — Resource bundles exclude credential- and private-key-shaped files, reject them on import, and report every excluded file. Provider error and SDK-stderr diagnostics redact credential-shaped values before they reach the UI.
- **French-first, more accessible onboarding** — Remaining provider/API-key guidance is localized in French and English. Provider selection now exposes explicit selected states and live setup progress to assistive technologies.
- **Linux AppImage release parity** — Signed-release validation now also builds, extracts and checks the Linux x64 AppImage, publishes its checksum/provenance, and verifies the bundled desktop entry plus Pi and Mistral Vibe subprocesses.
- **Open Craft Agents data directly** — Robb now uses the existing Craft Agents data root by default, so sessions, sources, skills, projects, preferences and local credentials are available immediately without a migration or copy. Use `CRAFT_CONFIG_DIR` only for an intentionally isolated profile.

## Bug Fixes

## Breaking Changes
