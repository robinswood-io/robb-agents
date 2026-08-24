import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createPackage } from '@electron/asar'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveElectronFuseBinary,
  validateProtectedExternalRuntimeInventory,
  validateElectronPackageSecurityLayout,
  validatePackagedWhatsAppWorkerProvenance,
  validateRequiredElectronFuses,
} from '../validate-electron-package-security'
import {
  createRuntimeIntegrityManifest,
  REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
  RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH,
  serializeRuntimeIntegrityManifest,
} from '../../packages/shared/src/agent/backend/internal/runtime-integrity'

const sourceIntegrity = require('../../apps/electron/scripts/releaseIntegrity.cjs')
const signatureIntegrity = require('../../apps/electron/scripts/afterSign.cjs')

let fixtureDirectory: string | undefined

afterEach(() => {
  if (fixtureDirectory) {
    rmSync(fixtureDirectory, { recursive: true, force: true })
    fixtureDirectory = undefined
  }
})

function createCleanRepository(): string {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'robb-release-source-'))
  execFileSync('git', ['init', '--quiet'], { cwd: fixtureDirectory })
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: fixtureDirectory })
  execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: fixtureDirectory })
  writeFileSync(join(fixtureDirectory, 'tracked.txt'), 'clean\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: fixtureDirectory })
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: fixtureDirectory })
  return fixtureDirectory
}

describe('cross-platform release source integrity', () => {
  it('accepts an exact clean Git commit and rejects subsequent tracked or untracked changes', () => {
    const repository = createCleanRepository()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim()

    expect(sourceIntegrity.inspectReleaseSource(repository, {})).toBe(commit)
    expect(sourceIntegrity.inspectReleaseSource(repository, {
      ROBB_BUILD_COMMIT: commit,
      ROBB_BUILD_DIRTY: 'false',
    })).toBe(commit)
    expect(() => sourceIntegrity.inspectReleaseSource(repository, {
      ROBB_BUILD_COMMIT: '0'.repeat(40),
      ROBB_BUILD_DIRTY: 'false',
    })).toThrow('does not match checkout')

    writeFileSync(join(repository, 'untracked.txt'), 'dirty\n')
    expect(() => sourceIntegrity.inspectReleaseSource(repository, {
      ROBB_BUILD_DIRTY: 'false',
    })).toThrow('uncommitted or untracked changes')
  })

  it('does not let declared clean metadata hide dirty Git state', () => {
    expect(() => sourceIntegrity.validateReleaseSourceState({
      declaredDirty: 'false',
      gitPorcelain: ' M tracked.txt\n',
    })).toThrow('uncommitted or untracked changes')
    expect(() => sourceIntegrity.validateReleaseSourceState({
      declaredDirty: undefined,
      gitPorcelain: undefined,
    })).toThrow('clean source state could not be verified')
  })

  it('enforces source integrity for every production channel and keeps signature checks macOS-only', () => {
    const context = (forceCodeSigning: boolean, platform = 'darwin') => ({
      electronPlatformName: platform,
      packager: { platformSpecificBuildOptions: { forceCodeSigning } },
    })
    expect(sourceIntegrity.requiresMacReleaseIntegrity(context(true))).toBe(true)
    expect(sourceIntegrity.requiresMacReleaseIntegrity(context(false))).toBe(false)
    expect(sourceIntegrity.requiresMacReleaseIntegrity(context(true, 'linux'))).toBe(false)
    expect(sourceIntegrity.requiresReleaseSourceIntegrity(
      context(false, 'linux'),
      { ROBB_BUILD_CHANNEL: 'production' },
    )).toBe(true)
    expect(sourceIntegrity.requiresReleaseSourceIntegrity(
      context(false, 'win32'),
      { ROBB_BUILD_CHANNEL: 'production' },
    )).toBe(true)
    expect(sourceIntegrity.requiresReleaseSourceIntegrity(
      context(true),
      { ROBB_BUILD_CHANNEL: 'development' },
    )).toBe(false)
    expect(sourceIntegrity.requiresReleaseSourceIntegrity(context(true), {})).toBe(true)
    expect(sourceIntegrity.requiresReleaseSourceIntegrity(context(false, 'linux'), {})).toBe(false)
  })
})

