import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyGitHubReleaseAssets } from '../verify-github-release-assets'

let temporaryDirectory: string | undefined

afterEach(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { force: true, recursive: true })
    temporaryDirectory = undefined
  }
})

function sha256(path: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function prepareFixture(): { releaseDir: string; assetsJsonPath: string; assets: Array<Record<string, unknown>> } {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'robb-github-assets-'))
  const releaseDir = join(temporaryDirectory, 'release')
  mkdirSync(releaseDir)
  const artifactPath = join(releaseDir, 'Robb-Agents-arm64.zip')
  writeFileSync(artifactPath, 'signed-release-content')
  writeFileSync(
    join(releaseDir, 'SHA256SUMS.txt'),
    `${sha256(artifactPath)}  Robb-Agents-arm64.zip\n`,
  )

  const assets = ['Robb-Agents-arm64.zip', 'SHA256SUMS.txt'].map(name => {
    const path = join(releaseDir, name)
    return {
      name,
      size: statSync(path).size,
      digest: `sha256:${sha256(path)}`,
      state: 'uploaded',
    }
  })
  const assetsJsonPath = join(temporaryDirectory, 'assets.json')
  writeFileSync(assetsJsonPath, JSON.stringify({ assets }))
  return { releaseDir, assetsJsonPath, assets }
}

describe('GitHub release asset verification', () => {
  it('accepts an exact uploaded inventory with matching sizes and server digests', () => {
    const fixture = prepareFixture()
    expect(verifyGitHubReleaseAssets(fixture)).toEqual({
      assets: 2,
      bytes: fixture.assets.reduce((total, asset) => total + Number(asset.size), 0),
    })
  })

  it('rejects a missing or additional remote asset', () => {
    const fixture = prepareFixture()
    writeFileSync(fixture.assetsJsonPath, JSON.stringify({ assets: fixture.assets.slice(0, 1) }))
    expect(() => verifyGitHubReleaseAssets(fixture)).toThrow('inventory mismatch')
  })

  it('rejects a server-side digest mismatch', () => {
    const fixture = prepareFixture()
    fixture.assets[0]!.digest = `sha256:${'0'.repeat(64)}`
    writeFileSync(fixture.assetsJsonPath, JSON.stringify({ assets: fixture.assets }))
    expect(() => verifyGitHubReleaseAssets(fixture)).toThrow('has digest')
  })

  it('rejects a non-uploaded asset even when its digest matches', () => {
    const fixture = prepareFixture()
    fixture.assets[0]!.state = 'new'
    writeFileSync(fixture.assetsJsonPath, JSON.stringify({ assets: fixture.assets }))
    expect(() => verifyGitHubReleaseAssets(fixture)).toThrow('is not uploaded')
  })
})
