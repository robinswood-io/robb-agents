import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface ManifestArtifact {
  fileName: string
  sha512: string
  size: number
}

export interface GenerateUpdateManifestsOptions {
  releaseDir: string
  version: string
  releaseDate?: string
}

function getArtifact(releaseDir: string, fileName: string): ManifestArtifact {
  const artifactPath = join(releaseDir, fileName)
  const content = Bun.file(artifactPath)
  if (!content.size) throw new Error(`Missing or empty release artifact: ${artifactPath}`)

  const digest = createHash('sha512')
  digest.update(readFileSync(artifactPath))
  return {
    fileName,
    sha512: digest.digest('base64'),
    size: statSync(artifactPath).size,
  }
}

function findUniqueMatchingFile(releaseDir: string, pattern: RegExp, description: string): string {
  const matches = readdirSync(releaseDir)
    .filter((fileName) => pattern.test(fileName))
    .sort()

  if (matches.length === 0) throw new Error(`Missing ${description} in ${releaseDir}`)
  if (matches.length > 1) {
    throw new Error(`Ambiguous ${description} in ${releaseDir}: ${matches.join(', ')}`)
  }
  const [match] = matches
  if (match === undefined) throw new Error(`Missing ${description} in ${releaseDir}`)
  return match
}

function renderManifest(
  version: string,
  artifacts: ManifestArtifact[],
  releaseDate: string,
): string {
  const primary = artifacts[0]
  if (!primary) throw new Error('At least one updater artifact is required')

  return [
    `version: ${version}`,
    'files:',
    ...artifacts.flatMap((artifact) => [
      `  - url: ${artifact.fileName}`,
      `    sha512: ${artifact.sha512}`,
      `    size: ${artifact.size}`,
    ]),
    `path: ${primary.fileName}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
}

export function generateUpdateManifests(options: GenerateUpdateManifestsOptions): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(`Only stable X.Y.Z versions can produce updater manifests: ${options.version}`)
  }

  const releaseDate = options.releaseDate ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(releaseDate))) {
    throw new Error(`Invalid updater release date: ${releaseDate}`)
  }
  const macArtifacts = [
    getArtifact(options.releaseDir, 'Robb-Agents-x64.zip'),
    getArtifact(options.releaseDir, 'Robb-Agents-arm64.zip'),
  ]
  const windowsArtifact = getArtifact(
    options.releaseDir,
    findUniqueMatchingFile(
      options.releaseDir,
      /^Robb-Agents-x64.*\.exe$/,
      'Windows x64 installer',
    ),
  )
  const linuxArtifact = getArtifact(options.releaseDir, 'Robb-Agents-x64.AppImage')

  const manifests = [
    {
      fileName: 'latest-mac.yml',
      content: renderManifest(options.version, macArtifacts, releaseDate),
    },
    {
      fileName: 'latest.yml',
      content: renderManifest(options.version, [windowsArtifact], releaseDate),
    },
    {
      fileName: 'latest-linux.yml',
      content: renderManifest(options.version, [linuxArtifact], releaseDate),
    },
  ]

  for (const manifest of manifests) {
    writeFileSync(join(options.releaseDir, manifest.fileName), manifest.content, 'utf8')
  }
  return manifests.map((manifest) => manifest.fileName)
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
      'Usage: bun scripts/generate-github-update-manifests.ts --release-dir <dir> --version <X.Y.Z>',
    )
  }

  const generated = generateUpdateManifests({ releaseDir, version })
  console.log(`Generated stable updater manifests: ${generated.join(', ')}`)
}