describe('macOS release signature integrity', () => {
  const developerIdInspection = [
    'Identifier=io.robinswood.robbagents',
    'Authority=Developer ID Application: Robinswood (ABCDE12345)',
    'TeamIdentifier=ABCDE12345',
  ].join('\n')

  it('accepts only the expected Developer ID Application identity', () => {
    expect(() => signatureIntegrity.validateDeveloperIdInspection(
      0,
      developerIdInspection,
    )).not.toThrow()
    expect(() => signatureIntegrity.validateDeveloperIdInspection(
      0,
      'Identifier=io.robinswood.robbagents\nSignature=adhoc\nTeamIdentifier=not set',
    )).toThrow('ad-hoc signed')
    expect(() => signatureIntegrity.validateDeveloperIdInspection(
      0,
      'Identifier=io.robinswood.robbagents\nAuthority=Apple Development: Dev\nTeamIdentifier=ABCDE12345',
    )).toThrow('not a Developer ID Application signature')
  })

  it('requires verifiable code, Gatekeeper notarization, and a stapled ticket', () => {
    const valid = {
      codesign: { returncode: 0, text: 'valid on disk' },
      gatekeeper: { returncode: 0, text: 'source=Notarized Developer ID' },
      stapler: { returncode: 0, text: 'The validate action worked!' },
    }
    expect(() => signatureIntegrity.validateReleaseVerificationResults(valid)).not.toThrow()
    expect(() => signatureIntegrity.validateReleaseVerificationResults({
      ...valid,
      codesign: { returncode: 1, text: 'invalid signature' },
    })).toThrow('signature verification failed')
    expect(() => signatureIntegrity.validateReleaseVerificationResults({
      ...valid,
      gatekeeper: { returncode: 0, text: 'source=Developer ID' },
    })).toThrow('Notarization assessment failed')
    expect(() => signatureIntegrity.validateReleaseVerificationResults({
      ...valid,
      stapler: { returncode: 1, text: 'ticket missing' },
    })).toThrow('ticket validation failed')
  })
})

function writeFixtureFile(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'fixture')
}

function prepareSecurityLayout(): string {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'robb-electron-security-'))
  const resourcesDir = join(fixtureDirectory, 'resources')
  writeFixtureFile(join(resourcesDir, 'app.asar'))
  for (const relativePath of [
    'dist/interceptor.cjs',
    'resources/bridge-mcp-server/index.js',
    'resources/session-mcp-server/index.js',
    'resources/pi-agent-server/index.js',
    'resources/pi-agent-server/vibe-acp-server.js',
    'webui/index.html',
  ]) {
    writeFixtureFile(join(resourcesDir, 'app', relativePath))
  }
  return resourcesDir
}

