import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { extractFile } from '@electron/asar'
import {
  REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
  RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH,
  verifyRuntimeIntegrityManifest,
} from '../packages/shared/src/agent/backend/internal/runtime-integrity'

// @electron/fuses represents enabled fuses with the ASCII byte for "1".
const FUSE_ENABLED = 49
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
const REQUIRED_FUSES = [
  { index: 4, name: 'EnableEmbeddedAsarIntegrityValidation' },
  { index: 5, name: 'OnlyLoadAppFromAsar' },
] as const

const REQUIRED_EXTERNAL_RUNTIME_FILES = [
  'dist/interceptor.cjs',
  'resources/bridge-mcp-server/index.js',
  'resources/session-mcp-server/index.js',
  'resources/pi-agent-server/index.js',
  'resources/pi-agent-server/vibe-acp-server.js',
  'webui/index.html',
] as const

export interface ElectronPackageSecurityLayout {
  appAsarPath: string
  externalRuntimeRoot: string
  requiredRuntimeFiles: string[]
}

function requireRegularFile(path: string, description: string): void {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`Missing or empty ${description}: ${path}`)
  }
}

export function validateElectronPackageSecurityLayout(
  resourcesDir: string,
): ElectronPackageSecurityLayout {
  const resolvedResourcesDir = resolve(resourcesDir)
  const appAsarPath = join(resolvedResourcesDir, 'app.asar')
  const externalRuntimeRoot = join(resolvedResourcesDir, 'app')
  requireRegularFile(appAsarPath, 'production app.asar')

  if (!existsSync(externalRuntimeRoot) || !statSync(externalRuntimeRoot).isDirectory()) {
    throw new Error(`Missing external packaged runtime root: ${externalRuntimeRoot}`)
  }

  const escapedEntrypoint = join(externalRuntimeRoot, 'dist', 'main.cjs')
  if (existsSync(escapedEntrypoint)) {
    throw new Error(`Electron main entrypoint must remain inside app.asar: ${escapedEntrypoint}`)
  }

  const requiredRuntimeFiles = REQUIRED_EXTERNAL_RUNTIME_FILES.map((relativePath) => {
    const path = join(externalRuntimeRoot, relativePath)
    requireRegularFile(path, `external runtime file ${relativePath}`)
    return path
  })

  return { appAsarPath, externalRuntimeRoot, requiredRuntimeFiles }
}

export interface ElectronFuseWire {
  version: number
  states: number[]
}

export interface ValidatedElectronPackageSecurity extends ElectronPackageSecurityLayout {
  protectedRuntimeManifestPath: string
  verifiedRuntimeFiles: string[]
  whatsAppWorkerGitSha: string
}

/**
 * Verify that the packaged WhatsApp subprocess came from the canonical build
 * path and carries the revision requested by a production packaging wrapper.
 */
export function validatePackagedWhatsAppWorkerProvenance(
  resourcesDir: string,
  expectedCommit?: string,
): string {
  const workerPath = join(resolve(resourcesDir), 'messaging-whatsapp-worker', 'worker.cjs')
  requireRegularFile(workerPath, 'packaged WhatsApp worker')
  const workerSource = readFileSync(workerPath, 'utf8')
  const marker = /robb-wa-worker-git:([0-9a-f]{7,40})(\+dirty)?/i.exec(workerSource)
  if (!marker) {
    throw new Error(`Packaged WhatsApp worker has no embedded Git provenance: ${workerPath}`)
  }

  const embeddedSha = marker[1]!.toLowerCase()
  const dirtySuffix = marker[2] ?? ''
  const declaredCommit = expectedCommit?.trim().toLowerCase()
  if (declaredCommit) {
    if (!/^[0-9a-f]{7,40}$/.test(declaredCommit)) {
      throw new Error(`Invalid expected WhatsApp worker commit: ${expectedCommit}`)
    }
    const expectedSha = declaredCommit.slice(0, 12)
    if (embeddedSha !== expectedSha || dirtySuffix) {
      throw new Error(
        `Packaged WhatsApp worker provenance mismatch: expected ${expectedSha}, found ${embeddedSha}${dirtySuffix}`,
      )
    }
  }
  return `${embeddedSha}${dirtySuffix}`
}

export function resolveElectronFuseBinary(electronBinary: string): string {
  const resolvedBinary = resolve(electronBinary)
  if (!/\.app[\\/]/.test(resolvedBinary)) return resolvedBinary

  // On macOS, @electron/fuses stores the wire in Electron Framework rather
  // than in the small executable under Contents/MacOS.
  const frameworkBinary = resolve(
    resolvedBinary,
    '..',
    '..',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework',
  )
  requireRegularFile(frameworkBinary, 'packaged Electron framework binary')
  return frameworkBinary
}

