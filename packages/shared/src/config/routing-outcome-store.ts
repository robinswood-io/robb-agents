import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/files.ts';
import { buildRoutingShadowReport, type RoutingShadowReportOptions } from './routing-shadow.ts';
import { validateRoutingOutcome, type RoutingOutcome } from './routing-outcomes.ts';

const LOCK_STALE_MS = 5 * 60 * 1_000;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== 'ESRCH'; }
}

function removeStaleLock(path: string): boolean {
  try {
    const stat = statSync(path);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof value.pid === 'number' && processAlive(value.pid)) return false;
      } catch { return false; }
    }
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw error;
  }
}

function withLock<T>(path: string, operation: () => T): T {
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { descriptor = openSync(path, 'wx', 0o600); break; } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (removeStaleLock(path)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (descriptor === undefined) throw new Error('Routing outcome store lock is unavailable');
  try {
    writeSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fsyncSync(descriptor);
    return operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(path); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}

export class RoutingOutcomeStore {
  readonly filePath: string;
  private readonly lockPath: string;

  constructor(workspaceRoot: string, private readonly maxEntries = 10_000) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error('maxEntries must be positive');
    const directory = join(workspaceRoot, '.robb');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filePath = join(directory, 'routing-outcomes.jsonl');
    this.lockPath = join(directory, 'routing-outcomes.lock');
  }

  record(outcome: RoutingOutcome): boolean {
    const validation = validateRoutingOutcome(outcome);
    if (!validation.valid) throw new Error(`Invalid routing outcome: ${validation.errors.join(', ')}`);
    return withLock(this.lockPath, () => {
      const current = this.readUnsafe();
      if (current.some((entry) => entry.id === outcome.id)) return false;
      if (current.length >= this.maxEntries) {
        const compacted = [...current.slice(-(this.maxEntries - 1)), outcome];
        atomicWriteFileSync(this.filePath, compacted.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      } else {
        if (existsSync(this.filePath)) {
          const text = readFileSync(this.filePath, 'utf8');
          if (text && !text.endsWith('\n')) {
            const tail = text.slice(text.lastIndexOf('\n') + 1);
            try { JSON.parse(tail); } catch {
              truncateSync(this.filePath, Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)));
            }
          }
        }
        const descriptor = openSync(this.filePath, 'a', 0o600);
        try {
          writeSync(descriptor, `${JSON.stringify(outcome)}\n`, undefined, 'utf8');
          fsyncSync(descriptor);
        } finally { closeSync(descriptor); }
      }
      return true;
    });
  }

  read(filter: { missionId?: string; sessionId?: string } = {}): RoutingOutcome[] {
    return this.readUnsafe().filter((outcome) =>
      (!filter.missionId || outcome.missionId === filter.missionId)
      && (!filter.sessionId || outcome.sessionId === filter.sessionId));
  }

  buildShadowReport(options: RoutingShadowReportOptions = {}) {
    return buildRoutingShadowReport(this.read(), options);
  }

  private readUnsafe(): RoutingOutcome[] {
    if (!existsSync(this.filePath)) return [];
    const text = readFileSync(this.filePath, 'utf8');
    const lines = text.split('\n');
    const last = lines.findLastIndex((line) => line.trim().length > 0);
    const outcomes: RoutingOutcome[] = [];
    for (let index = 0; index <= last; index += 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let value: RoutingOutcome;
      try { value = JSON.parse(line) as RoutingOutcome; } catch {
        if (index === last && !text.endsWith('\n')) break;
        throw new Error(`Routing outcome journal is malformed at line ${index + 1}`);
      }
      const validation = validateRoutingOutcome(value);
      if (!validation.valid) throw new Error(`Routing outcome journal is invalid at line ${index + 1}`);
      outcomes.push(value);
    }
    return outcomes;
  }
}
