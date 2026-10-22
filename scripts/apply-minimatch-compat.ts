import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const TARGET_NAME = 'minimatch'
const TARGET_VERSION = '3.1.5'
const SPRINTF_PACKAGE_NAME = 'sprintf-js'
const ORIGINAL_IMPORT = "var expand = require('brace-expansion')"
const COMPATIBLE_IMPORT = [
  "var braceExpansion = require('brace-expansion')",
  "var expand = typeof braceExpansion === 'function'",
  '  ? braceExpansion',
  '  : braceExpansion.expand',
].join('\n')

export interface CompatibilityResult {
  changed: boolean
  source: string
}

export interface ApplyCompatibilityResult {
  matched: string[]
  changed: string[]
}

export function patchMinimatchSource(source: string): CompatibilityResult {
  if (source.includes(COMPATIBLE_IMPORT)) {
    return { changed: false, source }
  }

  const occurrences = source.split(ORIGINAL_IMPORT).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `Expected exactly one legacy brace-expansion import, found ${occurrences}`,
    )
  }

  return {
    changed: true,
    source: source.replace(ORIGINAL_IMPORT, COMPATIBLE_IMPORT),
  }
}

function findTargetPackages(nodeModulesDir: string): string[] {
  if (!existsSync(nodeModulesDir)) return []

  const packages: string[] = []
  const pending = [nodeModulesDir]

  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue

      const entryPath = join(current, entry.name)
      if (entry.name === TARGET_NAME) {
        const manifestPath = join(entryPath, 'package.json')
        if (!existsSync(manifestPath)) continue

        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (manifest.name === TARGET_NAME && manifest.version === TARGET_VERSION) {
          packages.push(entryPath)
        }
        continue
      }

      pending.push(entryPath)
    }
  }

  return packages.sort()
}

function verifyTargetPackage(packageDir: string): void {
  const requireFromPackage = createRequire(join(packageDir, 'package.json'))
  const minimatch = requireFromPackage('./minimatch.js') as unknown
  if (typeof minimatch !== 'function') {
    throw new Error(`${packageDir} does not export a minimatch function`)
  }

  if (!minimatch('src/index.ts', '{src,test}/index.ts')) {
    throw new Error(`${packageDir} failed the brace-expansion compatibility smoke test`)
  }
}

export function applyMinimatchCompatibility(projectDir: string): ApplyCompatibilityResult {
  const matched = findTargetPackages(join(projectDir, 'node_modules'))
  const changed: string[] = []

  for (const packageDir of matched) {
    const sourcePath = join(packageDir, 'minimatch.js')
    const result = patchMinimatchSource(readFileSync(sourcePath, 'utf8'))
    if (!result.changed) continue

    writeFileSync(sourcePath, result.source)
    changed.push(packageDir)
  }

  for (const packageDir of matched) verifyTargetPackage(packageDir)

  return { matched, changed }
}

function findSprintfJsTargets(nodeModulesDir: string): {
  targetDirs: string[]
  consumerPackageDirs: string[]
} {
  if (!existsSync(nodeModulesDir)) {
    return { targetDirs: [], consumerPackageDirs: [] }
  }

  const targetDirSet = new Set<string>([join(nodeModulesDir, SPRINTF_PACKAGE_NAME)])
  const consumerPackageDirs: string[] = []
  const pending = [nodeModulesDir]

  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue

      const entryPath = join(current, entry.name)
      if (entry.name === SPRINTF_PACKAGE_NAME) {
        targetDirSet.add(entryPath)
        continue
      }

      const manifestPath = join(entryPath, 'package.json')
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            dependencies?: Record<string, unknown>
            optionalDependencies?: Record<string, unknown>
          }
          const hasSprintfDep =
            Boolean(manifest.dependencies && SPRINTF_PACKAGE_NAME in manifest.dependencies) ||
            Boolean(
              manifest.optionalDependencies &&
                SPRINTF_PACKAGE_NAME in manifest.optionalDependencies,
            )
          if (hasSprintfDep) {
            consumerPackageDirs.push(entryPath)
            targetDirSet.add(join(entryPath, 'node_modules', SPRINTF_PACKAGE_NAME))
          }
        } catch {
          // Ignore unreadable manifests while scanning node_modules.
        }
      }

      pending.push(entryPath)
    }
  }

  return {
    targetDirs: [...targetDirSet].sort(),
    consumerPackageDirs: consumerPackageDirs.sort(),
  }
}

