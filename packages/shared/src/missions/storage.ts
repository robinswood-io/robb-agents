import {
  constants,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MissionEventSchema, reduceMissionEvents, type MissionEvent, type MissionSnapshot } from './events.ts';
import { MISSION_ID_RE } from './schema.ts';
import {
  canonicalConfinementRoot,
  ensureConfinedDirectory,
  openConfinedRegularFile,
  pathIsWithinRoot,
  unlinkConfinedRegularFile,
  type ConfinedRegularFile,
} from './confined-file.ts';

const MISSIONS_DIR = 'missions';
const JOURNAL_FILE = 'events.jsonl';
const LOCK_FILE = `${JOURNAL_FILE}.lock`;
const INTEGRITY_VERSION = 2 as const;
const EMPTY_CHECKSUM = '0'.repeat(64);
const STALE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

interface Integrity {
  version: typeof INTEGRITY_VERSION;
  batchSequence: number;
  fromRevision: number;
  toRevision: number;
  previousChecksum: string;
  checksum: string;
}

interface StoredBatch {
  events: MissionEvent[];
  _integrity: Integrity;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checksumFor(
  events: readonly MissionEvent[],
  batchSequence: number,
  fromRevision: number,
  toRevision: number,
  previousChecksum: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: INTEGRITY_VERSION,
      batchSequence,
      fromRevision,
      toRevision,
      previousChecksum,
      events,
    }))
    .digest('hex');
}

function parseIntegrity(value: unknown): Integrity {
  if (!isRecord(value) || value.version !== INTEGRITY_VERSION ||
      !Number.isInteger(value.batchSequence) || (value.batchSequence as number) <= 0 ||
      !Number.isInteger(value.fromRevision) || (value.fromRevision as number) <= 0 ||
      !Number.isInteger(value.toRevision) || (value.toRevision as number) < (value.fromRevision as number) ||
      typeof value.previousChecksum !== 'string' || typeof value.checksum !== 'string') {
    throw new Error('Mission journal integrity metadata is invalid');
  }
  return value as unknown as Integrity;
}

interface ParsedJournal {
  events: MissionEvent[];
  lastBatchSequence: number;
  lastRevision: number;
  lastChecksum: string;
}

function parseJournal(text: string): ParsedJournal {
  const lines = text.split('\n');
  const lastNonEmpty = lines.findLastIndex((line) => line.trim().length > 0);
  const events: MissionEvent[] = [];
  let lastBatchSequence = 0;
  let lastRevision = 0;
  let lastChecksum = EMPTY_CHECKSUM;

  for (let index = 0; index <= lastNonEmpty; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      if (index === lastNonEmpty && !text.endsWith('\n')) break;
      throw new Error(`Mission journal integrity failure: malformed record at line ${index + 1}`);
    }
    if (!isRecord(raw)) throw new Error(`Mission journal integrity failure: record ${index + 1} is not an object`);
    const integrity = parseIntegrity(raw._integrity);
    if (!Array.isArray(raw.events) || raw.events.length === 0) {
      throw new Error(`Mission journal integrity failure: batch ${index + 1} has no events`);
    }
    const batchEvents = raw.events.map((event) => MissionEventSchema.parse(event));
    if (
      integrity.batchSequence !== lastBatchSequence + 1 ||
      integrity.fromRevision !== lastRevision + 1 ||
      integrity.toRevision !== lastRevision + batchEvents.length ||
      integrity.previousChecksum !== lastChecksum
    ) {
      throw new Error(`Mission journal integrity failure: broken checksum chain at line ${index + 1}`);
    }
    const expected = checksumFor(
      batchEvents,
      integrity.batchSequence,
      integrity.fromRevision,
      integrity.toRevision,
      integrity.previousChecksum,
    );
    if (integrity.checksum !== expected) {
      throw new Error(`Mission journal integrity failure: checksum mismatch at line ${index + 1}`);
    }
    lastBatchSequence = integrity.batchSequence;
    lastRevision = integrity.toRevision;
    lastChecksum = integrity.checksum;
    events.push(...batchEvents);
  }
  return { events, lastBatchSequence, lastRevision, lastChecksum };
}

function finalRecordIsMalformed(text: string): boolean {
  if (text.length === 0 || text.endsWith('\n')) return false;
  const tail = text.slice(text.lastIndexOf('\n') + 1).trim();
  if (!tail) return false;
  try { JSON.parse(tail); return false; } catch { return true; }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return errnoCode(error) !== 'ESRCH'; }
}

function removeStaleLock(workspaceRoot: string, lockPath: string): boolean {
  let handle: ConfinedRegularFile;
  try {
    handle = openConfinedRegularFile(workspaceRoot, lockPath, { flags: constants.O_RDONLY });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    throw error;
  }
  try {
    const initial = handle.initialStat;
    let ownerDead = false;
    try {
      const raw: unknown = JSON.parse(readFileSync(handle.descriptor, 'utf-8'));
      ownerDead = isRecord(raw) && typeof raw.pid === 'number' && !processIsAlive(raw.pid);
    } catch { /* age is the fallback proof */ }
    handle.assertStillBound();
    if (!ownerDead && Date.now() - initial.mtimeMs <= STALE_LOCK_MAX_AGE_MS) return false;
    unlinkConfinedRegularFile(handle);
    return true;
  } finally {
    handle.close();
  }
}

