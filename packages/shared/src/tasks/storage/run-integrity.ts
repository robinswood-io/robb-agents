import { createHash } from "crypto";
import type { RunLogEntry } from './run-types.ts';
import { RUN_LOG } from './run-types.ts';

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

export const RUN_LOG_INTEGRITY_VERSION = 1;

export const RUN_LOG_LOCK = `${RUN_LOG}.lock`;

export const EMPTY_CHECKSUM = '0'.repeat(64);

export const STALE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

interface RunLogIntegrity {
  version: typeof RUN_LOG_INTEGRITY_VERSION;
  sequence: number;
  previousChecksum: string;
  checksum: string;
}

export type StoredRunLogRecord = RunLogEntry & { _integrity: RunLogIntegrity };

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checksumFor(entry: RunLogEntry, sequence: number, previousChecksum: string): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: RUN_LOG_INTEGRITY_VERSION,
      sequence,
      previousChecksum,
      entry,
    }))
    .digest('hex');
}

function parseIntegrity(value: unknown): RunLogIntegrity | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== RUN_LOG_INTEGRITY_VERSION ||
    typeof value.sequence !== 'number' ||
    !Number.isInteger(value.sequence) ||
    value.sequence <= 0 ||
    typeof value.previousChecksum !== 'string' ||
    typeof value.checksum !== 'string'
  ) {
    throw new Error('Run log integrity metadata is invalid');
  }
  return {
    version: RUN_LOG_INTEGRITY_VERSION,
    sequence: value.sequence,
    previousChecksum: value.previousChecksum,
    checksum: value.checksum,
  };
}

interface ParsedRunLog {
  entries: RunLogEntry[];
  lastSequence: number;
  lastChecksum: string;
}

interface RunLogHead {
  size: number;
  mtimeMs: number;
  lastSequence: number;
  lastChecksum: string;
  endsWithNewline: boolean;
}

/**
 * Avoid replaying an ever-growing journal before every append in the same
 * process. Size + mtime are checked while holding the cross-process lock, so
 * an append performed by another process invalidates this cache.
 */
export const runLogHeadCache = new Map<string, RunLogHead>();

export function parseRunLogText(text: string): ParsedRunLog {
  const lines = text.split('\n');
  const lastNonEmptyIndex = lines.findLastIndex((line) => line.trim().length > 0);
  const entries: RunLogEntry[] = [];
  let lastSequence = 0;
  let lastChecksum = EMPTY_CHECKSUM;
  let integrityStarted = false;

  for (let index = 0; index <= lastNonEmptyIndex; index += 1) {
    const trimmed = lines[index]?.trim() ?? '';
    if (!trimmed) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      const isInterruptedFinalAppend = index === lastNonEmptyIndex && !text.endsWith('\n');
      if (isInterruptedFinalAppend) break;
      throw new Error(`Run log integrity failure: malformed JSONL record at line ${index + 1}`);
    }
    if (!isRecord(raw)) {
      throw new Error(`Run log integrity failure: record ${index + 1} is not an object`);
    }

    const integrity = parseIntegrity(raw._integrity);
    const { _integrity: _ignored, ...entryFields } = raw;
    const entry = entryFields as RunLogEntry;

    if (integrity === null) {
      if (integrityStarted) {
        throw new Error(`Run log integrity failure: missing checksum at line ${index + 1}`);
      }
      // Backward compatibility: legacy logs may precede the first checksummed append.
      entries.push(entry);
      continue;
    }

    integrityStarted = true;
    const expectedSequence = lastSequence + 1;
    if (integrity.sequence !== expectedSequence || integrity.previousChecksum !== lastChecksum) {
      throw new Error(`Run log integrity failure: broken checksum chain at line ${index + 1}`);
    }
    const expectedChecksum = checksumFor(entry, integrity.sequence, integrity.previousChecksum);
    if (integrity.checksum !== expectedChecksum) {
      throw new Error(`Run log integrity failure: checksum mismatch at line ${index + 1}`);
    }

    lastSequence = integrity.sequence;
    lastChecksum = integrity.checksum;
    entries.push(entry);
  }

  return { entries, lastSequence, lastChecksum };
}

export function finalRecordIsMalformed(text: string): boolean {
  if (text.length === 0 || text.endsWith('\n')) return false;
  const lastNewline = text.lastIndexOf('\n');
  const tail = text.slice(lastNewline + 1).trim();
  if (!tail) return false;
  try {
    JSON.parse(tail);
    return false;
  } catch {
    return true;
  }
}
