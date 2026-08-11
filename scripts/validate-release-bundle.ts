import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { load } from 'js-yaml'

interface UpdateFileEntry {
  url: string
  sha512: string
  size: number
}

interface UpdateManifest {
  version: string
  files: UpdateFileEntry[]
  path: string
  sha512: string
  releaseDate: string
}

interface PlatformContract {
  manifest: string
  artifactPatterns: RegExp[]
}

interface ProvenanceContract {
  fileName: string
  platform: string
  signing: string
}

export interface ValidateReleaseBundleOptions {
  releaseDir: string
  version: string
  sourceCommit?: string
  tag?: string
  requireSigned?: boolean
  allowUnsignedWindows?: boolean
  requireSbom?: boolean
}

export interface ReleaseBundleValidationReport {
  artifacts: string[]
  checksumEntries: number
  manifests: string[]
  provenanceFiles: string[]
}

const PLATFORM_CONTRACTS: PlatformContract[] = [
  {
    manifest: 'latest-mac.yml',
    artifactPatterns: [
      /^Robb-Agents-x64\.zip$/,
      /^Robb-Agents-arm64\.zip$/,
    ],
  },
  {
    manifest: 'latest.yml',
    artifactPatterns: [/^Robb-Agents-x64.*\.exe$/],
  },
  {
    manifest: 'latest-linux.yml',
    artifactPatterns: [/^Robb-Agents-x64\.AppImage$/],
  },
]

const INSTALLER_PATTERNS = [
  /^Robb-Agents-x64\.dmg$/,
  /^Robb-Agents-arm64\.dmg$/,
  /^Robb-Agents-x64\.zip$/,
  /^Robb-Agents-arm64\.zip$/,
  /^Robb-Agents-x64.*\.exe$/,
  /^Robb-Agents-x64\.AppImage$/,
]

const RELEASE_TOOL_FILES = [
  'install-app.sh',
  'install-app.ps1',
]

const PROVENANCE_CONTRACTS: ProvenanceContract[] = [
  {
    fileName: 'PROVENANCE-macos-x64.txt',
    platform: 'macos-x64',
    signing: 'verified-developer-id-and-notarized',
  },
  {
    fileName: 'PROVENANCE-macos-arm64.txt',
    platform: 'macos-arm64',
    signing: 'verified-developer-id-and-notarized',
  },
  {
    fileName: 'PROVENANCE-windows-x64.txt',
    platform: 'windows-x64',
    signing: 'verified-authenticode',
  },
  {
    fileName: 'PROVENANCE-linux-x64.txt',
    platform: 'linux-x64',
    signing: 'checksum-and-provenance-verified',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must contain a non-empty ${key}`)
  }
  return value
}

function requirePositiveInteger(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${context} must contain a positive integer ${key}`)
  }
  return Number(value)
}

function readManifest(path: string): UpdateManifest {
  const parsed: unknown = load(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`Updater manifest is not an object: ${path}`)

  const rawFiles = parsed.files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error(`Updater manifest must contain files: ${path}`)
  }

  const files = rawFiles.map((rawFile, index): UpdateFileEntry => {
    const context = `${basename(path)} files[${index}]`
    if (!isRecord(rawFile)) throw new Error(`${context} must be an object`)
    return {
      url: requireString(rawFile, 'url', context),
      sha512: requireString(rawFile, 'sha512', context),
      size: requirePositiveInteger(rawFile, 'size', context),
    }
  })

  return {
    version: requireString(parsed, 'version', basename(path)),
    files,
    path: requireString(parsed, 'path', basename(path)),
    sha512: requireString(parsed, 'sha512', basename(path)),
    releaseDate: requireString(parsed, 'releaseDate', basename(path)),
  }
}

function digestFile(path: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  const digest = createHash(algorithm)
  digest.update(readFileSync(path))
  return digest.digest(encoding)
}

function findUniqueFile(fileNames: string[], pattern: RegExp, description: string): string {
  const matches = fileNames.filter((fileName) => pattern.test(fileName))
  if (matches.length === 0) throw new Error(`Missing ${description}`)
  if (matches.length > 1) {
    throw new Error(`Ambiguous ${description}: ${matches.sort().join(', ')}`)
  }
  const [match] = matches
  if (match === undefined) throw new Error(`Missing ${description}`)
  return match
}

