import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "../../utils/files.ts";
import type { VerifiedLearningAuthority, VerifiedLearningEvent, VerifiedLearningProjection } from './contracts.ts';
import { MAX_LEDGER_BYTES, VerifiedLearningEventSchema } from './contracts.ts';
import { verifyVerifiedLearningHistory } from './history.ts';

/** Durable proposal-only ledger. It persists hashes/signatures, never candidate content. */
export class VerifiedLearningStore {
  private readonly lockPath: string;

  /**
   * A key-only resolver is intentionally insufficient: every read and write must
   * also re-establish the host-resolved actor role and human-reviewer binding.
   */
  constructor(private readonly path: string, private readonly authority: VerifiedLearningAuthority) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lockPath = `${path}.lock`;
  }

  create(event: VerifiedLearningEvent): VerifiedLearningProjection {
    return withLearningLock(this.lockPath, () => {
      if (existsSync(this.path)) throw new Error('Learning proposal ledger already exists');
      const verified = verifyVerifiedLearningHistory([event], this.authority);
      if (!verified.valid) throw new Error(verified.reason);
      this.write(verified.events);
      return verified.projection;
    });
  }

  append(event: VerifiedLearningEvent, expectedSequence: number): VerifiedLearningProjection {
    return withLearningLock(this.lockPath, () => {
      const current = this.readUnsafe();
      if (current.length !== expectedSequence) {
        throw new Error(`Learning ledger sequence conflict: expected ${expectedSequence}, found ${current.length}`);
      }
      const next = [...current, event];
      const verified = verifyVerifiedLearningHistory(next, this.authority);
      if (!verified.valid) throw new Error(verified.reason);
      this.write(verified.events);
      return verified.projection;
    });
  }

  read(): VerifiedLearningEvent[] {
    const events = this.readUnsafe();
    const verified = verifyVerifiedLearningHistory(events, this.authority);
    if (!verified.valid) throw new Error(verified.reason);
    return structuredClone(verified.events);
  }

  projection(): VerifiedLearningProjection {
    const verified = verifyVerifiedLearningHistory(this.readUnsafe(), this.authority);
    if (!verified.valid) throw new Error(verified.reason);
    return verified.projection;
  }

  private readUnsafe(): unknown[] {
    if (!existsSync(this.path)) return [];
    if (statSync(this.path).size > MAX_LEDGER_BYTES) throw new Error('Learning proposal ledger exceeds 16 MiB');
    const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    const parsed = LearningLedgerSchema.safeParse(value);
    if (!parsed.success) throw new Error('Learning proposal ledger shape is invalid');
    return parsed.data.events;
  }

  private write(events: VerifiedLearningEvent[]): void {
    const ledger = LearningLedgerSchema.parse({ schemaVersion: 1, events });
    const serialized = `${JSON.stringify(ledger, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_BYTES) {
      throw new Error('Learning proposal ledger exceeds 16 MiB');
    }
    atomicWriteFileSync(this.path, serialized);
  }
}

const LearningLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.array(VerifiedLearningEventSchema).min(1).max(10_000),
}).strict();

function withLearningLock<T>(path: string, operation: () => T): T {
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { descriptor = openSync(path, 'wx', 0o600); break; } catch (error) {
      if (learningErrorCode(error) !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
      } catch (nested) { if (learningErrorCode(nested) !== 'ENOENT') throw nested; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (descriptor === undefined) throw new Error('Learning proposal ledger lock is unavailable');
  try {
    writeSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(path); } catch (error) { if (learningErrorCode(error) !== 'ENOENT') throw error; }
  }
}

function learningErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : undefined;
}
