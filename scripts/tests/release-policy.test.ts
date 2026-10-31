import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const releaseWorkflow = ['.github/workflows/release.yml', 'scripts/robinswood-prepare-release-source.sh']
  .map(file => readFileSync(join(root, file), 'utf8')).join('\n')
const productionBuilder = readFileSync(
  join(root, 'apps', 'electron', 'electron-builder.yml'),
  'utf8',
)
const developmentBuilder = readFileSync(
  join(root, 'apps', 'electron', 'electron-builder.dev.yml'),
  'utf8',
)
const runtimeResourceBuilder = readFileSync(
  join(root, 'scripts', 'electron-build-resources.ts'),
  'utf8',
)
const electronPlatform = readFileSync(
  join(root, 'apps', 'electron', 'src', 'main', 'platform.ts'),
  'utf8',
)
const packageSecurityValidator = readFileSync(
  join(root, 'scripts', 'validate-electron-package-security.ts'),
  'utf8',
)
const windowsBuild = readFileSync(
  join(root, 'apps', 'electron', 'scripts', 'build-win.ps1'),
  'utf8',
)
const macBuild = readFileSync(
  join(root, 'apps', 'electron', 'scripts', 'build-dmg.sh'),
  'utf8',
)
const linuxBuild = readFileSync(
  join(root, 'apps', 'electron', 'scripts', 'build-linux.sh'),
  'utf8',
)
const windowsInstallerE2E = readFileSync(
  join(root, 'scripts', 'robinswood-windows-installer-e2e.ps1'),
  'utf8',
)
const sourceIntegrityHook = readFileSync(
  join(root, 'apps', 'electron', 'scripts', 'releaseIntegrity.ts'),
  'utf8',
)
const macSignatureHook = readFileSync(
  join(root, 'apps', 'electron', 'scripts', 'afterSign.ts'),
  'utf8',
)

