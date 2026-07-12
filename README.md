# Robb Agents

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Validate](https://github.com/robinswood-io/robinswood-agents/actions/workflows/robinswood-validate.yml/badge.svg)](https://github.com/robinswood-io/robinswood-agents/actions/workflows/robinswood-validate.yml)

**Robb Agents** is a French-first, local-first desktop workspace for long-running AI agents. It is maintained by Robinswood as an independent **MIT-licensed** open-source distribution of Craft Agents OSS.

It includes multi-session workspaces, project/Kanban/task workflows, policy-first provider routing, local MCP/API sources, background agents, Gemini subscription OAuth, ChatGPT/Codex, Claude, Mistral API models, and Mistral Vibe subscription support.

## Downloads

Download the matching artifact from [GitHub Releases](https://github.com/robinswood-io/robinswood-agents/releases):

| Platform | Artifact |
| --- | --- |
| macOS Apple Silicon | `Robb-Agents-arm64.dmg` |
| macOS Intel | `Robb-Agents-x64.dmg` |
| Windows x64 | `Robb-Agents-x64-Setup.exe` |

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

Official public builds are intended to be signed with Developer ID + Apple notarization (macOS) and Authenticode (Windows). GitHub Release notes state when release credentials were unavailable and an artifact is unsigned. Do not treat a local/ad-hoc build as a public release.

## Install

### macOS

1. Open the verified DMG.
2. Drag **Robb Agents** to **Applications**.
3. Open the application. For a signed/notarized release, macOS Gatekeeper should show the Robb Agents developer identity.

### Windows

1. Run the verified `Robb-Agents-x64-Setup.exe`.
2. Choose the per-user install directory if needed.
3. The installer creates Start Menu and desktop shortcuts and does not require administrator access.

### Build from source

Requirements: [Bun](https://bun.sh/) 1.3.9+, Node.js 20+, and platform build tooling (Xcode command-line tools on macOS; PowerShell 7/Windows build tools on Windows).

```bash
git clone https://github.com/robinswood-io/robinswood-agents.git
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

Maintainers use `--release` / `-Release` only with externally supplied signing credentials. See [the distribution guide](docs/robinswood/open-source-distribution.md).

## Providers

Robb keeps billing/authentication modes explicit:

- **Mistral Vibe subscription**: select *Mistral Vibe* in onboarding. Robb launches the official `vibe-acp --setup` browser flow; Vibe owns the local subscription credential and Robb never reads, copies, or stores it.
- **Mistral API**: use the separate generic API-key provider only for Mistral AI Studio pay-as-you-go access.
- **Gemini, ChatGPT/Codex, Claude, GitHub Copilot**: connect using their respective provider setup paths.

## Privacy and distribution policy

- Robb does **not** ship a Robinswood private updater, proxy, telemetry endpoint, credential service, or required cloud account.
- `CRAFT_CONFIG_DIR` remains available for isolated/local configuration.
- GitHub Releases and self-hosted forks are the OSS distribution mechanism. Auto-update is deliberately disabled in this repository.
- Credentials remain in the selected provider’s normal local storage/OS keychain flow. Never commit `.env`, certificates, API keys, or tokens.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [distribution guide](docs/robinswood/open-source-distribution.md). Issues and pull requests are welcome.

## License and attribution

Robb Agents is licensed under the [MIT License](LICENSE). It preserves upstream Craft Agents attribution and Apache-2.0 license text in [NOTICE](NOTICE) and [LICENSE-APACHE](LICENSE-APACHE).
