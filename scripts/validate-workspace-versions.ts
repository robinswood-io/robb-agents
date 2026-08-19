import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = join(import.meta.dir, '..')

function readVersion(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(parsed.version)) {
    throw new Error(`${path} must declare a stable X.Y.Z version`)
  }
  return parsed.version
}

const expectedVersion = readVersion(join(rootDir, 'package.json'))
const packageFiles = ['apps', 'packages'].flatMap(group => (
  readdirSync(join(rootDir, group), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(rootDir, group, entry.name, 'package.json'))
    .filter(path => Bun.file(path).size > 0)
))

const mismatches = packageFiles
  .map(path => ({ path, version: readVersion(path) }))
  .filter(entry => entry.version !== expectedVersion)

if (mismatches.length > 0) {
  throw new Error([
    `Workspace package versions must all match ${expectedVersion}:`,
    ...mismatches.map(entry => `- ${entry.path}: ${entry.version}`),
  ].join('\n'))
}

console.log(`Workspace version contract passed: ${expectedVersion} (${packageFiles.length + 1} packages)`)