describe('public release policy', () => {
  it('keeps release publication gated while allowing an explicit unsigned Windows policy', () => {
    expect(releaseWorkflow).toContain('options: [test-artifacts, stage-signed, publish-signed]')
    expect(releaseWorkflow).toContain('mode="${REQUESTED_MODE:-publish-signed}"')
    expect(releaseWorkflow).toContain('if [[ "$mode" == "publish-signed" ]]')
    expect(releaseWorkflow).toContain("WINDOWS_SIGNING_MODE: ${{ vars.WINDOWS_SIGNING_MODE || 'unsigned' }}")
    expect(releaseWorkflow).toContain("$signing = 'unsigned-public-release'")
    expect(releaseWorkflow).toContain('--windows-signing-mode')
    expect(releaseWorkflow).not.toContain('publish-unsigned')
    expect(releaseWorkflow).not.toContain('unsigned-github-release')
  })

  it('verifies Authenticode in signed modes and records explicit provenance in unsigned mode', () => {
    const authenticodeVerification = releaseWorkflow.indexOf('Get-AuthenticodeSignature')
    const installerVerification = releaseWorkflow.indexOf(
      "Assert-ValidAuthenticodeSignature $installer.FullName 'installer'",
    )
    const unpackedVerification = releaseWorkflow.indexOf(
      "Assert-ValidAuthenticodeSignature $unpackedBinary 'unpacked executable'",
    )
    const signedProvenance = releaseWorkflow.indexOf("$signing = 'verified-authenticode'")
    const manifestGeneration = releaseWorkflow.indexOf('Generate stable GitHub updater manifests')
    expect(authenticodeVerification).toBeGreaterThan(0)
    expect(releaseWorkflow).toContain("$unpackedBinary = 'apps/electron/release/win-unpacked/Robb Agents.exe'")
    expect(installerVerification).toBeGreaterThan(authenticodeVerification)
    expect(unpackedVerification).toBeGreaterThan(installerVerification)
    expect(signedProvenance).toBeGreaterThan(unpackedVerification)
    expect(manifestGeneration).toBeGreaterThan(authenticodeVerification)
    expect(releaseWorkflow).toContain('needs: [preflight, macos, windows, linux]')
    expect(releaseWorkflow).toContain("$args += '-Release'")
    expect(releaseWorkflow).toContain("$e2eArgs += '-RequireAuthenticode'")
    expect(releaseWorkflow).toContain("$signing = 'unsigned-public-release'")
    expect(releaseWorkflow).toContain("-ne 'unsigned') { $e2eArgs += '-RequireAuthenticode' }")

    const unpackedBuildVerification = windowsBuild.indexOf(
      'Assert-ValidAuthenticodeSignature $UnpackedBinary "unpacked Electron binary"',
    )
    const installerBuildVerification = windowsBuild.indexOf(
      'Assert-ValidAuthenticodeSignature $Installer.FullName "NSIS installer"',
    )
    expect(windowsBuild).toContain('if ($Release -and $SigningMode -ne "unsigned")')
    expect(windowsBuild).toContain('$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"')
    expect(unpackedBuildVerification).toBeGreaterThan(windowsBuild.indexOf('if ($Release)'))
    expect(installerBuildVerification).toBeGreaterThan(unpackedBuildVerification)
    expect(windowsBuild.indexOf('=== Build complete ===')).toBeGreaterThan(installerBuildVerification)
    expect(windowsInstallerE2E).toContain('[switch]$RequireAuthenticode')
    expect(windowsInstallerE2E).toContain('Get-AuthenticodeSignature $app')
  })

  it('pins every downstream checkout and embedded build commit to preflight source', () => {
    const pinnedCheckouts = releaseWorkflow.match(
      /ref: ["']?\$\{\{ needs\.preflight\.outputs\.source_commit \}\}["']?/g,
    ) ?? []
    expect(pinnedCheckouts).toHaveLength(4)
    expect(releaseWorkflow).toContain('ROBB_EXPECTED_SOURCE_COMMIT: "${{ needs.preflight.outputs.source_commit }}"')
    expect(releaseWorkflow).toContain('test "$robb_source_head" = "$ROBB_EXPECTED_SOURCE_COMMIT"')
    expect(releaseWorkflow).toContain('test -z "$robb_source_status"')
    expect(releaseWorkflow).not.toContain("needs.preflight.outputs.publish == 'true' && needs.preflight.outputs.tag || github.sha")
    expect(releaseWorkflow).toContain('tag="test-${source_commit::12}"')
    expect(releaseWorkflow.match(/ROBB_BUILD_COMMIT: \$\{\{ needs\.preflight\.outputs\.source_commit \}\}/g))
      .toHaveLength(3)
    expect(releaseWorkflow).toContain('Revalidate immutable release source')
    expect(releaseWorkflow).toContain("tag_commit=\"$(git rev-list -n 1 '${{ needs.preflight.outputs.tag }}')\"")
  })

  it('keeps production-profile packaging explicit and source-verified', () => {
    expect(macBuild).toContain('--local-production')
    expect(macBuild).toContain('LOCAL_PRODUCTION_BUILD=true')
    expect(macBuild).toContain('--config.mac.identity="$CSC_NAME" --config.mac.notarize=false')
    expect(macBuild).toContain('BUILDER_ARGS+=(--config.mac.notarize=true)')
    expect(macBuild).toContain('LOCAL_COMMIT="$(node "$SCRIPT_DIR/releaseIntegrity.ts" --check-source "$ROOT_DIR")"')
    expect(macBuild).toContain('it reads and writes ~/.craft-agent and must never be distributed')
    expect(windowsBuild).toContain('$env:ROBB_BUILD_CHANNEL = "production"')
    expect(windowsBuild).toContain('$env:ROBB_BUILD_CHANNEL = "development"')
    expect(windowsBuild).toContain('releaseIntegrity.ts')
    expect(linuxBuild).toContain('export ROBB_BUILD_CHANNEL=production')
    expect(linuxBuild).toContain('export ROBB_BUILD_CHANNEL=development')
    expect(linuxBuild).toContain('Linux arm64 is a local development artifact only')
    expect(sourceIntegrityHook).toContain('if (!requiresReleaseSourceIntegrity(context)) return')
    expect(macSignatureHook).toContain('if (!requiresMacReleaseIntegrity(context)) return')
    expect(releaseWorkflow).toContain("$env:ROBB_BUILD_CHANNEL = 'production'")
    expect(releaseWorkflow).toContain('bash apps/electron/scripts/build-linux.sh x64 --release')
    expect(releaseWorkflow).toContain('export ROBB_BUILD_CHANNEL=production')
  })

  it('uses packaged Windows resource paths and a dynamically allocated CDP port', () => {
    expect(windowsInstallerE2E).toContain('resources\\app\\resources\\pi-agent-server\\antigravity-server.js')
    expect(windowsInstallerE2E).toContain('resources\\app\\resources\\pi-agent-server\\vibe-acp-server.js')
    expect(windowsInstallerE2E).toContain('resources\\app\\resources\\bin\\win32-x64\\rtk.exe')
    expect(windowsInstallerE2E).toContain('[System.Net.Sockets.TcpListener]::new')
    expect(windowsInstallerE2E).toContain('Get-AvailableLoopbackPort')
    expect(windowsInstallerE2E).not.toContain('resources\\app\\dist\\resources')
    expect(windowsInstallerE2E).not.toContain('$DebugPort = 9229')
  })
})

describe('Electron package hardening policy', () => {
  it('uses the installed Electron version for production packaging', () => {
    const installedElectronManifest = readFileSync(
      join(root, 'node_modules', 'electron', 'package.json'),
      'utf8',
    )
    const installedVersion = installedElectronManifest.match(
      /^\s*"version"\s*:\s*"([^"]+)"/m,
    )?.[1]
    if (installedVersion === undefined) {
      throw new Error('Installed Electron package manifest has no version')
    }

    const packagedVersion = productionBuilder.match(
      /^electronVersion:\s*["']?([^"'\s]+)["']?/m,
    )?.[1]
    if (packagedVersion === undefined) {
      throw new Error('Production electron-builder config has no electronVersion')
    }

    expect(packagedVersion).toBe(installedVersion)
  })

  it('enables integrity-protected ASAR only for production packaging', () => {
    expect(productionBuilder).toContain('asar: true')
    expect(productionBuilder).toContain('enableEmbeddedAsarIntegrityValidation: true')
    expect(productionBuilder).toContain('onlyLoadAppFromAsar: true')
    expect(productionBuilder).toContain('to: app/dist/interceptor.cjs')
    expect(productionBuilder).toContain('to: app/resources')
    expect(developmentBuilder).toContain('asar: false')
    expect(developmentBuilder).toContain('electronFuses: null')
    expect(developmentBuilder).toContain('identity: "-"')
  })

  it('seals external JavaScript runtimes in ASAR and verifies them before bootstrap', () => {
    expect(runtimeResourceBuilder).toContain('createRuntimeIntegrityManifest(runtimeSources)')
    expect(runtimeResourceBuilder).toContain('dist/runtime-integrity-manifest.json')
    expect(electronPlatform).toContain('readFileSync(protectedManifestPath)')
    expect(electronPlatform).toContain('verifyRuntimeIntegrityManifest(')
    expect(electronPlatform).toContain('REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS')
    expect(packageSecurityValidator).toContain('extractFile(')
    expect(packageSecurityValidator).toContain('validateProtectedExternalRuntimeInventory(')
    expect(packageSecurityValidator).toContain('requiredRuntimeFiles')
  })
})
