# Open-source distribution and release guide

Robb Agents is an MIT-licensed desktop application distributed from [GitHub Releases](https://github.com/robinswood-io/robb-agents/releases). This repository does not rely on a Robinswood updater, proxy, artifact bucket, password manager, or runtime service.

## Release artifacts

A version tag (`vX.Y.Z`) starts the public release workflow. By default, tag pushes publish in `publish-unsigned` mode: macOS remains Developer ID signed and notarized, Linux is checksum/provenance verified, and the Windows installer is intentionally published without Authenticode until a public Windows signing route is available. Manual workflow runs can still choose `publish-signed` once Windows PFX, Microsoft Artifact Signing, or another trusted signing route is configured. The preflight checks that the tag exactly matches the Electron version and that no release already exists. If any required check for the selected mode fails, no public GitHub Release is created. It then builds:

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
- validate Authenticode before launching the Windows per-user installer when the release is `publish-signed`; for `publish-unsigned`, clearly warn that Windows will show an unknown-publisher/SmartScreen prompt and require checksum verification;
- install the Linux AppImage and launcher under the current user's home.

The helpers accept a pinned stable `X.Y.Z` version and never use a private
Robinswood or legacy Craft distribution endpoint.

The workflow accepts only stable `X.Y.Z` versions, checks out the immutable
matching tag for every platform, and marks the created release as GitHub's
latest stable release. Drafts and prereleases are not updater sources.

Before publication, CI reconstructs one canonical checksum inventory after all
artifacts, manifests, provenance files, installer helpers and the SBOM exist.
`scripts/validate-release-bundle.ts` then rejects missing, duplicate,
ambiguous, tampered, CI-only unsigned or cross-version content. The only unsigned public exception is the explicit `unsigned-github-release` Windows provenance state in `publish-unsigned` mode. Pull requests also run
the manifest and installer contracts on macOS, Windows and Linux.

## Development and production isolation

| Channel | Name | App ID | Data profile | Updates |
| --- | --- | --- | --- | --- |
| Production | Robb Agents | `io.robinswood.robbagents` | `~/.craft-agent` | Settings button, stable GitHub Release only |
| Development | Robb Agents Dev | `io.robinswood.robbagents.dev` | `~/.craft-agent-dev` | Disabled |

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

These are intentionally unsigned **Robb Agents Dev** builds with a distinct
application identity and output directory. They are development artifacts, not
public releases and cannot use the production updater.

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

A manual GitHub Actions run in `test-artifacts` mode may build unsigned CI artifacts for verification, but it cannot publish a GitHub Release. Use `publish-unsigned` for the current public GitHub Release strategy with an explicitly unsigned Windows installer.

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

The current public GitHub Release strategy publishes Windows as an explicitly unsigned installer (`signing=unsigned-github-release`) with checksums, provenance, SBOM and a release-note warning. This is intentional while Robb Agents lacks an accepted free SignPath Foundation route or another public Windows signing identity.

A fully signed Windows release remains supported when a valid Authenticode certificate is provided as `CSC_LINK` with `CSC_KEY_PASSWORD` (or a configured `CSC_NAME` certificate), or when Microsoft Artifact Signing Public Trust is configured:

```powershell
powershell -ExecutionPolicy Bypass -File apps/electron/scripts/build-win.ps1 -Release
```

Set `WINDOWS_SIGNING_MODE=pfx` for the PFX route or `azure` for Artifact Signing. The complete acquisition and GitHub configuration procedure is documented in [Signing certificates](signing-certificates.md).

Robb Agents was submitted to the SignPath Foundation program in July 2026 and was not accepted because the project did not yet have enough public trust/adoption signals. Do not add placeholder SignPath secrets or represent an unsigned installer as SignPath-signed. Reapply only after broader public recognition or use a paid SignPath subscription.

The installer is per-user by default, supports a selectable install directory, and preserves user data on uninstall unless the user explicitly removes it.

## CI release secrets

GitHub Actions refuses to publish a version tag unless the selected mode has the corresponding secrets configured:

- `publish-unsigned`: macOS requires `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_TEAM_ID` plus either the Apple ID route or `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Windows secrets are intentionally not required and the Windows provenance is `unsigned-github-release`.
- `publish-signed` with Windows PFX: variable `WINDOWS_SIGNING_MODE=pfx`, secrets `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`.
- `publish-signed` with Windows Artifact Signing: variable `WINDOWS_SIGNING_MODE=azure`, the four `WINDOWS_AZURE_*` variables, and secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

Store these values only as repository or organization Actions secrets. Never add a certificate, password, token, or API-key file to Git, a pull request, an issue, or an agent prompt.

The release workflow publishes provenance evidence (tag, commit SHA, platform and verified signing state), `SHA256SUMS.txt`, and an SPDX SBOM. Public repositories also publish GitHub/Sigstore build provenance attestations. Its Windows validation performs a real isolated install/uninstall and verifies that the installed Mistral Vibe ACP bridge is present.

## Public visibility and protected publication

Robb Agents is designed as a public open-source project. GitHub artifact attestations and public GitHub Release distribution require the repository to be public. The workflow now permits the deliberate `publish-unsigned` Windows path, while keeping release publication behind the `release` deployment environment and preserving explicit provenance for every platform.

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
4. Windows installer starts successfully in a clean Windows environment. In `publish-signed`, Authenticode must be valid; in `publish-unsigned`, confirm the release notes and provenance state the unknown-publisher/SmartScreen limitation explicitly.
5. `SBOM.spdx.json` is present and `gh attestation verify` succeeds for public release artifacts.
6. The release contains no credentials, private endpoints, or duplicate/ambiguous artifacts.
7. `latest.yml`, `latest-mac.yml` and `latest-linux.yml` reference only the stable release artifacts for the selected mode.
8. `install-app.sh` and `install-app.ps1` are present in the canonical checksum inventory.