function withJournalLock<T>(workspaceRoot: string, lockPath: string, operation: () => T): T {
  let handle: ConfinedRegularFile | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      handle = openConfinedRegularFile(workspaceRoot, lockPath, {
        flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        mode: 0o600,
        allowCreate: true,
      });
      break;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
      if (removeStaleLock(workspaceRoot, lockPath)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (handle === undefined) throw new Error(`Mission journal lock unavailable: ${lockPath}`);
  try {
    writeSync(handle.descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), undefined, 'utf-8');
    fsyncSync(handle.descriptor);
    handle.assertStillBound();
    return operation();
  } finally {
    try {
      unlinkConfinedRegularFile(handle);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
    } finally {
      handle.close();
    }
  }
}

export function missionsRoot(workspaceRoot: string): string { return join(workspaceRoot, MISSIONS_DIR); }
export function missionDir(workspaceRoot: string, missionId: string): string {
  if (!MISSION_ID_RE.test(missionId)) throw new Error(`Invalid mission id "${missionId}"`);
  return join(missionsRoot(workspaceRoot), missionId);
}
export function missionJournalPath(workspaceRoot: string, missionId: string): string { return join(missionDir(workspaceRoot, missionId), JOURNAL_FILE); }

/** Append an atomic, checksummed event batch under a cross-process lock. */
export function appendMissionEvents(
  workspaceRoot: string,
  missionId: string,
  input: readonly MissionEvent[],
  expectedRevision?: number,
): void {
  if (input.length === 0) return;
  const events = input.map((event) => MissionEventSchema.parse(event));
  if (!MISSION_ID_RE.test(missionId)) throw new Error(`Invalid mission id "${missionId}"`);
  const canonicalWorkspace = canonicalConfinementRoot(workspaceRoot);
  const dir = ensureConfinedDirectory(canonicalWorkspace, MISSIONS_DIR, missionId);
  const path = join(dir, JOURNAL_FILE);
  withJournalLock(canonicalWorkspace, join(dir, LOCK_FILE), () => {
    const handle = openConfinedRegularFile(canonicalWorkspace, path, {
      flags: constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
      mode: 0o600,
      allowCreate: true,
    });
    try {
      let text = readFileSync(handle.descriptor, 'utf-8');
      const parsed = parseJournal(text);
      if (expectedRevision !== undefined && parsed.lastRevision !== expectedRevision) {
        throw new Error(
          `Mission journal revision conflict for "${missionId}": expected ${expectedRevision}, found ${parsed.lastRevision}`,
        );
      }
      if (finalRecordIsMalformed(text)) {
        const validCharacterLength = text.lastIndexOf('\n') + 1;
        const validText = text.slice(0, validCharacterLength);
        ftruncateSync(handle.descriptor, Buffer.byteLength(validText));
        text = validText;
      }
      const batchSequence = parsed.lastBatchSequence + 1;
      const fromRevision = parsed.lastRevision + 1;
      const toRevision = parsed.lastRevision + events.length;
      const previousChecksum = parsed.lastChecksum;
      const checksum = checksumFor(events, batchSequence, fromRevision, toRevision, previousChecksum);
      const stored: StoredBatch = {
        events,
        _integrity: {
          version: INTEGRITY_VERSION,
          batchSequence,
          fromRevision,
          toRevision,
          previousChecksum,
          checksum,
        },
      };
      const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
      const payload = Buffer.from(`${separator}${JSON.stringify(stored)}\n`, 'utf-8');
      let offset = 0;
      while (offset < payload.length) {
        offset += writeSync(handle.descriptor, payload, offset, payload.length - offset);
      }
      fsyncSync(handle.descriptor);
      handle.assertStillBound();
    } finally {
      handle.close();
    }
  });
}

export function readMissionEvents(workspaceRoot: string, missionId: string): MissionEvent[] {
  const canonicalWorkspace = canonicalConfinementRoot(workspaceRoot);
  const path = missionJournalPath(canonicalWorkspace, missionId);
  let handle: ConfinedRegularFile;
  try {
    handle = openConfinedRegularFile(canonicalWorkspace, path, { flags: constants.O_RDONLY });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  try {
    const text = readFileSync(handle.descriptor, 'utf-8');
    handle.assertStillBound();
    return parseJournal(text).events;
  } finally {
    handle.close();
  }
}

export function loadMissionSnapshot(workspaceRoot: string, missionId: string): MissionSnapshot | null {
  const events = readMissionEvents(workspaceRoot, missionId);
  return events.length === 0 ? null : reduceMissionEvents(events);
}

export function listMissionIds(workspaceRoot: string): string[] {
  const canonicalWorkspace = canonicalConfinementRoot(workspaceRoot);
  const root = missionsRoot(canonicalWorkspace);
  let initial: ReturnType<typeof lstatSync>;
  try {
    initial = lstatSync(root);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error(`Mission root is not a real directory: ${root}`);
  }
  const canonicalRoot = canonicalConfinementRoot(root);
  if (!pathIsWithinRoot(canonicalWorkspace, canonicalRoot) || canonicalRoot !== root) {
    throw new Error(`Mission root escapes its workspace: ${root}`);
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const current = lstatSync(root);
  if (current.dev !== initial.dev || current.ino !== initial.ino || !current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`Mission root changed while it was listed: ${root}`);
  }
  const missionIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !MISSION_ID_RE.test(entry.name)) continue;
    let handle: ConfinedRegularFile;
    try {
      handle = openConfinedRegularFile(canonicalWorkspace, join(root, entry.name, JOURNAL_FILE), {
        flags: constants.O_RDONLY,
      });
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') continue;
      throw error;
    }
    try {
      handle.assertStillBound();
      missionIds.push(entry.name);
    } finally {
      handle.close();
    }
  }
  return missionIds.sort();
}
