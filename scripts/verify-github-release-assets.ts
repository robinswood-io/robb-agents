import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface GitHubReleaseAsset {
  name: string
  size: number
  digest?: string | null
  state?: string
}

interface GitHubReleaseAssetsPayload {
  assets: GitHubReleaseAsset[]
}

export interface VerifyGitHubReleaseAssetsOptions {
  releaseDir: string
  assetsJsonPath: string
}

export interface GitHubReleaseAssetsReport {
  assets: number
  bytes: number
}

function sha256(path: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function parseChecksums(path: string): Map<string, string> {
  const checksums = new Map<string, string>()
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    const match = line.match(/^([a-f0-9]{64})  (.+)$/)
    if (!match) throw new Error(`Invalid SHA256SUMS.txt line: ${line}`)
    const digest = match[1]
    const fileName = match[2]
    if (!digest || !fileName) throw new Error(`Invalid SHA256SUMS.txt line: ${line}`)
    if (checksums.has(fileName)) throw new Error(`Duplicate checksum entry for ${fileName}`)
    checksums.set(fileName, digest)
  }
  return checksums
}

function parseRemoteAssets(path: string): GitHubReleaseAsset[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as GitHubReleaseAssetsPayload).assets)) {
    throw new Error('GitHub assets JSON must contain an assets array')
  }
  return (parsed as GitHubReleaseAssetsPayload).assets
}

/**
 * Verify GitHub's server-side SHA-256 digest, size, state and complete asset
 * inventory before a draft release is made public.
 */
export function verifyGitHubReleaseAssets(
  options: VerifyGitHubReleaseAssetsOptions,
): GitHubReleaseAssetsReport {
  const localFiles = readdirSync(options.releaseDir)
    .filter(fileName => statSync(join(options.releaseDir, fileName)).isFile())
    .sort()
  if (!localFiles.includes('SHA256SUMS.txt')) {
    throw new Error('Release directory is missing SHA256SUMS.txt')
  }

  const checksums = parseChecksums(join(options.releaseDir, 'SHA256SUMS.txt'))
  const remoteAssets = parseRemoteAssets(options.assetsJsonPath)
  const remoteByName = new Map<string, GitHubReleaseAsset>()
  for (const asset of remoteAssets) {
    if (!asset || typeof asset.name !== 'string' || typeof asset.size !== 'number') {
      throw new Error('GitHub returned malformed release asset metadata')
    }
    if (remoteByName.has(asset.name)) {
      throw new Error(`GitHub release contains duplicate asset ${asset.name}`)
    }
    remoteByName.set(asset.name, asset)
  }

  const localNames = localFiles.join('\n')
  const remoteNames = Array.from(remoteByName.keys()).sort().join('\n')
  if (localNames !== remoteNames) {
    throw new Error(`GitHub release asset inventory mismatch\nlocal:\n${localNames}\nremote:\n${remoteNames}`)
  }

  let bytes = 0
  for (const fileName of localFiles) {
    const localPath = join(options.releaseDir, fileName)
    const localSize = statSync(localPath).size
    const expectedHash = fileName === 'SHA256SUMS.txt'
      ? sha256(localPath)
      : checksums.get(fileName)
    if (!expectedHash) throw new Error(`SHA256SUMS.txt is missing ${fileName}`)

    const remote = remoteByName.get(fileName)!
    if (remote.state !== 'uploaded') {
      throw new Error(`GitHub asset ${fileName} is not uploaded (state=${remote.state ?? 'missing'})`)
    }
    if (remote.size !== localSize) {
      throw new Error(`GitHub asset ${fileName} has size ${remote.size}, expected ${localSize}`)
    }
    if (remote.digest !== `sha256:${expectedHash}`) {
      throw new Error(`GitHub asset ${fileName} has digest ${remote.digest ?? 'missing'}, expected sha256:${expectedHash}`)
    }
    bytes += localSize
  }

  return { assets: localFiles.length, bytes }
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.main) {
  const releaseDir = readArgument('--release-dir')
  const assetsJsonPath = readArgument('--assets-json')
  if (!releaseDir || !assetsJsonPath) {
    throw new Error(
      'Usage: bun scripts/verify-github-release-assets.ts --release-dir <dir> --assets-json <path>',
    )
  }

  const report = verifyGitHubReleaseAssets({ releaseDir, assetsJsonPath })
  console.log(`Verified ${report.assets} GitHub release assets (${report.bytes} bytes)`)
}
