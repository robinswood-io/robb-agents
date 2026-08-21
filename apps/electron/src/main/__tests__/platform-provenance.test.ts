import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronPlatform, resolveElectronRuntimeAppRoot } from '../platform'
import {
  createRuntimeIntegrityManifest,
  REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
  RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH,
  serializeRuntimeIntegrityManifest,
} from '@craft-agent/shared/agent'

let temporaryDirectory: string | undefined

function prepareProtectedRuntime(
  resourcesPath: string,
  appAsarPath: string,
  manifestPaths: readonly string[] = REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
): Map<string, string> {
  const runtimeFiles = new Map<string, string>()
  for (const relativePath of REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS) {
    const runtimeFile = join(resourcesPath, ...relativePath.split('/'))
    mkdirSync(join(runtimeFile, '..'), { recursive: true })
    writeFileSync(runtimeFile, `trusted runtime: ${relativePath}\n`)
    runtimeFiles.set(relativePath, runtimeFile)
  }
  const manifestPath = join(appAsarPath, RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH)
  mkdirSync(join(manifestPath, '..'), { recursive: true })
  writeFileSync(manifestPath, serializeRuntimeIntegrityManifest(createRuntimeIntegrityManifest(
    manifestPaths.map((path) => ({ path, sourcePath: runtimeFiles.get(path)! })),
  )))
  return runtimeFiles
}

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe('Electron platform build provenance', () => {
  it('exposes the packaged app version and canonical build metadata', () => {
    const platform = createElectronPlatform({
      app: {
        isPackaged: true,
        getAppPath: () => '/Applications/Robb Agents.app',
        getVersion: () => '0.11.7',
        quit() {},
      } as never,
      nativeImage: {} as never,
      shell: {} as never,
      nativeTheme: { shouldUseDarkColors: false } as never,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      isDebugMode: false,
      buildCommit: ' abc123 ',
      buildChannel: ' production ',
      buildDirty: false,
    })

    expect(platform.appVersion).toBe('0.11.7')
    expect(platform.isPackaged).toBe(true)
    expect(platform.buildCommit).toBe('abc123')
    expect(platform.buildChannel).toBe('production')
    expect(platform.buildDirty).toBe(false)
  })

  it('uses the external Resources/app root for an ASAR production package', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'robb-asar-root-'))
    const resourcesPath = join(temporaryDirectory, 'Resources')
    const externalRoot = join(resourcesPath, 'app')
    const appAsarPath = join(resourcesPath, 'app.asar')
    prepareProtectedRuntime(resourcesPath, appAsarPath)

    const resolved = resolveElectronRuntimeAppRoot({
      isPackaged: true,
      getAppPath: () => appAsarPath,
    }, resourcesPath)

    expect(resolved).toBe(externalRoot)
  })

  it('fails closed before bootstrap when an external runtime differs from the protected manifest', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'robb-asar-tampered-'))
    const resourcesPath = join(temporaryDirectory, 'Resources')
    const appAsarPath = join(resourcesPath, 'app.asar')
    const runtimeFiles = prepareProtectedRuntime(resourcesPath, appAsarPath)
    writeFileSync(runtimeFiles.get('app/dist/interceptor.cjs')!, 'tampered runtime\n')

    expect(() => resolveElectronRuntimeAppRoot({
      isPackaged: true,
      getAppPath: () => appAsarPath,
    }, resourcesPath)).toThrow(/External runtime (size|SHA-256) mismatch/)
  })

  it('fails closed when the protected manifest omits a required runtime', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'robb-asar-omitted-'))
    const resourcesPath = join(temporaryDirectory, 'Resources')
    const appAsarPath = join(resourcesPath, 'app.asar')
    prepareProtectedRuntime(
      resourcesPath,
      appAsarPath,
      REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS.slice(1),
    )

    expect(() => resolveElectronRuntimeAppRoot({
      isPackaged: true,
      getAppPath: () => appAsarPath,
    }, resourcesPath)).toThrow('absent from protected manifest')
  })

  it('fails closed when an ASAR package omits its external runtime root', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'robb-asar-missing-'))
    const resourcesPath = join(temporaryDirectory, 'Resources')
    mkdirSync(resourcesPath, { recursive: true })

    expect(() => resolveElectronRuntimeAppRoot({
      isPackaged: true,
      getAppPath: () => join(resourcesPath, 'app.asar'),
    }, resourcesPath)).toThrow('Packaged runtime root is missing')
  })
})
