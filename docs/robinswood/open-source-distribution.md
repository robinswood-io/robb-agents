# Open-source distribution and release guide

Robb Agents is an MIT-licensed desktop application distributed from [GitHub Releases](https://github.com/robinswood-io/robb-agents/releases). This repository does not rely on a Robinswood updater, proxy, artifact bucket, password manager, or runtime service.

## Release artifacts

A version tag (`vX.Y.Z`) is always a `publish-signed` request. The workflow has no public unsigned mode: macOS must be Developer ID signed, notarized and stapled; the Windows installer and application executable must both have valid Authenticode signatures; Linux remains checksum- and provenance-verified. The preflight checks that the tag exactly matches the Electron version, that every required signing route is configured, and that no release already exists. If any check fails, no public GitHub Release is created. It then builds:

- macOS Apple Silicon DMG + ZIP;
- macOS Intel DMG + ZIP;
- Windows x64 NSIS installer;
- Linux x64 AppImage;
- SHA-256 checksums for every artifact.

Artifacts are attached to the GitHub Release together with `SHA256SUMS.txt`, a release SBOM (`SBOM.spdx.json`), platform provenance records and the updater metadata `latest.yml`, `latest-mac.yml` and `latest-linux.yml`. The macOS manifest contains both x64 and arm64 ZIP entries. Consumers should obtain checksums from the same release and compare hashes before opening an installer. When the repository is public, GitHub also publishes Sigstore-backed build provenance attestations for the checksum subjects.

Each release also contains `install-app.sh` and `install-app.ps1`. They read the
same updater manifests as the desktop app, require one unambiguous artifact for
the detected platform, verify the declared byte size and SHA-512, and then:

- validate Developer ID/Gatekeeper before replacing the macOS application;
- validate Authenticode before launching the Windows per-user installer;
- install the Linux AppImage and launcher under the current user's home.

The helpers accept a pinned stable `X.Y.Z` version and never use a private
Robinswood or legacy Craft distribution endpoint.

The workflow accepts only stable `X.Y.Z` versions, checks out the immutable
matching tag for every platform, and marks the created release as GitHub's
latest stable release. While the release is still a non-public draft, it checks
the complete remote asset inventory, upload state, byte size and GitHub-computed
SHA-256 digest against the canonical local bundle. It then downloads the updater
manifests again and compares them byte-for-byte with the validated local copies.
Only after both checks does it publish the release and verify that GitHub's
`latest` API resolves to the new tag. Drafts and prereleases are not updater
sources.

Before publication, CI reconstructs one canonical checksum inventory after all
artifacts, manifests, provenance files, installer helpers and the SBOM exist.
`scripts/validate-release-bundle.ts` then rejects missing, duplicate,
ambiguous, tampered, CI-only unsigned or cross-version content. There is no
unsigned exception at the publication boundary. Pull requests also run
the manifest and installer contracts on macOS, Windows and Linux.

Production packages keep the Electron entrypoint and its main-process
JavaScript dependencies in an integrity-checked `app.asar`. Electron's embedded-ASAR
integrity validation and `OnlyLoadAppFromAsar` fuses are required. Native agent
binaries and explicitly spawned servers remain under `Resources/app` because
operating-system subprocess APIs cannot execute files from the virtual ASAR
filesystem. Development distributions keep ASAR and these fuses disabled.

Before packaging, the build creates a canonical SHA-256 inventory for every
external JavaScript runtime that can be bootstrapped by the application. A copy
of that manifest is protected inside `app.asar`; package validation compares it
with the assembled resources, and packaged startup verifies the same hashes
before any agent runtime starts. Missing, additional required, duplicated,
traversing, size-mismatched or hash-mismatched entries fail closed. Native
binaries are validated by their platform signing and packaging controls rather
than this JavaScript inventory because code signing can legitimately alter their
bytes.

## Development and production isolation

| Channel | Name | App ID | Data profile | Updates |
| --- | --- | --- | --- | --- |
| Production | Robb Agents | `io.robinswood.robbagents` | `~/.craft-agent` | Bounded availability checks; confirmed download/install from stable GitHub Releases only |
| Development | Robb Agents Dev | `io.robinswood.robbagents.dev` | `~/.craft-agent-dev` | Disabled |

Production checks availability 30 seconds after launch, then every six hours;
network failures retry with bounded exponential backoff. Concurrent manual and
automatic checks share one request, as do repeated download actions. On macOS,
the downloaded application is signature-, notarization- and version-checked,
copied to a staging directory beside the installed bundle, then exchanged with
an immediately restorable predecessor. Failed activation or post-copy validation
restores the previous bundle; only the three newest user-data backups are kept.

The development launcher also uses the `robbagentsdev` deep-link scheme and a
dedicated local server lock. Restarting it cannot terminate or acquire the
single-instance lock of the installed production application.

## Local builds

```bash
# macOS
bun run electron:dist:dev:mac

# Windows / Linux
bun run electron:dist:dev:win
bun run electron:dist:dev:linux
```

These are untrusted **Robb Agents Dev** builds with a distinct application
identity and output directory. Windows and Linux builds may be unsigned; macOS
uses only an ad-hoc identity so Apple Silicon can launch the local package.
They are development artifacts, not public releases, and cannot use the
production updater. The default macOS build disables certificate auto-discovery
explicitly; only `--release` may use a Developer ID identity and notarization
credentials.

A maintainer who needs to replace the application on their own Mac without
switching away from the existing `~/.craft-agent` chats, credentials and MCP
configuration can use:

```bash
bash apps/electron/scripts/build-dmg.sh arm64 --local-production
```

This mode requires a clean, identifiable Git commit and uses the production
profile and application identity. Its ad-hoc signature is deliberately not
release-grade: the resulting package must remain local and must never be
published or distributed.

Linux arm64 is available only as a local development-channel build with
`bash apps/electron/scripts/build-linux.sh arm64`. It has no public updater or
GitHub Release contract, and the script rejects `arm64 --release`; public Linux
releases remain x64-only.

Every packaged build also runs `scripts/robb_package_audit.py`. The audit fails
when a payload contains `release-artifacts`, an embedded
`apps/electron/release` tree, or a nested Robb installer. The current guardrails
are 900 MiB for an unpacked application and 450 MiB per compressed installer.
The smoke output includes a size inventory so increases are visible in CI.
The architecture is supplied by the platform build script; a single CI matrix
job builds only its requested architecture.

A verified macOS arm64 development build on 2026-07-23 measured 708.2 MiB
unpacked, including 447.2 MiB of application resources and 254.8 MiB of
frameworks. Its DMG measured 230.9 MiB and its ZIP 232.1 MiB. These values are a
measured baseline, not a cross-platform guarantee.

A manual GitHub Actions run in `test-artifacts` mode may build unsigned or
ad-hoc-signed CI artifacts for verification, but it cannot publish a GitHub
Release. Public release requests must use `publish-signed` and pass every
platform signing check.

## Public release signing

The repository never contains signing identities, passwords, certificates, or Apple/Windows accounts.

### macOS

A distributable macOS release requires a Developer ID Application certificate and Apple notarization. Supply one certificate route (`CSC_LINK` + `CSC_KEY_PASSWORD`, or `CSC_NAME`) and one notarization route:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; or
- local builds: `APPLE_API_KEY` (absolute path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`;
- GitHub Actions: `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`; or
- an approved local keychain profile.

Then run:

```bash
bash apps/electron/scripts/build-dmg.sh arm64 --release
```

The release smoke test requires a valid Developer ID signature, a successful Gatekeeper assessment, and a stapled notarization ticket. Do not publish if it fails.

### Windows

A public Windows release requires a valid Authenticode certificate provided as
`CSC_LINK` with `CSC_KEY_PASSWORD` (or a configured `CSC_NAME` certificate), or
Microsoft Artifact Signing Public Trust. Without one of these routes, the
workflow fails closed. Unsigned development artifacts may exist locally or in
CI for testing, but are never published:

```powershell
powershell -ExecutionPolicy Bypass -File apps/electron/scripts/build-win.ps1 -Release
```

Set `WINDOWS_SIGNING_MODE=pfx` for the PFX route or `azure` for Artifact Signing. The complete acquisition and GitHub configuration procedure is documented in [Signing certificates](signing-certificates.md).

Robb Agents was submitted to the SignPath Foundation program in July 2026 and was not accepted because the project did not yet have enough public trust/adoption signals. Do not add placeholder SignPath secrets or represent an unsigned installer as SignPath-signed. Reapply only after broader public recognition or use a paid SignPath subscription.

The installer is per-user by default, supports a selectable install directory, and preserves user data on uninstall unless the user explicitly removes it.

## CI release secrets

GitHub Actions refuses to publish a version tag unless macOS signing and one
Windows signing route are configured:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_TEAM_ID` plus either the Apple ID route or `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`;
- Windows PFX: variable `WINDOWS_SIGNING_MODE=pfx`, secrets `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`;
- Windows Artifact Signing: variable `WINDOWS_SIGNING_MODE=azure`, the four `WINDOWS_AZURE_*` variables, and secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

Store these values only as repository or organization Actions secrets. Never add a certificate, password, token, or API-key file to Git, a pull request, an issue, or an agent prompt.

The release workflow publishes provenance evidence (tag, commit SHA, platform and verified signing state), `SHA256SUMS.txt`, and an SPDX SBOM. Public repositories also publish GitHub/Sigstore build provenance attestations. Its Windows validation checks Authenticode on the unpacked application and NSIS installer, performs a real isolated install/uninstall, rechecks the installed executable, and verifies that the installed Mistral Vibe ACP bridge is present.

## Public visibility and protected publication

Robb Agents is designed as a public open-source project. GitHub artifact attestations and public GitHub Release distribution require the repository to be public. Release publication remains behind the `release` deployment environment, requires verified signing evidence for macOS and Windows, and preserves explicit provenance for every platform.

Before changing repository visibility, run the explicit preflight against the candidate public ref:

```bash
python3 scripts/robinswood-public-preflight.py --ref robinswood/main
```

It checks current tracked content and all history reachable from that ref for known legacy private-distribution markers and common secret patterns. It complements, but does not replace, a dedicated history-aware secret scanner. If it fails, remediate or replace the reachable history before publishing.

The workflow declares a single `release` deployment environment as its publication boundary. Configure it with at least one required reviewer. Signing secrets currently remain repository or organization Actions secrets because the preflight and platform build jobs need them before the protected publication job starts.

## Verification checklist

Before publishing a public release:

1. GitHub validation and the macOS/Windows/Linux release-contract matrix pass on the tagged commit.
2. SHA-256 checksums match the released binaries.
3. macOS `codesign --verify`, `spctl --assess`, and `xcrun stapler validate` pass.
4. Windows Authenticode is valid for the unpacked, installer and installed executables before provenance is accepted, and the installer starts successfully in a clean Windows environment.
5. `SBOM.spdx.json` is present and `gh attestation verify` succeeds for public release artifacts.
6. The release contains no credentials, private endpoints, or duplicate/ambiguous artifacts.
7. `latest.yml`, `latest-mac.yml` and `latest-linux.yml` reference only the verified stable release artifacts.
8. `install-app.sh` and `install-app.ps1` are present in the canonical checksum inventory.
