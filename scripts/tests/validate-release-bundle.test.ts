import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateUpdateManifests } from '../generate-github-update-manifests'
import { validateReleaseBundle } from '../validate-release-bundle'

const VERSION = '1.2.3'
const TAG = `v${VERSION}`
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567'

let temporaryDirectory: string | undefined

afterEach(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

function sha256(path: string): string {
  const digest = createHash('sha256')
  digest.update(readFileSync(path))
  return digest.digest('hex')
}

function writeCanonicalChecksums(releaseDir: string, excluded: string[] = []): void {
  const lines = readdirSync(releaseDir)
    .filter((fileName) => fileName !== 'SHA256SUMS.txt' && !excluded.includes(fileName))
    .filter((fileName) => statSync(join(releaseDir, fileName)).isFile())
    .sort()
    .map((fileName) => `${sha256(join(releaseDir, fileName))}  ${fileName}`)
  writeFileSync(join(releaseDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
}

function writeProvenance(
  releaseDir: string,
  fileName: string,
  platform: string,
  signing: string,
): void {
  writeFileSync(join(releaseDir, fileName), [
    'product=Robb Agents',
    `version=${VERSION}`,
    `source_commit=${SOURCE_COMMIT}`,
    `release_tag=${TAG}`,
    `platform=${platform}`,
    `signing=${signing}`,
    '',
  ].join('\n'))
}

function prepareReleaseBundle(): string {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'robb-release-bundle-'))
  const artifacts: Record<string, string> = {
    'Robb-Agents-x64.dmg': 'macos-x64-dmg',
    'Robb-Agents-arm64.dmg': 'macos-arm64-dmg',
    'Robb-Agents-x64.zip': 'macos-x64-zip',
    'Robb-Agents-arm64.zip': 'macos-arm64-zip',
    'Robb-Agents-x64.exe': 'windows-x64-installer',
    'Robb-Agents-x64.AppImage': 'linux-x64-appimage',
  }
  for (const [fileName, content] of Object.entries(artifacts)) {
    writeFileSync(join(temporaryDirectory, fileName), content)
  }
  writeFileSync(join(temporaryDirectory, 'install-app.sh'), '#!/usr/bin/env bash\n')
  writeFileSync(join(temporaryDirectory, 'install-app.ps1'), '# Robb Agents installer\n')

  generateUpdateManifests({
    releaseDir: temporaryDirectory,
    version: VERSION,
    releaseDate: '2026-07-24T10:00:00.000Z',
  })

  writeProvenance(
    temporaryDirectory,
    'PROVENANCE-macos-x64.txt',
    'macos-x64',
    'verified-developer-id-and-notarized',
  )
  writeProvenance(
    temporaryDirectory,
    'PROVENANCE-macos-arm64.txt',
    'macos-arm64',
    'verified-developer-id-and-notarized',
  )
  writeProvenance(
    temporaryDirectory,
    'PROVENANCE-windows-x64.txt',
    'windows-x64',
    'verified-authenticode',
  )
  writeProvenance(
    temporaryDirectory,
    'PROVENANCE-linux-x64.txt',
    'linux-x64',
    'checksum-and-provenance-verified',
  )

  writeFileSync(join(temporaryDirectory, 'RELEASE-STATUS.md'), '# Verified release evidence\n')
  writeFileSync(join(temporaryDirectory, 'SBOM.spdx.json'), JSON.stringify({
    spdxVersion: 'SPDX-2.3',
    name: `Robb Agents ${VERSION}`,
  }))
  for (const platform of ['macos-x64', 'macos-arm64', 'windows-x64', 'linux-x64']) {
    writeFileSync(join(temporaryDirectory, `SHA256SUMS-${platform}.txt`), `${platform}\n`)
  }
  writeCanonicalChecksums(temporaryDirectory)
  return temporaryDirectory
}

describe('release bundle validation', () => {
  it('accepts a complete signed cross-platform release bundle', () => {
    const releaseDir = prepareReleaseBundle()
    const report = validateReleaseBundle({
      releaseDir,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      tag: TAG,
      requireSigned: true,
      requireSbom: true,
    })

    expect(report.artifacts).toHaveLength(6)
    expect(report.manifests).toEqual(['latest-mac.yml', 'latest.yml', 'latest-linux.yml'])
    expect(report.provenanceFiles).toHaveLength(4)
    expect(report.checksumEntries).toBeGreaterThan(10)
  })

  it('rejects artifact tampering after manifest generation', () => {
    const releaseDir = prepareReleaseBundle()
    writeFileSync(join(releaseDir, 'Robb-Agents-x64.AppImage'), 'tampered-linux-artifact')

    expect(() => validateReleaseBundle({
      releaseDir,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      tag: TAG,
      requireSigned: true,
      requireSbom: true,
    })).toThrow(/latest-linux\.yml (size|SHA-512) mismatch/)
  })

  it('rejects an unsigned provenance record at the publication boundary', () => {
    const releaseDir = prepareReleaseBundle()
    writeProvenance(
      releaseDir,
      'PROVENANCE-windows-x64.txt',
      'windows-x64',
      'unsigned-test-artifact',
    )
    writeCanonicalChecksums(releaseDir)

    expect(() => validateReleaseBundle({
      releaseDir,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      tag: TAG,
      requireSigned: true,
      requireSbom: true,
    })).toThrow('PROVENANCE-windows-x64.txt has invalid signing state')
  })


  it('accepts a public release bundle with an explicitly unsigned Windows installer when allowed', () => {
    const releaseDir = prepareReleaseBundle()
    writeProvenance(
      releaseDir,
      'PROVENANCE-windows-x64.txt',
      'windows-x64',
      'unsigned-github-release',
    )
    writeCanonicalChecksums(releaseDir)

    const report = validateReleaseBundle({
      releaseDir,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      tag: TAG,
      requireSigned: true,
      allowUnsignedWindows: true,
      requireSbom: true,
    })

    expect(report.artifacts).toHaveLength(6)
  })

  it('does not accept CI-only unsigned Windows provenance in a public release bundle', () => {
    const releaseDir = prepareReleaseBundle()
    writeProvenance(
      releaseDir,
      'PROVENANCE-windows-x64.txt',
      'windows-x64',
      'unsigned-test-artifact',
    )
    writeCanonicalChecksums(releaseDir)

    expect(() => validateReleaseBundle({
      releaseDir,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      tag: TAG,
      requireSigned: true,
      allowUnsignedWindows: true,
      requireSbom: true,
    })).toThrow('PROVENANCE-windows-x64.txt has invalid signing state')
  })

  it('requires a checksum for every published file', () => {
    const releaseDir = prepareReleaseBundle()
    writeCanonicalChecksums(releaseDir, ['SBOM.spdx.json'])

    expect(() => validateReleaseBundle({
      releaseDir,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      tag: TAG,
      requireSigned: true,
      requireSbom: true,
    })).toThrow('SHA256SUMS.txt is missing SBOM.spdx.json')
  })
})
