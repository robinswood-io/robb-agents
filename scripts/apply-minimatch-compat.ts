import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const TARGET_NAME = 'minimatch'
const TARGET_VERSION = '3.1.5'
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

function main(): void {
  const projectDir = join(import.meta.dir, '..')
  const result = applyMinimatchCompatibility(projectDir)
  console.log(
    `minimatch compatibility verified: ${result.matched.length} package(s), ${result.changed.length} updated`,
  )
}

if (import.meta.main) main()