function verifySprintfJsConsumer(packageDir: string, expectedVersion: string): void {
  const requireFromPackage = createRequire(join(packageDir, 'package.json'))
  const manifest = requireFromPackage(`${SPRINTF_PACKAGE_NAME}/package.json`) as {
    version?: unknown
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `${packageDir} resolved ${SPRINTF_PACKAGE_NAME}@${String(manifest.version)} instead of ${expectedVersion}`,
    )
  }
  const sprintfModule = requireFromPackage(SPRINTF_PACKAGE_NAME) as {
    sprintf?: (format: string, ...args: unknown[]) => string
  }
  if (
    typeof sprintfModule.sprintf !== 'function' ||
    sprintfModule.sprintf('%s', 'ok') !== 'ok'
  ) {
    throw new Error(`${packageDir} failed the ${SPRINTF_PACKAGE_NAME} smoke test`)
  }
}

export function applySprintfJsCompatibility(projectDir: string): ApplyCompatibilityResult {
  const nodeModulesDir = join(projectDir, 'node_modules')
  const vendorDir = join(projectDir, 'scripts', 'vendor', SPRINTF_PACKAGE_NAME)
  const vendorManifestPath = join(vendorDir, 'package.json')
  const vendorSourcePath = join(vendorDir, 'src', 'sprintf.js')

  if (!existsSync(nodeModulesDir) || !existsSync(vendorManifestPath) || !existsSync(vendorSourcePath)) {
    return { matched: [], changed: [] }
  }

  const vendorManifestRaw = readFileSync(vendorManifestPath, 'utf8')
  const vendorSourceRaw = readFileSync(vendorSourcePath, 'utf8')
  const vendorManifest = JSON.parse(vendorManifestRaw) as { version?: string }
  const expectedVersion = vendorManifest.version ?? '1.1.4'

  const { targetDirs, consumerPackageDirs } = findSprintfJsTargets(nodeModulesDir)
  const changed: string[] = []

  for (const targetDir of targetDirs) {
    const targetManifestPath = join(targetDir, 'package.json')
    const targetSourceDir = join(targetDir, 'src')
    const targetSourcePath = join(targetSourceDir, 'sprintf.js')

    const currentManifest = existsSync(targetManifestPath)
      ? readFileSync(targetManifestPath, 'utf8')
      : null
    const currentSource = existsSync(targetSourcePath)
      ? readFileSync(targetSourcePath, 'utf8')
      : null

    if (currentManifest === vendorManifestRaw && currentSource === vendorSourceRaw) {
      continue
    }

    mkdirSync(targetSourceDir, { recursive: true })
    writeFileSync(targetManifestPath, vendorManifestRaw)
    writeFileSync(targetSourcePath, vendorSourceRaw)
    changed.push(targetDir)
  }

  for (const consumerDir of consumerPackageDirs) {
    verifySprintfJsConsumer(consumerDir, expectedVersion)
  }

  return { matched: targetDirs, changed }
}

function main(): void {
  const projectDir = join(import.meta.dir, '..')
  const result = applyMinimatchCompatibility(projectDir)
  const sprintfResult = applySprintfJsCompatibility(projectDir)
  console.log(
    `minimatch compatibility verified: ${result.matched.length} package(s), ${result.changed.length} updated; sprintf-js vendor materialized: ${sprintfResult.matched.length} location(s), ${sprintfResult.changed.length} updated`,
  )
}

if (import.meta.main) main()