function parseChecksums(path: string): Map<string, string> {
  const checksums = new Map<string, string>()
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line)
    if (!match) throw new Error(`Invalid SHA256SUMS.txt line ${index + 1}: ${line}`)
    const [, checksum, fileName] = match
    if (checksum === undefined || fileName === undefined) {
      throw new Error(`Invalid SHA256SUMS.txt line ${index + 1}: ${line}`)
    }
    if (checksums.has(fileName)) throw new Error(`Duplicate checksum entry: ${fileName}`)
    checksums.set(fileName, checksum)
  }
  return checksums
}

function parseProvenance(path: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`Invalid provenance line in ${basename(path)}: ${line}`)
    values[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return values
}

export function validateReleaseBundle(
  options: ValidateReleaseBundleOptions,
): ReleaseBundleValidationReport {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(`Release bundle version must be stable X.Y.Z: ${options.version}`)
  }

  const expectedTag = options.tag ?? `v${options.version}`
  if (expectedTag !== `v${options.version}`) {
    throw new Error(`Release tag ${expectedTag} must match v${options.version}`)
  }

  const fileNames = readdirSync(options.releaseDir)
    .filter((fileName) => statSync(join(options.releaseDir, fileName)).isFile())
    .sort()

  const installerArtifacts = INSTALLER_PATTERNS.map((pattern) => (
    findUniqueFile(fileNames, pattern, `release artifact matching ${pattern.source}`)
  ))
  for (const fileName of RELEASE_TOOL_FILES) {
    if (!fileNames.includes(fileName)) throw new Error(`Missing release installation tool ${fileName}`)
    if (statSync(join(options.releaseDir, fileName)).size === 0) {
      throw new Error(`Release installation tool is empty: ${fileName}`)
    }
  }

  const manifestDates = new Set<string>()
  for (const contract of PLATFORM_CONTRACTS) {
    const manifestPath = join(options.releaseDir, contract.manifest)
    if (!fileNames.includes(contract.manifest)) throw new Error(`Missing ${contract.manifest}`)
    const manifest = readManifest(manifestPath)
    if (manifest.version !== options.version) {
      throw new Error(`${contract.manifest} version ${manifest.version} does not match ${options.version}`)
    }
    if (Number.isNaN(Date.parse(manifest.releaseDate))) {
      throw new Error(`${contract.manifest} has invalid releaseDate ${manifest.releaseDate}`)
    }
    manifestDates.add(manifest.releaseDate)

    const expectedArtifacts = contract.artifactPatterns.map((pattern) => (
      findUniqueFile(fileNames, pattern, `${contract.manifest} artifact matching ${pattern.source}`)
    ))
    const actualArtifacts = manifest.files.map((entry) => entry.url).sort()
    if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts.sort())) {
      throw new Error(
        `${contract.manifest} files do not match platform contract: ${actualArtifacts.join(', ')}`,
      )
    }

    for (const entry of manifest.files) {
      if (basename(entry.url) !== entry.url) {
        throw new Error(`${contract.manifest} contains an unsafe artifact URL: ${entry.url}`)
      }
      const artifactPath = join(options.releaseDir, entry.url)
      const size = statSync(artifactPath).size
      if (entry.size !== size) {
        throw new Error(`${contract.manifest} size mismatch for ${entry.url}: ${entry.size} != ${size}`)
      }
      const sha512 = digestFile(artifactPath, 'sha512', 'base64')
      if (entry.sha512 !== sha512) {
        throw new Error(`${contract.manifest} SHA-512 mismatch for ${entry.url}`)
      }
    }

    const primary = manifest.files.find((entry) => entry.url === manifest.path)
    if (!primary || primary.sha512 !== manifest.sha512) {
      throw new Error(`${contract.manifest} primary path/checksum does not match its files array`)
    }
  }
  if (manifestDates.size !== 1) {
    throw new Error('Updater manifests must share one releaseDate')
  }

  const provenanceFiles: string[] = []
  for (const contract of PROVENANCE_CONTRACTS) {
    const path = join(options.releaseDir, contract.fileName)
    if (!fileNames.includes(contract.fileName)) throw new Error(`Missing ${contract.fileName}`)
    const provenance = parseProvenance(path)
    provenanceFiles.push(contract.fileName)
    if (provenance.product !== 'Robb Agents') {
      throw new Error(`${contract.fileName} has invalid product`)
    }
    if (provenance.version !== options.version) {
      throw new Error(`${contract.fileName} has invalid version ${provenance.version}`)
    }
    if (provenance.release_tag !== expectedTag) {
      throw new Error(`${contract.fileName} has invalid release_tag ${provenance.release_tag}`)
    }
    if (provenance.platform !== contract.platform) {
      throw new Error(`${contract.fileName} has invalid platform ${provenance.platform}`)
    }
    if (options.sourceCommit && provenance.source_commit !== options.sourceCommit) {
      throw new Error(`${contract.fileName} has invalid source_commit ${provenance.source_commit}`)
    }
    if (options.requireSigned) {
      const allowedSigningStates = options.allowUnsignedWindows && contract.platform === 'windows-x64'
        ? [contract.signing, 'unsigned-github-release']
        : [contract.signing]
      const signingState = provenance.signing
      if (typeof signingState !== 'string' || !allowedSigningStates.includes(signingState)) {
        throw new Error(`${contract.fileName} has invalid signing state ${signingState}`)
      }
    }
  }

  if (options.requireSbom) {
    const sbomPath = join(options.releaseDir, 'SBOM.spdx.json')
    if (!fileNames.includes('SBOM.spdx.json')) throw new Error('Missing SBOM.spdx.json')
    const parsedSbom: unknown = JSON.parse(readFileSync(sbomPath, 'utf8'))
    if (!isRecord(parsedSbom) || typeof parsedSbom.spdxVersion !== 'string') {
      throw new Error('SBOM.spdx.json is not a valid SPDX JSON document')
    }
  }

  const checksumPath = join(options.releaseDir, 'SHA256SUMS.txt')
  if (!fileNames.includes('SHA256SUMS.txt')) throw new Error('Missing SHA256SUMS.txt')
  const checksums = parseChecksums(checksumPath)
  for (const fileName of fileNames) {
    if (fileName === 'SHA256SUMS.txt') continue
    const expected = checksums.get(fileName)
    if (!expected) throw new Error(`SHA256SUMS.txt is missing ${fileName}`)
    const actual = digestFile(join(options.releaseDir, fileName), 'sha256', 'hex')
    if (actual !== expected) throw new Error(`SHA-256 mismatch for ${fileName}`)
  }
  for (const fileName of checksums.keys()) {
    if (!fileNames.includes(fileName)) throw new Error(`SHA256SUMS.txt references missing ${fileName}`)
  }

  return {
    artifacts: installerArtifacts,
    checksumEntries: checksums.size,
    manifests: PLATFORM_CONTRACTS.map((contract) => contract.manifest),
    provenanceFiles,
  }
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.main) {
  const releaseDir = readArgument('--release-dir')
  const version = readArgument('--version')
  if (!releaseDir || !version) {
    throw new Error(
      'Usage: bun scripts/validate-release-bundle.ts --release-dir <dir> --version <X.Y.Z> '
      + '[--source-commit <sha>] [--tag <vX.Y.Z>] [--require-signed] [--allow-unsigned-windows] [--require-sbom]',
    )
  }

  const report = validateReleaseBundle({
    releaseDir,
    version,
    sourceCommit: readArgument('--source-commit'),
    tag: readArgument('--tag'),
    requireSigned: process.argv.includes('--require-signed'),
    allowUnsignedWindows: process.argv.includes('--allow-unsigned-windows'),
    requireSbom: process.argv.includes('--require-sbom'),
  })
  console.log(
    `Validated release bundle: ${report.artifacts.length} artifacts, `
    + `${report.manifests.length} manifests, ${report.checksumEntries} checksums`,
  )
}
