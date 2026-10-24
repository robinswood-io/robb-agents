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
import { closeSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "fs";
import { STALE_LOCK_MAX_AGE_MS, errnoCode, isRecord } from './run-integrity.ts';

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ESRCH') return false;
    // EPERM means the process exists but is owned by another user.
    return true;
  }
}

function removeStaleRunLogLock(lockPath: string): boolean {
  let initialStat: ReturnType<typeof statSync>;
  try {
    initialStat = statSync(lockPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    throw error;
  }

  let ownerIsDead = false;
  try {
    const raw: unknown = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (isRecord(raw) && typeof raw.pid === 'number') {
      ownerIsDead = !processIsAlive(raw.pid);
    }
  } catch {
    // A writer may be between open("wx") and writing metadata. Only age can
    // prove that an unreadable lock is stale.
  }

  const expired = Date.now() - initialStat.mtimeMs > STALE_LOCK_MAX_AGE_MS;
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

export function withRunLogLock<T>(lockPath: string, operation: () => T): T {
  let fd: number | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
      if (removeStaleRunLogLock(lockPath)) continue;
      // Keep lock contention bounded while allowing another writer to fsync and release.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (fd === undefined) {
    throw new Error(`Run log integrity lock unavailable: ${lockPath}`);
  }

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), undefined, 'utf-8');
    fsyncSync(fd);
    return operation();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
    }
  }
}
