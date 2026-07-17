#!/usr/bin/env bun
/**
 * Stages a pinned, checksum-verified RTK binary for an Electron packaging target.
 * RTK is distributed by rtk-ai under Apache-2.0; see THIRD_PARTY_NOTICES.
 */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT, 'apps', 'electron')
const MANIFEST_PATH = join(ROOT, 'scripts', 'vendor', 'rtk-manifest.json')

interface Target {
  asset: string
  sha256: string
  binary: string
}
interface Manifest {
  version: string
  targets: Record<string, Target>
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function run(command: string[], label: string): void {
  const result = Bun.spawnSync(command, { stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`)
}

function assertSafeArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`Archive contains an unsafe path: ${entry}`)
    }
  }
}

function findFile(root: string, fileName: string): string | null {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name)
    if (entry.isFile() && entry.name === fileName) return fullPath
    if (entry.isDirectory()) {
      const found = findFile(fullPath, fileName)
      if (found) return found
    }
  }
  return null
}

function validateExisting(binaryPath: string, version: string): boolean {
  if (!existsSync(binaryPath) || statSync(binaryPath).size < 1_000_000) return false
  const result = Bun.spawnSync([binaryPath, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  return result.exitCode === 0 && new TextDecoder().decode(result.stdout).includes(version)
}

async function main(): Promise<void> {
  const platform = option('--platform') ?? process.platform
  const arch = option('--arch') ?? process.arch
  const targetKey = `${platform}-${arch}`
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  const target = manifest.targets[targetKey]
  if (!target) throw new Error(`RTK is not pinned for target ${targetKey}`)

  const binRoot = join(ELECTRON_DIR, 'resources', 'bin')
  const targetDir = join(binRoot, targetKey)
  const targetPath = join(targetDir, target.binary)

  // Packaging must never accidentally retain RTK from a previous target build.
  // Keep other bundled tools (uv and wrappers) untouched.
  if (existsSync(binRoot)) {
    for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === targetKey) continue
      for (const binaryName of ['rtk', 'rtk.exe']) {
        rmSync(join(binRoot, entry.name, binaryName), { force: true })
      }
    }
  }
  if (validateExisting(targetPath, manifest.version)) {
    console.log(`RTK ${manifest.version} already staged: ${targetPath}`)
    return
  }

  const tempDir = join(ELECTRON_DIR, `.rtk-${targetKey}-${process.pid}`)
  const archivePath = join(tempDir, target.asset)
  const extractDir = join(tempDir, 'extract')
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })

  try {
    const url = `https://github.com/rtk-ai/rtk/releases/download/v${manifest.version}/${target.asset}`
    console.log(`Downloading RTK ${manifest.version} for ${targetKey}…`)
    run(['curl', '-fsSL', '--retry', '3', '--retry-delay', '2', '-o', archivePath, url], 'RTK download')

    const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
    if (digest.toLowerCase() !== target.sha256.toLowerCase()) {
      throw new Error(`RTK checksum verification failed for ${target.asset}`)
    }
    console.log('RTK checksum verified ✓')

    const isZip = target.asset.endsWith('.zip')
    const entriesCommand = isZip ? ['unzip', '-Z1', archivePath] : ['tar', '-tzf', archivePath]
    const listed = Bun.spawnSync(entriesCommand, { stdout: 'pipe', stderr: 'pipe' })
    if (listed.exitCode !== 0) throw new Error(`Unable to list ${target.asset}`)
    assertSafeArchiveEntries(new TextDecoder().decode(listed.stdout).split(/\r?\n/).filter(Boolean))

    if (isZip && process.platform === 'win32') {
      run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`], 'RTK extraction')
    } else if (isZip) {
      run(['unzip', '-q', archivePath, '-d', extractDir], 'RTK extraction')
    } else {
      run(['tar', '-xzf', archivePath, '-C', extractDir], 'RTK extraction')
    }

    const binary = findFile(extractDir, target.binary)
    if (!binary) throw new Error(`RTK archive did not contain ${target.binary}`)
    const root = resolve(extractDir)
    const binaryRelative = relative(root, resolve(binary))
    if (isAbsolute(binaryRelative) || binaryRelative === '..' || binaryRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('Resolved RTK binary escaped extraction directory')
    }

    mkdirSync(targetDir, { recursive: true })
    copyFileSync(binary, targetPath)
    if (platform !== 'win32') chmodSync(targetPath, 0o755)
    if (!validateExisting(targetPath, manifest.version)) {
      throw new Error(`Staged RTK failed version verification at ${targetPath}`)
    }
    console.log(`RTK ${manifest.version} staged: ${targetPath} ✓`)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

await main()
