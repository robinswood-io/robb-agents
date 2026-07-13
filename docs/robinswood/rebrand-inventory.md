# Rebrand inventory — Robb Agents

Date: 2026-07-06

This document tracks what must be changed before distributing the fork to Robinswood clients.

## Principle

The upstream project is Apache 2.0, but `Craft` and `Craft Agents` are trademarks. A client-facing Robinswood distribution must be clearly branded as Robinswood and must not create confusion with the official Craft Agents product.

Recommended public phrasing:

> Robb Agents is based on the open-source Craft Agents project.

Avoid product names such as `Craft Agents Pro`, `Better Craft Agents`, or anything implying an official Craft product.

## Current upstream identity to replace before distribution

### Product naming

- `Craft Agents` app/product name.
- `Craft Agent` singular references in user-facing docs and UI.
- `craft-agent` package/root name where it affects distributed artifacts.
- `@craft-agent/*` internal package scope: **do not rename in phase 0** unless necessary; this would create high maintenance cost. Treat as internal implementation detail.

### App/package identifiers

Need detailed verification in Electron config before release:

- macOS bundle ID.
- Windows AppUserModelID / installer identity.
- Linux desktop name/package identifiers.
- Protocol handlers such as `craftagents://`.
- Log folder names such as `@craft-agent/electron`.
- Config directory `~/.craft-agent`.

Decision required: whether Robinswood client distribution should use a separate config dir, e.g. `~/.robb-agents`, to avoid collision with upstream Craft Agents.

### Visual identity

- App icon.
- Tray/dock icon.
- Installer icon.
- Splash/onboarding graphics if any.
- README badges and marketing screenshots.
- Browser/window title.

### Documentation

Files with obvious public-facing upstream brand references:

- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `TRADEMARK.md` — keep upstream policy, but add Robinswood distribution notes elsewhere.
- Installation commands and examples.
- OAuth setup examples using `My Craft Agent` or `Craft Agent Desktop`.
- Debug/log paths in docs.

### Electron/package config candidates

Initial files to audit first:

- `apps/electron/electron-builder.yml`
- `apps/electron/package.json`
- root `package.json`
- Electron main process app naming files.
- Any file registering deep links or config paths.

### Runtime/storage identity

Important: storage paths are product behavior, not just branding.

Questions to answer before distribution:

1. Should Robb Agents share existing `~/.craft-agent` workspaces for internal users?
2. Should client builds use separate `~/.robb-agents` storage?
3. Do we need migration/import from upstream Craft Agents?
4. Should source credentials be isolated from upstream?
5. How do we label sessions/files created by Robinswood vs upstream?

Default recommendation for clients: separate config directory and separate app identity.

## Phase 0 approach

Do **not** perform broad string replacement yet. It is risky and creates unnecessary merge conflicts with upstream.

Instead:

1. Keep upstream identity internally during early fork work.
2. Document required changes.
3. Add a small controlled rebranding layer later.
4. Prioritize French locale, CI, router spike and client templates first.

## Phase 1 rebrand acceptance criteria

Before any external client distribution:

- App visible name is `Robb Agents` or selected final name.
- Bundle/package IDs are Robinswood-owned.
- Icons are Robinswood-owned.
- Config/log directories are intentionally chosen and documented.
- `README` clearly states open-source basis without implying official Craft affiliation.
- License and NOTICE obligations are preserved.
- Trademark policy is respected.

## Known maintenance trade-off

Renaming internal package scopes from `@craft-agent/*` would touch many files and increase upstream merge pain. Defer unless legally or technically required for distributed artifacts.
