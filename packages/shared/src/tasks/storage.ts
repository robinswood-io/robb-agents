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
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { atomicWriteFileSync, stripBom } from '../utils/files.ts';
import { validateTaskInput } from './validate.ts';
import { TaskSpecSchema, type TaskSpec } from './schema.ts';
import type { NodeOutput } from './refs.ts';
import type { ValidationResult } from '../config/validators.ts';

const TASKS_DIR = 'tasks';
const TASK_FILE = 'task.yaml';
const RUNS_DIR = 'runs';
const RUN_LOG = 'run-log.jsonl';
const NODES_DIR = 'nodes';

// ---------------------------------------------------------------------------
// Run-state types
// ---------------------------------------------------------------------------

/** Per-node lifecycle state recorded in the run log. Richer than the board's SubtaskRunState. */
export type NodeRunState = 'pending' | 'waiting-approval' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

/** Append-only run-log event. `t` is an ISO-8601 timestamp. */
export type RunLogEntry =
  | { t: string; kind: 'run-started'; taskId: string; runId: string; orchestratorSessionId?: string }
  | { t: string; kind: 'node-scheduled'; nodeId: string }
  | { t: string; kind: 'node-spawned'; nodeId: string; sessionId: string }
  | {
      t: string;
      kind: 'node-checkpoint';
      nodeId: string;
      idempotencyKey: string;
      status: 'prepared' | 'executing' | 'confirmed';
      proofHash?: string;
    }
  | { t: string; kind: 'node-finished'; nodeId: string; sessionId: string; state: NodeRunState; reason?: string }
  | {
      t: string;
      kind: 'node-retry';
      nodeId: string;
      attempt: number;
      reason: string;
      delayMs?: number;
      retryAt?: string;
    }
  | { t: string; kind: 'run-paused' | 'run-resumed' | 'run-stopped' | 'run-completed' | 'run-failed' | 'run-verifying' }
  | { t: string; kind: 'verdict'; result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] }
  | {
      t: string;
      kind: 'approval-requested';
      requestId: string;
      nodeId: string;
      reason: string;
      impact: 'low' | 'medium' | 'high' | 'critical';
      owner?: string;
    }
  | {
      t: string;
      kind: 'approval-resolved';
      requestId: string;
      nodeId: string;
      decision: 'approved' | 'rejected';
      actor: string;
      comment?: string;
    }
  | { t: string; kind: 'run-replayed'; sourceRunId: string; externalMutationsApproved: boolean }
  | { t: string; kind: 'node-reused'; nodeId: string; sourceRunId: string; proofHash?: string }
  | { t: string; kind: 'usage-updated'; tokensUsed: number; costUsed?: number; currency?: 'USD' | 'EUR' }
  | { t: string; kind: 'budget-breach'; metric: 'tokens' | 'cost' | 'parallel' | 'iterations'; value: number; limit: number }
  | { t: string; kind: 'deadline-breach'; deadline: string }
  | { t: string; kind: 'kill-switch'; scope: 'global' | 'workspace' | 'mission'; reason: string };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function tasksRoot(workspaceRoot: string): string {
  return join(workspaceRoot, TASKS_DIR);
}
export function taskDir(workspaceRoot: string, slug: string): string {
  return join(workspaceRoot, TASKS_DIR, slug);
}
export function taskYamlPath(workspaceRoot: string, slug: string): string {
  return join(taskDir(workspaceRoot, slug), TASK_FILE);
}
export function runDir(workspaceRoot: string, slug: string, runId: string): string {
  return join(taskDir(workspaceRoot, slug), RUNS_DIR, runId);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// task.yaml
// ---------------------------------------------------------------------------

/** Parse a task.yaml string → validated spec + issues. Does NOT throw on invalid specs. */
export function parseTaskYaml(yamlText: string): ValidationResult & { spec?: TaskSpec } {
  let raw: unknown;
  try {
    raw = parseYaml(stripBom(yamlText));
  } catch (e) {
    return {
      valid: false,
      errors: [{ file: TASK_FILE, path: 'root', message: `Invalid YAML: ${(e as Error).message}`, severity: 'error' }],
      warnings: [],
    };
  }
  return validateTaskInput(raw);
}

/** Serialize a spec to a task.yaml string. */
export function serializeTaskYaml(spec: TaskSpec): string {
  return stringifyYaml(spec);
}

/** Load + validate the task.yaml for a slug. Returns null if no file exists. */
export function loadTaskSpec(
  workspaceRoot: string,
  slug: string,
): (ValidationResult & { spec?: TaskSpec }) | null {
  const path = taskYamlPath(workspaceRoot, slug);
  if (!existsSync(path)) return null;
  return parseTaskYaml(readFileSync(path, 'utf-8'));
}

/** Write a spec to disk as task.yaml. Validates the shape first; throws on invalid. */
export function saveTaskSpec(workspaceRoot: string, spec: TaskSpec): void {
  const parsed = TaskSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error(`Refusing to save invalid task spec: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  ensureDir(taskDir(workspaceRoot, parsed.data.id));
  atomicWriteFileSync(taskYamlPath(workspaceRoot, parsed.data.id), serializeTaskYaml(parsed.data));
}

/** List task slugs (subdirectories of tasks/ that contain a task.yaml). */
export function listTaskSlugs(workspaceRoot: string): string[] {
  const root = tasksRoot(workspaceRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, TASK_FILE)))
    .map((d) => d.name)
    .sort();
}

/** List task slugs that retain persisted runs, even if task.yaml was deleted. */
export function listTaskRunSlugs(workspaceRoot: string): string[] {
  const root = tasksRoot(workspaceRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, RUNS_DIR)))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

const RUN_LOG_INTEGRITY_VERSION = 1;
const RUN_LOG_LOCK = `${RUN_LOG}.lock`;
const EMPTY_CHECKSUM = '0'.repeat(64);
const STALE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

interface RunLogIntegrity {
  version: typeof RUN_LOG_INTEGRITY_VERSION;
  sequence: number;
  previousChecksum: string;
  checksum: string;
}

type StoredRunLogRecord = RunLogEntry & { _integrity: RunLogIntegrity };

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checksumFor(entry: RunLogEntry, sequence: number, previousChecksum: string): string {
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
const runLogHeadCache = new Map<string, RunLogHead>();

function parseRunLogText(text: string): ParsedRunLog {
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

function finalRecordIsMalformed(text: string): boolean {
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

function withRunLogLock<T>(lockPath: string, operation: () => T): T {
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
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Per-run spec snapshot
// ---------------------------------------------------------------------------

const RUN_SPEC = 'spec.json';
const RUN_CONTEXT = 'context.json';

export interface RunContextSnapshot {
  params: Record<string, unknown>;
  verifyOnComplete: boolean;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}

function parseRunContext(raw: unknown, slug: string, runId: string): RunContextSnapshot {
  if (
    !isRecord(raw) ||
    !isRecord(raw.params) ||
    !Object.values(raw.params).every(isJsonValue) ||
    typeof raw.verifyOnComplete !== 'boolean'
  ) {
    throw new Error(`Run context snapshot is corrupt: ${slug}/${runId}`);
  }
  return {
    params: raw.params,
    verifyOnComplete: raw.verifyOnComplete,
  };
}

/**
 * Snapshot the spec a run executed against, so the Results view can label nodes by the titles
 * that were live *at run time* — not the current task.yaml, which may have been edited since
 * (renaming/removing nodes would otherwise mislabel or drop historical outputs).
 */
export function writeRunSpecSnapshot(workspaceRoot: string, slug: string, runId: string, spec: TaskSpec): void {
  const parsed = TaskSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error(`Refusing to snapshot invalid task spec: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const dir = runDir(workspaceRoot, slug, runId);
  ensureDir(dir);
  const path = join(dir, RUN_SPEC);
  const serialized = JSON.stringify(parsed.data, null, 2);
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
    const existing = readRunSpecSnapshot(workspaceRoot, slug, runId);
    if (existing !== null && JSON.stringify(existing) === JSON.stringify(parsed.data)) return;
    throw new Error(`Run spec snapshot is immutable: ${slug}/${runId}`);
  }
  try {
    writeSync(fd, serialized, undefined, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read a run's spec snapshot. Returns null for older runs written before snapshots existed. */
export function readRunSpecSnapshot(workspaceRoot: string, slug: string, runId: string): TaskSpec | null {
  const path = join(runDir(workspaceRoot, slug, runId), RUN_SPEC);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Run spec snapshot is corrupt: ${slug}/${runId}`, { cause: error });
  }
  const parsed = TaskSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Run spec snapshot is corrupt: ${slug}/${runId}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}

/**
 * Persist resolved run parameters and verification behavior. Parameters must
 * be JSON-safe because recovery has to reproduce their exact prompt inputs.
 */
export function writeRunContextSnapshot(
  workspaceRoot: string,
  slug: string,
  runId: string,
  context: RunContextSnapshot,
): void {
  const parsed = parseRunContext(context, slug, runId);
  const dir = runDir(workspaceRoot, slug, runId);
  ensureDir(dir);
  const path = join(dir, RUN_CONTEXT);
  const serialized = JSON.stringify(parsed, null, 2);
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
    const existing = readRunContextSnapshot(workspaceRoot, slug, runId);
    if (existing !== null && JSON.stringify(existing) === JSON.stringify(parsed)) return;
    throw new Error(`Run context snapshot is immutable: ${slug}/${runId}`);
  }
  try {
    writeSync(fd, serialized, undefined, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read the immutable run context. Returns null for pre-context runs. */
export function readRunContextSnapshot(
  workspaceRoot: string,
  slug: string,
  runId: string,
): RunContextSnapshot | null {
  const path = join(runDir(workspaceRoot, slug, runId), RUN_CONTEXT);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Run context snapshot is corrupt: ${slug}/${runId}`, { cause: error });
  }
  return parseRunContext(raw, slug, runId);
}

// ---------------------------------------------------------------------------
// Per-node output
// ---------------------------------------------------------------------------

export function writeNodeOutput(
  workspaceRoot: string,
  slug: string,
  runId: string,
  nodeId: string,
  output: NodeOutput,
): void {
  const dir = join(runDir(workspaceRoot, slug, runId), NODES_DIR);
  ensureDir(dir);
  atomicWriteFileSync(join(dir, `${nodeId}.json`), JSON.stringify(output, null, 2));
}

export function readNodeOutput(
  workspaceRoot: string,
  slug: string,
  runId: string,
  nodeId: string,
): NodeOutput | null {
  const path = join(runDir(workspaceRoot, slug, runId), NODES_DIR, `${nodeId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as NodeOutput;
  } catch {
    return null;
  }
}