describe('packaged Electron security contract', () => {
  it('requires exact Git provenance in the packaged WhatsApp worker', () => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'robb-worker-provenance-'))
    const resourcesDir = join(fixtureDirectory, 'resources')
    const workerPath = join(resourcesDir, 'messaging-whatsapp-worker', 'worker.cjs')
    writeFixtureFile(workerPath)

    expect(() => validatePackagedWhatsAppWorkerProvenance(resourcesDir, '1'.repeat(40)))
      .toThrow('has no embedded Git provenance')

    writeFileSync(workerPath, 'const provenance = "robb-wa-worker-git:111111111111"')
    expect(validatePackagedWhatsAppWorkerProvenance(resourcesDir, '1'.repeat(40)))
      .toBe('111111111111')

    writeFileSync(workerPath, 'const provenance = "robb-wa-worker-git:111111111111+dirty"')
    expect(() => validatePackagedWhatsAppWorkerProvenance(resourcesDir, '1'.repeat(40)))
      .toThrow('provenance mismatch')

    writeFileSync(workerPath, 'const provenance = "robb-wa-worker-git:222222222222"')
    expect(() => validatePackagedWhatsAppWorkerProvenance(resourcesDir, '1'.repeat(40)))
      .toThrow('provenance mismatch')
  })

  it('keeps the main entrypoint in ASAR and only explicit subprocess runtimes outside it', () => {
    const resourcesDir = prepareSecurityLayout()

    const layout = validateElectronPackageSecurityLayout(resourcesDir)

    expect(layout.appAsarPath).toBe(join(resourcesDir, 'app.asar'))
    expect(layout.requiredRuntimeFiles).toHaveLength(6)

    writeFixtureFile(join(resourcesDir, 'app', 'dist', 'main.cjs'))
    expect(() => validateElectronPackageSecurityLayout(resourcesDir))
      .toThrow('Electron main entrypoint must remain inside app.asar')
  })

  it('rejects a missing external subprocess runtime', () => {
    const resourcesDir = prepareSecurityLayout()
    rmSync(join(resourcesDir, 'app', 'resources', 'session-mcp-server', 'index.js'))

    expect(() => validateElectronPackageSecurityLayout(resourcesDir))
      .toThrow('external runtime file resources/session-mcp-server/index.js')
  })

  it('requires both ASAR integrity fuses to be enabled', () => {
    const enabledWire = [{ version: 1, states: [48, 48, 48, 48, 49, 49] }]
    expect(() => validateRequiredElectronFuses(enabledWire)).not.toThrow()

    const missingOnlyLoad = [{ version: 1, states: [48, 48, 48, 48, 49, 48] }]
    expect(() => validateRequiredElectronFuses(missingOnlyLoad))
      .toThrow('OnlyLoadAppFromAsar')
  })

  it('reads macOS fuses from Electron Framework instead of the launcher', () => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'robb-electron-fuses-'))
    const launcher = join(
      fixtureDirectory,
      'Robb Agents.app',
      'Contents',
      'MacOS',
      'Robb Agents',
    )
    const framework = join(
      fixtureDirectory,
      'Robb Agents.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    )
    writeFixtureFile(launcher)
    writeFixtureFile(framework)

    expect(resolveElectronFuseBinary(launcher)).toBe(framework)
  })

  it('extracts the protected ASAR manifest and rejects assembled runtime tampering', async () => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'robb-runtime-asar-'))
    const resourcesDir = join(fixtureDirectory, 'resources')
    const runtimeFiles = REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS.map((path) => {
      const sourcePath = join(resourcesDir, ...path.split('/'))
      writeFixtureFile(sourcePath)
      return { path, sourcePath }
    })
    const manifest = createRuntimeIntegrityManifest(runtimeFiles)
    const asarSource = join(fixtureDirectory, 'asar-source')
    const protectedManifest = join(asarSource, RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH)
    mkdirSync(join(protectedManifest, '..'), { recursive: true })
    writeFileSync(protectedManifest, serializeRuntimeIntegrityManifest(manifest))
    const appAsarPath = join(resourcesDir, 'app.asar')
    mkdirSync(resourcesDir, { recursive: true })
    await createPackage(asarSource, appAsarPath)

    expect(validateProtectedExternalRuntimeInventory(appAsarPath, resourcesDir))
      .toHaveLength(REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS.length)
    writeFileSync(runtimeFiles[0]!.sourcePath, 'tampered')
    expect(() => validateProtectedExternalRuntimeInventory(appAsarPath, resourcesDir))
      .toThrow(/External runtime (size|SHA-256) mismatch/)
  })

  it('rejects a protected manifest that omits a required external runtime', async () => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'robb-runtime-omitted-'))
    const resourcesDir = join(fixtureDirectory, 'resources')
    const runtimeFiles = REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS.map((path) => {
      const sourcePath = join(resourcesDir, ...path.split('/'))
      writeFixtureFile(sourcePath)
      return { path, sourcePath }
    })
    const manifest = createRuntimeIntegrityManifest(runtimeFiles.slice(1))
    const asarSource = join(fixtureDirectory, 'asar-source')
    const protectedManifest = join(asarSource, RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH)
    mkdirSync(join(protectedManifest, '..'), { recursive: true })
    writeFileSync(protectedManifest, serializeRuntimeIntegrityManifest(manifest))
    const appAsarPath = join(resourcesDir, 'app.asar')
    await createPackage(asarSource, appAsarPath)

    expect(() => validateProtectedExternalRuntimeInventory(appAsarPath, resourcesDir))
      .toThrow('absent from protected manifest')
  })
})

