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
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "fs";
import { join } from "path";
import { atomicWriteFileSync } from "../../utils/files.ts";
import { TaskSpecSchema, type TaskSpec } from "../schema.ts";
import { SLUG_RE } from "../schema.ts";
import type { NodeOutput } from "../refs.ts";
import { errnoCode, isRecord } from './run-integrity.ts';
import { NODES_DIR } from './run-types.ts';
import { ensureDir, runDir } from './task-files.ts';

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
  if (!SLUG_RE.test(nodeId) && nodeId !== '__verdict__') throw new Error(`Invalid task node id "${nodeId}"`);
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
  if (!SLUG_RE.test(nodeId) && nodeId !== '__verdict__') throw new Error(`Invalid task node id "${nodeId}"`);
  const path = join(runDir(workspaceRoot, slug, runId), NODES_DIR, `${nodeId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as NodeOutput;
  } catch {
    return null;
  }
}
