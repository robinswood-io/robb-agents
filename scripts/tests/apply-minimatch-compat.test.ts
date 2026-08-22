import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMinimatchCompatibility,
  patchMinimatchSource,
} from '../apply-minimatch-compat'

const LEGACY_IMPORT = "var expand = require('brace-expansion')"
const COMPATIBLE_IMPORT = [
  "var braceExpansion = require('brace-expansion')",
  "var expand = typeof braceExpansion === 'function'",
  '  ? braceExpansion',
  '  : braceExpansion.expand',
].join('\n')

let temporaryDirectory: string | undefined

afterEach(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

function createPackage(version = '3.1.5', source = `${LEGACY_IMPORT}\n`): string {
  temporaryDirectory ??= mkdtempSync(join(tmpdir(), 'robb-minimatch-compat-'))
  const packageDir = join(
    temporaryDirectory,
    'node_modules',
    'nested-dependency',
    'node_modules',
    'minimatch',
  )
  mkdirSync(packageDir, { recursive: true })
  const braceExpansionDir = join(temporaryDirectory, 'node_modules', 'brace-expansion')
  mkdirSync(braceExpansionDir, { recursive: true })
  writeFileSync(
    join(braceExpansionDir, 'package.json'),
    JSON.stringify({ name: 'brace-expansion', version: '5.0.8', main: 'index.js' }),
  )
  writeFileSync(
    join(braceExpansionDir, 'index.js'),
    "exports.expand = () => ['src/index.ts', 'test/index.ts']\n",
  )
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: 'minimatch', version }),
  )
  writeFileSync(join(packageDir, 'minimatch.js'), source)
  return packageDir
}

describe('minimatch compatibility installer', () => {
  it('adapts the legacy CommonJS import to both brace-expansion export shapes', () => {
    const result = patchMinimatchSource(`before\n${LEGACY_IMPORT}\nafter\n`)

    expect(result.changed).toBe(true)
    expect(result.source).toContain(COMPATIBLE_IMPORT)
    expect(result.source).not.toContain(LEGACY_IMPORT)
  })

  it('is idempotent', () => {
    const result = patchMinimatchSource(`${COMPATIBLE_IMPORT}\n`)

    expect(result.changed).toBe(false)
    expect(result.source).toBe(`${COMPATIBLE_IMPORT}\n`)
  })

  it('fails closed when the target source no longer matches the contract', () => {
    expect(() => patchMinimatchSource('module.exports = {}\n')).toThrow(
      'Expected exactly one legacy brace-expansion import, found 0',
    )
  })

  it('only updates installed minimatch 3.1.5 packages and remains idempotent', () => {
    const packageDir = createPackage(
      '3.1.5',
      `${LEGACY_IMPORT}\nmodule.exports = (value, pattern) => expand(pattern).includes(value)\n`,
    )

    const first = applyMinimatchCompatibility(temporaryDirectory!)
    expect(first.matched).toEqual([packageDir])
    expect(first.changed).toEqual([packageDir])
    expect(readFileSync(join(packageDir, 'minimatch.js'), 'utf8')).toContain(
      COMPATIBLE_IMPORT,
    )

    const second = applyMinimatchCompatibility(temporaryDirectory!)
    expect(second.matched).toEqual([packageDir])
    expect(second.changed).toEqual([])
  })

  it('does not touch other minimatch versions', () => {
    const packageDir = createPackage('10.2.5')

    const result = applyMinimatchCompatibility(temporaryDirectory!)
    expect(result).toEqual({ matched: [], changed: [] })
    expect(readFileSync(join(packageDir, 'minimatch.js'), 'utf8')).toBe(`${LEGACY_IMPORT}\n`)
  })
})
