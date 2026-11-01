import { completionCriterionPathKeys as pathKeys } from "@craft-agent/session-tools-core";
import type { ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";

/** Own JSON data properties only: getters and prototypes are never consulted. */
export function atPath(value: unknown, path: string): unknown {
  const keys = pathKeys(path);
  if (!keys) return undefined;
  for (const key of keys) {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}

const builtinToolNames = new Map([
  ['bash', 'bash'], ['read', 'read'], ['write', 'write'], ['edit', 'edit'],
  ['find', 'find'], ['glob', 'glob'], ['grep', 'grep'], ['ls', 'ls'],
  ['webfetch', 'web_fetch'], ['web_fetch', 'web_fetch'],
  ['websearch', 'web_search'], ['web_search', 'web_search'],
]);

/** Only aliases actually used for native tools; MCP source namespaces stay exact. */
export function canonicalToolName(name: string): string {
  const candidate = name.startsWith('functions.') ? name.slice('functions.'.length) : name;
  return builtinToolNames.get(candidate.toLowerCase()) ?? name;
}

const builtinToolEvidenceAliasGroups: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['Bash', 'bash', 'functions.bash']),
  new Set(['Read', 'read', 'functions.read']),
  new Set(['Write', 'write', 'functions.write']),
  new Set(['Edit', 'edit', 'functions.edit']),
  new Set(['Find', 'find', 'functions.find']),
  new Set(['Glob', 'glob', 'functions.glob']),
  new Set(['Grep', 'grep', 'functions.grep']),
  new Set(['Ls', 'ls', 'functions.ls']),
  new Set(['WebFetch', 'webfetch', 'web_fetch', 'functions.webfetch', 'functions.web_fetch']),
  new Set(['WebSearch', 'websearch', 'web_search', 'functions.websearch', 'functions.web_search']),
];

export function referencesToolAlias(evidence: readonly string[], observedToolName: string): boolean {
  const aliasGroup = builtinToolEvidenceAliasGroups.find(group => group.has(observedToolName));
  return evidence.some(ref => {
    if (!ref.startsWith('tool:') || ref.length <= 'tool:'.length) return false;
    const target = ref.slice('tool:'.length);
    return target === observedToolName || Boolean(aliasGroup?.has(target));
  });
}

// Only use high-confidence partition keys to prove that a mutation is about a
// different target. Generic fields such as `id`, `name`, `key` or `target`
// mean different things across tool schemas and therefore stay conservative.
const TARGET_IDENTITY_KEY_PATTERN = /^(?:account|database|file|file_path|filename|folder|host|job|project|projectId|resource|sessionId|threadId|timer|uri|url|workspace|workspaceId)$/i;

// Only opaque host-generated IDs can prove disjoint targets across two
// different tool schemas. Human-readable host/path/account/resource names can
// alias each other (case, DNS, symlink, redirect, connector-specific meaning).
export const DISTINCT_OPAQUE_TARGET_KEY_PATTERN = /^(?:projectId|sessionId|threadId|workspaceId)$/i;

function scalarIdentity(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 2_048) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  return undefined;
}

/** Read bounded own-data properties only; tool inputs are untrusted persisted data. */
export function inputTargetIdentities(input: Record<string, unknown> | undefined): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  let visited = 0;
  while (pending.length && visited++ < 128) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== 'object' || depth > 4) continue;
    for (const key of Object.keys(value).slice(0, 64)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const identity = scalarIdentity(descriptor.value);
      if (identity !== undefined && TARGET_IDENTITY_KEY_PATTERN.test(key)) {
        const values = targets.get(key.toLowerCase()) ?? new Set<string>();
        values.add(identity);
        targets.set(key.toLowerCase(), values);
      } else if (descriptor.value && typeof descriptor.value === 'object') {
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
    }
  }
  return targets;
}

export function criterionTargetIdentities(criterion: ObjectiveAcceptanceCriterion): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const path of Object.keys(criterion.input).slice(0, 16)) {
    const descriptor = Object.getOwnPropertyDescriptor(criterion.input, path);
    if (!descriptor || !('value' in descriptor)) continue;
    const keys = pathKeys(path) ?? [];
    const key = [...keys].reverse().find(candidate => (
      typeof candidate === 'string' && TARGET_IDENTITY_KEY_PATTERN.test(candidate)
    ));
    const identity = scalarIdentity(descriptor.value);
    if (key === undefined || identity === undefined) continue;
    const values = targets.get(key.toLowerCase()) ?? new Set<string>();
    values.add(identity);
    targets.set(key.toLowerCase(), values);
  }
  return targets;
}

export function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length <= 2048);
}

export function isCriterionInputScalar(toolName: string, path: string, value: unknown): boolean {
  if (isScalar(value)) return true;
  const keys = pathKeys(path);
  // Exact Gmail bodies use the same 4,000-character ceiling as the
  // authenticated objective parser. Keep the larger allowance confined to
  // this verifier field instead of broadening every persisted criterion.
  return canonicalToolName(toolName) === 'mcp__google-contacts__gmail_verify_sent_message'
    && keys?.length === 1 && keys[0] === 'expectedBody'
    && typeof value === 'string' && value.length <= 4000;
}

export function selectorIdentity(path: string): string {
  return path === '$text' ? '$text' : JSON.stringify(pathKeys(path));
}

/** Syntax/order changes must retain the exact target and every expected value. */
export function criterionIdentity(criterion: ObjectiveAcceptanceCriterion): string {
  const ordered = (entries: Array<[string, unknown]>) => entries
    .map(([path, value]) => [selectorIdentity(path), value])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  return JSON.stringify({
    id: criterion.id, supersedes: criterion.supersedes, requirementId: criterion.requirementId,
    description: criterion.description, toolName: canonicalToolName(criterion.toolName),
    input: ordered(Object.entries(criterion.input)),
    checks: ordered(criterion.checks.map(check => [check.path, check.equals])),
  });
}

/** A model-authored successor may version an existing check, never rewrite its
 * meaning after observing the result. Human amendments use the separate full
 * acceptance-revision path. */
export function criterionSupersessionIdentity(criterion: ObjectiveAcceptanceCriterion): string {
  const versioned = { ...criterion, id: 'versioned-criterion' };
  delete versioned.supersedes;
  return criterionIdentity(versioned);
}

export const TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR = 'Terminal reconciliation freezes the registered acceptance contract; set_completion_criteria may only repeat the complete existing criteria and procedure exactly';

export const TERMINAL_RECONCILIATION_INITIAL_EVIDENCE_ERROR = 'Terminal reconciliation may register only checks already satisfied by exact persisted read-only observations from this objective before the reconciliation marker';
