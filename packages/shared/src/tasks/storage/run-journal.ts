/**
 * Task + run-state persistence.
 *
 * Layout under the workspace root (architecture §6, LOCKED #6):
 *   {workspaceRoot}/tasks/<slug>/task.yaml                    — the editable spec
 *   {workspaceRoot}/tasks/<slug>/runs/<runId>/run-log.jsonl   — append-only run log
 *   {workspaceRoot}/tasks/<slug>/runs/<runId>/nodes/<id>.json — per-node output
 *
 * The run log is the durability substrate: replaying it re-derives scheduling
 * decisions and reuses recorded node outputs (it never re-runs a node body).
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, statSync, truncateSync, writeSync } from "fs";
import { join } from "path";
import { SLUG_RE } from "../schema.ts";
import type { StoredRunLogRecord } from './run-integrity.ts';
import { EMPTY_CHECKSUM, RUN_LOG_INTEGRITY_VERSION, RUN_LOG_LOCK, checksumFor, finalRecordIsMalformed, parseRunLogText, runLogHeadCache } from './run-integrity.ts';
import { withRunLogLock } from './run-lock.ts';
import type { RunLogEntry } from './run-types.ts';
import { RUNS_DIR, RUN_LOG } from './run-types.ts';
import { ensureDir, runDir, taskDir } from './task-files.ts';

/**
 * Append one checksummed entry to the run log.
 *
 * The append is one O_APPEND write followed by fsync, protected by an exclusive
 * lock file so concurrent processes cannot fork the checksum chain.
 */
export function appendRunLog(workspaceRoot: string, slug: string, runId: string, entry: RunLogEntry): void {
  const dir = runDir(workspaceRoot, slug, runId);
  ensureDir(dir);
  const path = join(dir, RUN_LOG);
  const lockPath = join(dir, RUN_LOG_LOCK);
  withRunLogLock(lockPath, () => {
    let existingText = '';
    let existingSize = 0;
    let endsWithNewline = true;
    let lastSequence = 0;
    let lastChecksum = EMPTY_CHECKSUM;

    if (existsSync(path)) {
      const currentStat = statSync(path);
      const cached = runLogHeadCache.get(path);
      if (
        cached !== undefined &&
        cached.size === currentStat.size &&
        cached.mtimeMs === currentStat.mtimeMs &&
        cached.endsWithNewline
      ) {
        existingSize = cached.size;
        lastSequence = cached.lastSequence;
        lastChecksum = cached.lastChecksum;
      } else {
        existingText = readFileSync(path, 'utf-8');
        const parsed = parseRunLogText(existingText);
        lastSequence = parsed.lastSequence;
        lastChecksum = parsed.lastChecksum;
        if (finalRecordIsMalformed(existingText)) {
          // The reader already verified every preceding record. Remove only
          // the interrupted final append before extending the chain.
          const validLength = existingText.lastIndexOf('\n') + 1;
          truncateSync(path, validLength);
          existingText = existingText.slice(0, validLength);
        }
        existingSize = Buffer.byteLength(existingText);
        endsWithNewline = existingText.length === 0 || existingText.endsWith('\n');
      }
    }

    const sequence = lastSequence + 1;
    const checksum = checksumFor(entry, sequence, lastChecksum);
    const stored: StoredRunLogRecord = {
      ...entry,
      _integrity: {
        version: RUN_LOG_INTEGRITY_VERSION,
        sequence,
        previousChecksum: lastChecksum,
        checksum,
      },
    };

    const logFd = openSync(path, 'a', 0o600);
    try {
      const separator = existingSize > 0 && !endsWithNewline ? '\n' : '';
      const payload = `${separator}${JSON.stringify(stored)}\n`;
      writeSync(logFd, payload, undefined, 'utf-8');
      fsyncSync(logFd);
    } finally {
      closeSync(logFd);
    }

    const appendedStat = statSync(path);
    runLogHeadCache.set(path, {
      size: appendedStat.size,
      mtimeMs: appendedStat.mtimeMs,
      lastSequence: sequence,
      lastChecksum: checksum,
      endsWithNewline: true,
    });
  });
}

/**
 * Read + verify the run log in append order.
 *
 * A truncated final append is ignored (the preceding fsynced records remain
 * recoverable). Any other malformed or tampered record fails closed.
 */
export function readRunLog(workspaceRoot: string, slug: string, runId: string): RunLogEntry[] {
  const path = join(runDir(workspaceRoot, slug, runId), RUN_LOG);
  if (!existsSync(path)) return [];
  return parseRunLogText(readFileSync(path, 'utf-8')).entries;
}

/** List run ids for a task (sorted lexicographically). */
export function listRunIds(workspaceRoot: string, slug: string): string[] {
  const runs = join(taskDir(workspaceRoot, slug), RUNS_DIR);
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SLUG_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}
