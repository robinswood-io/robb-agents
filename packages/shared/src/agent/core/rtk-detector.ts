/**
 * RTK binary detector.
 *
 * Resolves the RTK binary (https://github.com/rtk-ai/rtk) from the bundled
 * platform resources first, then from the user's PATH. Every candidate must
 * meet the `rtk rewrite` minimum version and expose `rtk pipe`, so a same-name
 * non-optimizer binary is never used.
 *
 * Result is cached per process; resetRtkPathCache() supports explicit recheck.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getBundledAssetsDir } from '../../utils/paths.ts';
import { RTK_METRICS_PATH } from './rtk-state.ts';

const REQUIRED_MIN_VERSION = { major: 0, minor: 23, patch: 0 } as const;

interface CachedStatus {
  path: string | null;
  version: string | null;
  source: 'bundled' | 'path' | null;
}

let cachedStatus: CachedStatus | undefined = undefined;

/**
 * Status of the rtk binary for UI display.
 */
export interface RtkStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Whether Robb Agents shipped RTK or resolved a user-managed PATH binary. */
  source: 'bundled' | 'path' | null;
}

/**
 * Get the absolute path to the rtk binary, or null if not installed
 * or installed version is below the required minimum.
 */
export function getRtkPath(): string | null {
  return resolveStatus().path;
}

/**
 * Get installation status for the rtk binary. Used by Settings UI to decide
 * between an "install" prompt and the enable/disable toggle.
 */
export function getRtkStatus(opts?: { forceRecheck?: boolean }): RtkStatus {
  if (opts?.forceRecheck) resetRtkPathCache();
  const { path, version, source } = resolveStatus();
  return { installed: path !== null, path, version, source };
}

/**
 * App-scoped savings from actual output shown to agents, including recovery
 * hints and unchanged stderr. Values are byte/4 estimates, not provider billing.
 * Global `rtk gain` also includes other applications and is never added here.
 */
export interface RtkGainStats {
  totalCommands: number;
  totalInput: number;
  totalOutput: number;
  totalSaved: number;
  avgSavingsPct: number;
  totalTimeMs: number;
  avgTimeMs: number;
}

export function getRtkGain(): RtkGainStats | null {
  if (!getRtkPath()) return null;
  try {
    return parseRtkOutputMetrics(readFileSync(RTK_METRICS_PATH, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? parseRtkOutputMetrics('') : null;
  }
}

export function parseRtkOutputMetrics(records: string): RtkGainStats {
  let totalCommands = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  let totalTimeMs = 0;
  for (const line of records.split('\n')) {
    const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (!match) continue;
    const [input, output, time] = match.slice(1).map(Number) as [number, number, number];
    if (![input, output, time].every(Number.isSafeInteger) || output >= input) continue;
    totalCommands++;
    inputBytes += input;
    outputBytes += output;
    totalTimeMs += time;
  }
  const totalInput = Math.floor(inputBytes / 4);
  const totalOutput = Math.floor(outputBytes / 4);
  return {
    totalCommands, totalInput, totalOutput, totalSaved: totalInput - totalOutput,
    avgSavingsPct: inputBytes ? 100 * (inputBytes - outputBytes) / inputBytes : 0,
    totalTimeMs, avgTimeMs: totalCommands ? totalTimeMs / totalCommands : 0,
  };
}

/** Clears the cached detection result so the next call probes PATH fresh. */
export function resetRtkPathCache(): void {
  cachedStatus = undefined;
}

function resolveStatus(): CachedStatus {
  if (cachedStatus !== undefined) return cachedStatus;

  for (const bundledPath of findBundledRtk()) {
    const version = readRtkVersion(bundledPath);
    if (version && meetsMinVersion(version) && supportsTokenOptimization(bundledPath)) {
      cachedStatus = { path: bundledPath, version, source: 'bundled' };
      return cachedStatus;
    }
  }

  const rtkPath = findRtkOnPath();
  if (!rtkPath) {
    cachedStatus = { path: null, version: null, source: null };
    return cachedStatus;
  }

  const version = readRtkVersion(rtkPath);
  if (!version || !meetsMinVersion(version) || !supportsTokenOptimization(rtkPath)) {
    cachedStatus = { path: null, version, source: null };
    return cachedStatus;
  }

  cachedStatus = { path: rtkPath, version, source: 'path' };
  return cachedStatus;
}

function isPhysicalExecutablePath(path: string): boolean {
  // Electron can report that an ASAR member exists, but execFile cannot execute
  // it. An adjacent .asar.unpacked directory is a real filesystem path.
  return isAbsolute(path) && !/\.asar(?:[\\/]|$)/i.test(path);
}

function findBundledRtk(): string[] {
  // These roots are set by host bootstrap, never taken from model/tool input.
  // The main JS assets root may be app.asar while native tools live next to it
  // under Resources/app. Standalone servers set CRAFT_BUNDLED_ASSETS_ROOT.
  const binDirs = [
    ...[process.env.CRAFT_RESOURCES_BASE, process.env.CRAFT_BUNDLED_ASSETS_ROOT]
      .filter((root): root is string => !!root && isPhysicalExecutablePath(root))
      .map(root => join(root, 'resources', 'bin')),
    getBundledAssetsDir('bin'),
  ];
  const binary = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
  return [...new Set(binDirs
    .filter((dir): dir is string => !!dir)
    .map(dir => join(dir, `${process.platform}-${process.arch}`, binary)))]
    .filter(candidate => isPhysicalExecutablePath(candidate) && existsSync(candidate));
}

function findRtkOnPath(): string | null {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(whichCmd, ['rtk'], {
      encoding: 'utf-8', timeout: 2000, env: { ...process.env },
    }).trim();
    // `where` returns multiple lines on Windows — take the first.
    const candidate = result.split('\n')[0]?.trim();
    return candidate && isPhysicalExecutablePath(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function readRtkVersion(rtkPath: string): string | null {
  try {
    const out = execFileSync(rtkPath, ['--version'], { encoding: 'utf-8', timeout: 2000, env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' } }).trim();
    return out.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function supportsTokenOptimization(rtkPath: string): boolean {
  try {
    execFileSync(rtkPath, ['pipe', '--help'], {
      encoding: 'utf-8',
      timeout: 2_000,
      env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' },
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function meetsMinVersion(version: string): boolean {
  const m = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (major !== REQUIRED_MIN_VERSION.major) return major > REQUIRED_MIN_VERSION.major;
  if (minor !== REQUIRED_MIN_VERSION.minor) return minor > REQUIRED_MIN_VERSION.minor;
  return patch >= REQUIRED_MIN_VERSION.patch;
}
