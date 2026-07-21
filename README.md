# Robb Agents

> **A local-first desktop workspace for autonomous AI agents.**
>
> Plan, run, verify and supervise long-running agent work — with your data, providers and tools under your control.

[![Validate](https://github.com/robinswood-io/robb-agents/actions/workflows/robinswood-validate.yml/badge.svg)](https://github.com/robinswood-io/robb-agents/actions/workflows/robinswood-validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-08033A)](#downloads)

**Robb Agents** is an open-source desktop workspace maintained by Robinswood. It combines multi-session agent work, projects and task workflows with local MCP/API sources, provider routing and an integrated browser fallback.

## Why Robb Agents

- **Autonomous by default** — agents diagnose tool failures, use safe alternatives such as the integrated browser, and surface only genuinely human-only blockers.
- **Local-first** — existing Craft Agents data in `~/.craft-agent` remains available; no migration or copy is required.
- **Provider freedom** — use ChatGPT/Codex, Claude, Gemini, GitHub Copilot, Mistral API or Mistral Vibe with explicit billing and authentication modes.
- **Built for durable work** — sessions, projects, Kanban, background agents, source connections and operational evidence stay together.
- **Efficient runtime** — the checksum-verified RTK optimizer is bundled into supported desktop builds.

## Downloads

Download the matching verified artifact from [GitHub Releases](https://github.com/robinswood-io/robb-agents/releases):

| Platform | Artifact |
| --- | --- |
| macOS Apple Silicon | `Robb-Agents-arm64.dmg` |
| macOS Intel | `Robb-Agents-x64.dmg` |
| Windows x64 | `Robb-Agents-x64-Setup.exe` |
| Linux x64 | `Robb-Agents-x64.AppImage` |

Every release provides a `SHA256SUMS.txt` file. Verify it before opening an installer:

```bash
# macOS / Linux
shasum -a 256 Robb-Agents-arm64.dmg
# Compare the result with SHA256SUMS.txt from the same release.
```

```powershell
# Windows PowerShell
Get-FileHash .\Robb-Agents-x64-Setup.exe -Algorithm SHA256
# Compare the Hash value with SHA256SUMS.txt from the same release.
```

### Signing status

Public GitHub Releases are fail-closed: they are created only after Developer ID + Apple notarization (macOS) and Authenticode verification (Windows). If signing credentials are unavailable, CI may retain unsigned test artifacts privately but cannot publish a release. Do not treat a local/ad-hoc build as a public release.

## Install

### macOS

1. Open the verified DMG.
2. Drag **Robb Agents** to **Applications**.
3. Open the application. For a signed/notarized release, macOS Gatekeeper should show the Robb Agents developer identity.

### Windows

1. Run the verified `Robb-Agents-x64-Setup.exe`.
2. Choose the per-user install directory if needed.
3. The installer creates Start Menu and desktop shortcuts and does not require administrator access.

### Linux

1. Download `Robb-Agents-x64.AppImage` and its matching checksum.
2. Make it executable: `chmod +x Robb-Agents-x64.AppImage`.
3. Run it locally; no system-wide installation is required.

### Build from source

Requirements: [Bun](https://bun.sh/) 1.3.9+, Node.js 20+, and platform build tooling (Xcode command-line tools on macOS; PowerShell 7/Windows build tools on Windows).

```bash
git clone https://github.com/robinswood-io/robb-agents.git
cd robinswood-agents
bun install --frozen-lockfile
bun run electron:start
```

Build a local distribution artifact:

```bash
# macOS (unsigned local smoke build)
bash apps/electron/scripts/build-dmg.sh arm64

# Windows PowerShell (unsigned local smoke build)
powershell -ExecutionPolicy Bypass -File apps/electron/scripts/build-win.ps1
```

Maintainers use `--release` / `-Release` only with externally supplied signing credentials. Tags must match the Electron version, and releases include checksum plus provenance evidence. See [the distribution guide](docs/robinswood/open-source-distribution.md).

## Providers

Robb keeps billing/authentication modes explicit:

- **Mistral Vibe subscription**: select *Mistral Vibe* in onboarding. Robb launches the official `vibe-acp --setup` browser flow; Vibe owns the local subscription credential and Robb never reads, copies, or stores it.
- **Mistral API**: use the separate generic API-key provider only for Mistral AI Studio pay-as-you-go access.
- **Gemini, ChatGPT/Codex, Claude, GitHub Copilot**: connect using their respective provider setup paths.

## Privacy and distribution policy

Read the complete [Privacy Policy](PRIVACY.md).

- Robb does **not** ship a Robinswood private updater, proxy, telemetry endpoint, credential service, or required cloud account.
- On first launch Robb uses the existing `~/.craft-agent` data root directly, so Craft Agents workspaces, sessions, sources, skills, projects, preferences and locally stored credentials remain available without copying or migration. Set `CRAFT_CONFIG_DIR` only when you deliberately want an isolated/local profile.
- GitHub Releases and self-hosted forks are the OSS distribution mechanism. Auto-update is deliberately disabled in this repository.
- Credentials remain in the selected provider’s normal local storage/OS keychain flow. Never commit `.env`, certificates, API keys, or tokens.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [distribution guide](docs/robinswood/open-source-distribution.md). Issues and pull requests are welcome.

## License and attribution

Robb Agents is licensed under the [MIT License](LICENSE). It preserves upstream Craft Agents attribution and Apache-2.0 license text in [NOTICE](NOTICE) and [LICENSE-APACHE](LICENSE-APACHE).
