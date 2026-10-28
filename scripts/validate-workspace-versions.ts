import { UV_VERSION } from './build/common/binary-downloads'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const rootDir = join(import.meta.dir, '..')

function readVersion(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(parsed.version)) {
    throw new Error(`${path} must declare a stable X.Y.Z version`)
  }
  return parsed.version
}

export function readBunLockWorkspaceVersion(
  lockfile: string,
  workspacePath: string,
): string | undefined {
  const header = `    "${workspacePath}": {`
  const start = lockfile.indexOf(header)
  if (start === -1) return undefined

  const bodyStart = start + header.length
  const nextWorkspace = lockfile.indexOf('\n    "', bodyStart)
  const body = lockfile.slice(bodyStart, nextWorkspace === -1 ? undefined : nextWorkspace)
  return body.match(/^      "version": "([^"]+)",$/m)?.[1]
}

function main(): void {
  if (process.argv.includes('--runtime')) {
    const runtimes = [
      ['Node', execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(), 'v26.12.1'],
      ['Bun', Bun.version, '1.4.4'],
      ['Python', execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim(), 'Python 3.14.6'],
      ['RTK', execFileSync('rtk', ['--version'], { encoding: 'utf8' }).trim(), 'rtk '+readVersion(join(rootDir, 'scripts/vendor/rtk-manifest.json'))],
      ['uv', execFileSync('uv', ['--version'], { encoding: 'utf8' }).trim().split(/\s+/)[1], UV_VERSION],
    ] as const
    for (const [name, actual, expected] of runtimes) {
      if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`)
    }
    console.log('Local/CI runtime contract passed: '+runtimes.map(([name, actual]) => name+' '+actual).join(', '))
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

  const lockfile = readFileSync(join(rootDir, 'bun.lock'), 'utf8')
  const lockMismatches = packageFiles
    .map(path => {
      const workspacePath = relative(rootDir, dirname(path)).split(sep).join('/')
      return {
        path: workspacePath,
        version: readBunLockWorkspaceVersion(lockfile, workspacePath),
      }
    })
    .filter(entry => entry.version !== expectedVersion)

  if (lockMismatches.length > 0) {
    throw new Error([
      `bun.lock workspace versions must all match ${expectedVersion}:`,
      ...lockMismatches.map(entry => `- ${entry.path}: ${entry.version ?? '<missing>'}`),
    ].join('\n'))
  }

  console.log(`Workspace version contract passed: ${expectedVersion} (${packageFiles.length + 1} packages)`)
}

if (import.meta.main) main()
