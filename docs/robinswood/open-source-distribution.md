# Open-source distribution and release guide

Robb Agents is an MIT-licensed desktop application distributed from [GitHub Releases](https://github.com/robinswood-io/robinswood-agents/releases). This repository does not rely on a Robinswood updater, proxy, artifact bucket, password manager, or runtime service.

## Release artifacts

A version tag (`vX.Y.Z`) starts the **signed public release** workflow. It first checks that the tag exactly matches the Electron version, that no release already exists, and that all required signing secrets are available. If any check fails, no public GitHub Release is created. It then builds:

- macOS Apple Silicon DMG + ZIP;
- macOS Intel DMG + ZIP;
- Windows x64 NSIS installer;
- SHA-256 checksums for every artifact.

Artifacts are attached to the GitHub Release together with `SHA256SUMS.txt`, a release SBOM (`SBOM.spdx.json`), and platform provenance records. Consumers should obtain checksums from the same release and compare hashes before opening an installer. When the repository is public, GitHub also publishes Sigstore-backed build provenance attestations for the checksum subjects.

## Local builds

```bash
# macOS
bash apps/electron/scripts/build-dmg.sh arm64

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File apps/electron/scripts/build-win.ps1
```

These are intentionally unsigned local builds. The macOS build runs `robinswood-packaged-smoke.py`; the Windows build runs `robinswood-windows-packaged-smoke.py`. They are development artifacts, not public releases.

A manual GitHub Actions run in `test-artifacts` mode may build unsigned CI artifacts for verification, but it cannot publish a GitHub Release. This is intentional.

## Public release signing

The repository never contains signing identities, passwords, certificates, or Apple/Windows accounts.

### macOS

A distributable macOS release requires a Developer ID Application certificate and Apple notarization. Supply one certificate route (`CSC_LINK` + `CSC_KEY_PASSWORD`, or `CSC_NAME`) and one notarization route:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; or
- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`; or
- an approved local keychain profile.

Then run:

```bash
bash apps/electron/scripts/build-dmg.sh arm64 --release
```

The release smoke test requires a valid Developer ID signature, a successful Gatekeeper assessment, and a stapled notarization ticket. Do not publish if it fails.

### Windows

The current release workflow supports a valid Authenticode certificate provided as `CSC_LINK` with `CSC_KEY_PASSWORD`, or a configured `CSC_NAME` certificate:

```powershell
powershell -ExecutionPolicy Bypass -File apps/electron/scripts/build-win.ps1 -Release
```

Robb Agents is also prepared for the SignPath Foundation trusted-build route. It remains **inactive** until SignPath approves the project and provides the organization, project, policy, and artifact-configuration values. The official preparation checklist is in [`.signpath/README.md`](../../.signpath/README.md); do not add placeholder secrets or represent an unsigned installer as SignPath-signed.

The installer is per-user by default, supports a selectable install directory, and preserves user data on uninstall unless the user explicitly removes it.

## CI release secrets

GitHub Actions refuses to publish a version tag until all corresponding secrets are configured:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` plus Apple notarization secrets;
- Windows: `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`.

Store these values only as repository or organization Actions secrets. Never add a certificate, password, token, or API-key file to Git, a pull request, an issue, or an agent prompt.

The release workflow publishes provenance evidence (tag, commit SHA, platform and verified signing state), `SHA256SUMS.txt`, and an SPDX SBOM. Public repositories also publish GitHub/Sigstore build provenance attestations. Its Windows validation performs a real isolated install/uninstall and verifies that the installed Mistral Vibe ACP bridge is present.

## Public visibility and protected publication

Robb Agents is designed as a public open-source project. SignPath Foundation verification, GitHub Free branch protection, public GitHub artifact attestations, and public GitHub Release distribution all require the repository to be public. Until then, the release workflow remains technically fail-closed for unsigned publication but protected-environment reviewer rules and public attestations are unavailable.

Before changing repository visibility, run the explicit preflight against the candidate public ref:

```bash
python3 scripts/robinswood-public-preflight.py --ref robinswood/main
```

It checks current tracked content and all history reachable from that ref for known legacy private-distribution markers and common secret patterns. It complements, but does not replace, a dedicated history-aware secret scanner. If it fails, remediate or replace the reachable history before publishing.

The workflow declares a single `release` deployment environment. Once public visibility (or a GitHub plan supporting protected private environments) is available, configure it with at least one required reviewer and scope signing secrets to that environment rather than repository-wide secrets.

## Verification checklist

Before publishing a signed release:

1. GitHub validation passes on the tagged commit.
2. SHA-256 checksums match the released binaries.
3. macOS `codesign --verify`, `spctl --assess`, and `xcrun stapler validate` pass.
4. Windows installer starts successfully in a clean Windows environment and passes SmartScreen/Authenticode checks.
5. `SBOM.spdx.json` is present and `gh attestation verify` succeeds for public release artifacts.
6. The release contains no credentials, private endpoints, or duplicate/ambiguous artifacts.
