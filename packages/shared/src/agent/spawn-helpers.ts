/**
 * Helpers for the Claude SDK subprocess spawn site.
 *
 * Extracted to its own module so the directory probe, ENOENT detection,
 * and SDK wrapper-string regex can be unit-tested without spinning up a
 * full ClaudeAgent.
 */

import { lstatSync } from 'node:fs';
import { stat } from 'node:fs/promises';

/** A deterministic local configuration error, not a missing runtime binary. */
export class InvalidWorkingDirectoryError extends Error {
  constructor(readonly workingDirectory: string) {
    super(
      `Working directory "${workingDirectory}" is not an accessible directory on the host running this agent. ` +
      'Select an existing working directory on this host, then retry. ' +
      'For work over SSH, keep the remote path in the task instructions or remote commands, not in workingDirectory.',
    );
    this.name = 'InvalidWorkingDirectoryError';
  }
}

/** Follow valid directory symlinks, without blocking the host event loop. */
export async function assertExistingWorkingDirectory(workingDirectory: string): Promise<void> {
  try {
    if ((await stat(workingDirectory)).isDirectory()) return;
  } catch {
    // Missing, inaccessible, and non-directory paths cannot be spawn cwd values.
  }
  throw new InvalidWorkingDirectoryError(workingDirectory);
}

/**
 * Returns true iff `p` is an existing directory.
 *
 * Uses `lstatSync` so a symlink pointing at a missing target returns false
 * — broken symlinks must count as "missing" because spawn() will fail on them
 * anyway. Wrapped in try/catch so EACCES/ENOTDIR/etc. fall through cleanly.
 */
export function isExistingDirectory(p: string | null | undefined): boolean {
  if (!p) return false;
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Extract the SDK's reported binary path with a single forward scan. Keep
 * paths with spaces intact and remove only the SDK's optional final period.
 */
const SDK_BINARY_NOT_FOUND_PREFIX = 'Claude Code ';
const SDK_BINARY_NOT_FOUND_SUFFIX = ' not found at';
const SDK_BINARY_VARIANTS = ['native binary', 'executable'] as const;

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function stripSdkSentencePeriod(path: string): string {
  let lastNonWhitespace = path.length - 1;
  while (lastNonWhitespace >= 0 && isWhitespace(path[lastNonWhitespace])) {
    lastNonWhitespace -= 1;
  }
  return lastNonWhitespace >= 0 && path[lastNonWhitespace] === '.'
    ? path.slice(0, lastNonWhitespace)
    : path;
}

function findLineEnd(message: string, start: number): number {
  let end = start;
  while (end < message.length && !/[\n\r\u2028\u2029]/u.test(message[end] ?? '')) {
    end += 1;
  }
  return end;
}

export function extractSdkReportedBinaryPath(rawErrorMsg: string | null | undefined): string | undefined {
  if (!rawErrorMsg) return undefined;

  let searchFrom = 0;
  while (searchFrom < rawErrorMsg.length) {
    const markerStart = rawErrorMsg.indexOf(SDK_BINARY_NOT_FOUND_PREFIX, searchFrom);
    if (markerStart < 0) return undefined;

    let suffixStart: number | undefined;
    for (const variant of SDK_BINARY_VARIANTS) {
      const variantStart = markerStart + SDK_BINARY_NOT_FOUND_PREFIX.length;
      const candidateSuffixStart = variantStart + variant.length;
      if (
        rawErrorMsg.startsWith(variant, variantStart) &&
        rawErrorMsg.startsWith(SDK_BINARY_NOT_FOUND_SUFFIX, candidateSuffixStart)
      ) {
        suffixStart = candidateSuffixStart + SDK_BINARY_NOT_FOUND_SUFFIX.length;
        break;
      }
    }

    if (suffixStart === undefined || !isWhitespace(rawErrorMsg[suffixStart])) {
      searchFrom = markerStart + SDK_BINARY_NOT_FOUND_PREFIX.length;
      continue;
    }

    let pathStart = suffixStart;
    while (isWhitespace(rawErrorMsg[pathStart])) pathStart += 1;
    const pathEnd = findLineEnd(rawErrorMsg, pathStart);
    if (pathEnd > pathStart) {
      return stripSdkSentencePeriod(rawErrorMsg.slice(pathStart, pathEnd));
    }
    searchFrom = markerStart + SDK_BINARY_NOT_FOUND_PREFIX.length;
  }

  return undefined;
}

/**
 * Detect spawn ENOENT from any of the channels Node and the SDK use to surface it:
 * - structured fields on the thrown error (`code === 'ENOENT'`, `syscall === 'spawn …'`)
 * - stringified `spawn … ENOENT` in either the raw error or captured stderr
 * - the SDK's own wrapper string (`Claude Code native binary not found at …`)
 */
export function isSpawnEnoent(input: {
  errorCode?: string;
  errorSyscall?: string;
  rawErrorMsg?: string | null;
  stderr?: string | null;
}): boolean {
  const { errorCode, errorSyscall, rawErrorMsg, stderr } = input;
  if (errorCode === 'ENOENT' && errorSyscall && errorSyscall.startsWith('spawn')) return true;
  if (rawErrorMsg && /\bspawn\b[\s\S]*\bENOENT\b/.test(rawErrorMsg)) return true;
  if (stderr && /\bspawn\b[\s\S]*\bENOENT\b/.test(stderr)) return true;
  if (extractSdkReportedBinaryPath(rawErrorMsg) !== undefined) return true;
  return false;
}
