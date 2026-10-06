#!/usr/bin/env bun
/** Stage the pinned uv runtime required by packaged Python document tools. */
import { chmodSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  downloadUv,
  getPlatformKey,
  UV_VERSION,
  type Arch,
  type BuildConfig,
  type Platform,
} from './build/common.ts';

const ROOT = resolve(import.meta.dir, '..');
const ELECTRON_DIR = join(ROOT, 'apps', 'electron');
const SUPPORTED_PLATFORMS = new Set<Platform>(['darwin', 'linux', 'win32']);
const SUPPORTED_ARCHITECTURES = new Set<Arch>(['arm64', 'x64']);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parsePlatform(value: string): Platform {
  if (!SUPPORTED_PLATFORMS.has(value as Platform)) throw new Error(`Unsupported uv platform: ${value}`);
  return value as Platform;
}

function parseArch(value: string): Arch {
  if (!SUPPORTED_ARCHITECTURES.has(value as Arch)) throw new Error(`Unsupported uv architecture: ${value}`);
  return value as Arch;
}

export function validateUvBinary(
  binaryPath: string,
  platform: Platform,
  expectedVersion: string,
  nativeTarget: boolean,
): boolean {
  try {
    const stats = lstatSync(binaryPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1_000_000) return false;
    if (platform !== 'win32' && (stats.mode & 0o111) === 0) return false;
    if (!nativeTarget) return true;
    const result = Bun.spawnSync([binaryPath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) return false;
    const output = new TextDecoder().decode(result.stdout).trim();
    return output === `uv ${expectedVersion}` || output.startsWith(`uv ${expectedVersion} `);
  } catch {
    return false;
  }
}

export async function prepareUv(
  platform: Platform,
  arch: Arch,
  options: {
    refresh?: boolean;
    rootDir?: string;
    electronDir?: string;
    download?: (config: BuildConfig) => Promise<void>;
  } = {},
): Promise<string> {
  const rootDir = options.rootDir ?? ROOT;
  const electronDir = options.electronDir ?? ELECTRON_DIR;
  const binaryName = platform === 'win32' ? 'uv.exe' : 'uv';
  const targetPath = join(electronDir, 'resources', 'bin', getPlatformKey(platform, arch), binaryName);
  const nativeTarget = platform === process.platform && arch === process.arch;

  // Packaging always uses --refresh: ignored build artifacts are not source
  // provenance and must never be trusted merely because a file already exists.
  if (options.refresh || (existsSync(targetPath)
    && !validateUvBinary(targetPath, platform, UV_VERSION, nativeTarget))) {
    rmSync(targetPath, { force: true });
  }

  await (options.download ?? downloadUv)({
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir,
    electronDir,
  });

  if (platform !== 'win32') chmodSync(targetPath, 0o755);
  if (!validateUvBinary(targetPath, platform, UV_VERSION, nativeTarget)) {
    throw new Error(`Staged uv ${UV_VERSION} failed validation at ${targetPath}`);
  }
  console.log(`uv ${UV_VERSION} staged and verified: ${targetPath}`);
  return targetPath;
}

async function main(): Promise<void> {
  const platform = parsePlatform(option('--platform') ?? process.platform);
  const arch = parseArch(option('--arch') ?? process.arch);
  await prepareUv(platform, arch, { refresh: process.argv.includes('--refresh') });
}

if (import.meta.main) await main();
