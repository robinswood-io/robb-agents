# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Public installers and verification** — Robb Agents releases are published through GitHub Releases with SHA-256 checksums, an improved per-user Windows installer, and macOS release checks for Developer ID signing/notarization. Public version tags now fail closed without verified signing credentials; unsigned local/CI builds remain test artifacts only. Windows CI also performs an isolated install/uninstall journey and verifies the bundled Mistral Vibe bridge.

## Bug Fixes

## Breaking Changes
