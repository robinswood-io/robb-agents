import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateUpdateManifests } from '../generate-github-update-manifests'

let temporaryDirectory: string | undefined

afterEach(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

function prepareArtifacts(): string {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'robb-update-manifests-'))
  const artifacts: Record<string, string> = {
    'Robb-Agents-x64.zip': 'mac-x64',
    'Robb-Agents-arm64.zip': 'mac-arm64',
    'Robb-Agents-x64.exe': 'windows-installer',
    'Robb-Agents-x64.AppImage': 'linux-appimage',
  }
  for (const [fileName, content] of Object.entries(artifacts)) {
    writeFileSync(join(temporaryDirectory, fileName), content)
  }
  return temporaryDirectory
}

describe('GitHub updater manifest generation', () => {
  it('creates stable manifests for macOS universal assets, Windows and Linux', () => {
    const releaseDir = prepareArtifacts()
    const generated = generateUpdateManifests({
      releaseDir,
      version: '1.2.3',
      releaseDate: '2026-07-24T10:00:00.000Z',
    })

    expect(generated).toEqual(['latest-mac.yml', 'latest.yml', 'latest-linux.yml'])

    const macManifest = readFileSync(join(releaseDir, 'latest-mac.yml'), 'utf8')
    expect(macManifest).toContain('version: 1.2.3')
    expect(macManifest).toContain('url: Robb-Agents-x64.zip')
    expect(macManifest).toContain('url: Robb-Agents-arm64.zip')
    expect(macManifest).toContain("releaseDate: '2026-07-24T10:00:00.000Z'")

    expect(readFileSync(join(releaseDir, 'latest.yml'), 'utf8')).toContain(
      'url: Robb-Agents-x64.exe',
    )
    expect(readFileSync(join(releaseDir, 'latest-linux.yml'), 'utf8')).toContain(
      'url: Robb-Agents-x64.AppImage',
    )
  })

  it('rejects prerelease versions', () => {
    const releaseDir = prepareArtifacts()
    expect(() => generateUpdateManifests({
      releaseDir,
      version: '1.2.3-beta.1',
    })).toThrow('Only stable X.Y.Z versions')
  })

  it('rejects ambiguous Windows installers instead of selecting one by size', () => {
    const releaseDir = prepareArtifacts()
    writeFileSync(join(releaseDir, 'Robb-Agents-x64-Setup.exe'), 'second-installer')

    expect(() => generateUpdateManifests({
      releaseDir,
      version: '1.2.3',
    })).toThrow('Ambiguous Windows x64 installer')
  })

  it('rejects an invalid release date', () => {
    const releaseDir = prepareArtifacts()
    expect(() => generateUpdateManifests({
      releaseDir,
      version: '1.2.3',
      releaseDate: 'not-a-date',
    })).toThrow('Invalid updater release date')
  })
})