export function readElectronFuseWires(binary: Buffer): ElectronFuseWire[] {
  const wires: ElectronFuseWire[] = []
  let searchOffset = 0
  while (searchOffset < binary.length) {
    const sentinelOffset = binary.indexOf(FUSE_SENTINEL, searchOffset)
    if (sentinelOffset < 0) break
    const wireOffset = sentinelOffset + FUSE_SENTINEL.length
    const version = binary[wireOffset]
    const length = binary[wireOffset + 1]
    if (version === undefined || length === undefined || wireOffset + 2 + length > binary.length) {
      throw new Error('Electron fuse wire is truncated')
    }
    wires.push({
      version,
      states: Array.from(binary.subarray(wireOffset + 2, wireOffset + 2 + length)),
    })
    searchOffset = wireOffset + 2 + length
  }
  if (wires.length === 0) {
    throw new Error('Electron fuse sentinel was not found in the packaged binary')
  }
  return wires
}

export function validateRequiredElectronFuses(wires: ElectronFuseWire[]): void {
  for (const wire of wires) {
    if (wire.version !== 1) {
      throw new Error(`Unsupported Electron fuse wire version: ${wire.version}`)
    }
    for (const fuse of REQUIRED_FUSES) {
      if (wire.states[fuse.index] !== FUSE_ENABLED) {
        throw new Error(`Required Electron fuse is not enabled: ${fuse.name}`)
      }
    }
  }
}

export function validateProtectedExternalRuntimeInventory(
  appAsarPath: string,
  resourcesDir: string,
  requiredRuntimeFiles: readonly string[] = [],
): string[] {
  let protectedManifest: Buffer
  try {
    protectedManifest = Buffer.from(extractFile(
      appAsarPath,
      RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH,
    ))
  } catch (error) {
    throw new Error(
      `Protected runtime integrity manifest is missing from app.asar: ${RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH}`,
      { cause: error },
    )
  }
  const verifiedRuntimeFiles = verifyRuntimeIntegrityManifest(
    resourcesDir,
    protectedManifest,
    REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
  )
  const verifiedPaths = new Set(verifiedRuntimeFiles.map((path) => resolve(path)))
  for (const requiredRuntimeFile of requiredRuntimeFiles) {
    if (!verifiedPaths.has(resolve(requiredRuntimeFile))) {
      throw new Error(
        `Required external runtime is not covered by protected manifest: ${requiredRuntimeFile}`,
      )
    }
  }
  return verifiedRuntimeFiles
}

export async function validatePackagedElectronSecurity(
  electronBinary: string,
  resourcesDir: string,
): Promise<ValidatedElectronPackageSecurity> {
  const resolvedBinary = resolve(electronBinary)
  requireRegularFile(resolvedBinary, 'packaged Electron binary')
  const layout = validateElectronPackageSecurityLayout(resourcesDir)
  const fuseBinary = resolveElectronFuseBinary(resolvedBinary)
  validateRequiredElectronFuses(readElectronFuseWires(readFileSync(fuseBinary)))
  const whatsAppWorkerGitSha = validatePackagedWhatsAppWorkerProvenance(
    resourcesDir,
    process.env.ROBB_BUILD_COMMIT,
  )
  const verifiedRuntimeFiles = validateProtectedExternalRuntimeInventory(
    layout.appAsarPath,
    resourcesDir,
    layout.requiredRuntimeFiles,
  )
  return {
    ...layout,
    protectedRuntimeManifestPath: RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH,
    verifiedRuntimeFiles,
    whatsAppWorkerGitSha,
  }
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.main) {
  const binary = readArgument('--binary')
  const resourcesDir = readArgument('--resources-dir')
  if (!binary || !resourcesDir) {
    throw new Error(
      'Usage: bun scripts/validate-electron-package-security.ts '
      + '--binary <Electron executable> --resources-dir <packaged Resources directory>',
    )
  }

  const layout = await validatePackagedElectronSecurity(binary, resourcesDir)
  console.log(`Validated integrity-protected ASAR: ${layout.appAsarPath}`)
  console.log(`Validated protected external runtime inventory: ${layout.verifiedRuntimeFiles.length} files`)
  console.log(`Validated packaged WhatsApp worker provenance: ${layout.whatsAppWorkerGitSha}`)
  console.log('Validated Electron fuses: ASAR integrity and OnlyLoadAppFromAsar')
}
