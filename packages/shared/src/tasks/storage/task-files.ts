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
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteFileSync, stripBom } from "../../utils/files.ts";
import { validateTaskInput } from "../validate.ts";
import { TaskSpecSchema, type TaskSpec } from "../schema.ts";
import { SLUG_RE } from "../schema.ts";
import type { ValidationResult } from "../../config/validators.ts";
import { RUNS_DIR, TASKS_DIR, TASK_FILE } from './run-types.ts';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function tasksRoot(workspaceRoot: string): string {
  return join(workspaceRoot, TASKS_DIR);
}

export function taskDir(workspaceRoot: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid task slug "${slug}"`);
  return join(workspaceRoot, TASKS_DIR, slug);
}

export function taskYamlPath(workspaceRoot: string, slug: string): string {
  return join(taskDir(workspaceRoot, slug), TASK_FILE);
}

export function runDir(workspaceRoot: string, slug: string, runId: string): string {
  if (!SLUG_RE.test(runId)) throw new Error(`Invalid task run id "${runId}"`);
  return join(taskDir(workspaceRoot, slug), RUNS_DIR, runId);
}

export function ensureDir(dir: string): void {
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
    .filter((d) => d.isDirectory() && SLUG_RE.test(d.name) && existsSync(join(root, d.name, TASK_FILE)))
    .map((d) => d.name)
    .sort();
}

/** List task slugs that retain persisted runs, even if task.yaml was deleted. */
export function listTaskRunSlugs(workspaceRoot: string): string[] {
  const root = tasksRoot(workspaceRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SLUG_RE.test(d.name) && existsSync(join(root, d.name, RUNS_DIR)))
    .map((d) => d.name)
    .sort();
}