const root = join(import.meta.dir, '..', '..')
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
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
  join(root, 'apps', 'electron', 'scripts', 'releaseIntegrity.cjs'),
  'utf8',
)
const macSignatureHook = readFileSync(
  join(root, 'apps', 'electron', 'scripts', 'afterSign.cjs'),
  'utf8',
)

describe('public release policy', () => {
  it('has no public unsigned mode and maps pushed tags to signed publication', () => {
    expect(releaseWorkflow).toContain('options: [test-artifacts, publish-signed]')
    expect(releaseWorkflow).toContain('mode="${REQUESTED_MODE:-publish-signed}"')
    expect(releaseWorkflow).toContain('if [[ "$mode" == "publish-signed" ]]')
    expect(releaseWorkflow).not.toContain('publish-unsigned')
    expect(releaseWorkflow).not.toContain('unsigned-github-release')
    expect(releaseWorkflow).not.toContain('allow-unsigned-windows')
  })

  it('verifies the installer and unpacked Windows executable before signed provenance and publication', () => {
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

    const unpackedBuildVerification = windowsBuild.indexOf(
      'Require-ValidAuthenticodeSignature $UnpackedBinary "unpacked Electron binary"',
    )
    const installerBuildVerification = windowsBuild.indexOf(
      'Require-ValidAuthenticodeSignature $Installer.FullName "NSIS installer"',
    )
    expect(unpackedBuildVerification).toBeGreaterThan(windowsBuild.indexOf('if ($Release)'))
    expect(installerBuildVerification).toBeGreaterThan(unpackedBuildVerification)
    expect(windowsBuild.indexOf('=== Build complete ===')).toBeGreaterThan(installerBuildVerification)
    expect(windowsInstallerE2E).toContain('[switch]$RequireAuthenticode')
    expect(windowsInstallerE2E).toContain('Get-AuthenticodeSignature $app')
  })

  it('pins every downstream checkout and embedded build commit to preflight source', () => {
    const pinnedCheckouts = releaseWorkflow.match(
      /ref: \$\{\{ needs\.preflight\.outputs\.source_commit \}\}/g,
    ) ?? []
    expect(pinnedCheckouts).toHaveLength(5)
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
    expect(macBuild).toContain('LOCAL_COMMIT="$(node "$SCRIPT_DIR/releaseIntegrity.cjs" --check-source "$ROOT_DIR")"')
    expect(macBuild).toContain('it reads and writes ~/.craft-agent and must never be distributed')
    expect(windowsBuild).toContain('$env:ROBB_BUILD_CHANNEL = "production"')
    expect(windowsBuild).toContain('$env:ROBB_BUILD_CHANNEL = "development"')
    expect(windowsBuild).toContain('releaseIntegrity.cjs')
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
    expect(windowsInstallerE2E).toContain('resources\\app\\resources\\pi-agent-server\\vibe-acp-server.js')
    expect(windowsInstallerE2E).toContain('resources\\app\\resources\\bin\\win32-x64\\rtk.exe')
    expect(windowsInstallerE2E).toContain('[System.Net.Sockets.TcpListener]::new')
    expect(windowsInstallerE2E).toContain('Get-AvailableLoopbackPort')
    expect(windowsInstallerE2E).not.toContain('resources\\app\\dist\\resources')
    expect(windowsInstallerE2E).not.toContain('$DebugPort = 9229')
  })
})

describe('Electron package hardening policy', () => {
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
