/**
 * Project Memory v2
 *
 * Local-first, append-only structured memory for a project. MEMORY.md remains
 * supported as a human-editable legacy source; this journal adds machine
 * readable provenance, temporal validity, confidence, lifecycle, and retrieval.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { repairIncompleteJournalTail } from './journal-parse.ts';
import type { MemoryJournalEvent, ProjectMemoryEntry, StoredMemoryJournalRecord } from './memory-schema.ts';
import { MEMORY_V2_FILENAME, MEMORY_V2_LOCK_SUFFIX, MEMORY_V2_SCHEMA_VERSION, MEMORY_V2_STALE_LOCK_MS, isRecord } from './memory-schema.ts';
import { checksumPayload } from './retrieval-ranking.ts';

export function getProjectMemoryJournalPath(
  workspaceRootPath: string,
  projectSlug: string,
): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectSlug)) throw new Error('Invalid project slug');
  return join(workspaceRootPath, 'projects', projectSlug, MEMORY_V2_FILENAME);
}

export function appendMemoryJournalSnapshot(
  workspaceRootPath: string,
  projectSlug: string,
  entry: ProjectMemoryEntry,
  recordedAt: string,
): void {
  const path = getProjectMemoryJournalPath(workspaceRootPath, projectSlug);
  mkdirSync(join(workspaceRootPath, 'projects', projectSlug), { recursive: true });

  const payload: MemoryJournalEvent = {
    schemaVersion: MEMORY_V2_SCHEMA_VERSION,
    eventId: `mevt_${randomUUID()}`,
    eventType: 'put',
    recordedAt,
    entry,
  };
  const record: StoredMemoryJournalRecord = {
    payload,
    checksum: checksumPayload(payload),
  };
  const line = `${JSON.stringify(record)}\n`;

  withMemoryJournalLock(`${path}${MEMORY_V2_LOCK_SUFFIX}`, () => {
    repairIncompleteJournalTail(path);
    const descriptor = openSync(path, 'a', 0o600);
    try {
      const written = writeSync(descriptor, line, null, 'utf8');
      if (written !== Buffer.byteLength(line, 'utf8')) {
        throw new Error(`Incomplete memory journal append: wrote ${written} bytes`);
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  });
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ESRCH') return false;
    // EPERM means the process exists but is owned by another user.
    return true;
  }
}

function removeStaleMemoryJournalLock(lockPath: string): boolean {
  let initialStat: ReturnType<typeof statSync>;
  try {
    initialStat = statSync(lockPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    throw error;
  }

  let ownerIsDead = false;
  try {
    const raw: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (isRecord(raw) && typeof raw["pid"] === 'number') {
      ownerIsDead = !processIsAlive(raw["pid"]);
    }
  } catch {
    // An unreadable lock is only stale once its age exceeds the limit.
  }
  const expired = Date.now() - initialStat.mtimeMs > MEMORY_V2_STALE_LOCK_MS;
  if (!ownerIsDead && !expired) return false;

  try {
    const currentStat = statSync(lockPath);
    if (currentStat.dev !== initialStat.dev || currentStat.ino !== initialStat.ino) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    throw error;
  }
}

function withMemoryJournalLock<T>(lockPath: string, operation: () => T): T {
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
      if (removeStaleMemoryJournalLock(lockPath)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (descriptor === undefined) {
    throw new Error(`Memory journal integrity lock unavailable: ${lockPath}`);
  }

  try {
    const metadata = JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const written = writeSync(descriptor, metadata, null, 'utf8');
    if (written !== Buffer.byteLength(metadata, 'utf8')) {
      throw new Error(`Incomplete memory journal lock metadata: wrote ${written} bytes`);
    }
    fsyncSync(descriptor);
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
    }
  }
}
