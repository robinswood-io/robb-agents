import { hasShellOutputRedirection } from "@craft-agent/shared/agent/bash-validator";
import { createHash } from "node:crypto";
import type { Message } from "@craft-agent/core/types";
import { classifyToolNameMutationSemantics, isProvablyReadOnlyShellCommand, normalizeToolLeafName } from "@craft-agent/shared/agent";
import { GENERIC_EXECUTE_TOOL_PATTERN, MAX_CANONICAL_INPUT_CHARS, MAX_RESULT_DIGEST_CHARS, MAX_TRANSFORM_DIGEST_CHARS, MUTATION_SQL_PATTERN, MUTATION_TRANSFORM_KEY_PATTERN, NON_EXECUTED_CHECKPOINT_PATTERN, NON_SUBSTANTIVE_TOOL_RESULT_PATTERN, OBJECTIVE_NON_EXECUTING_PREFLIGHT_TOOLS, OBSERVATION_TARGET_KEY_PATTERN, PASSIVE_NO_PROGRESS_ACTION_PATTERN, PASSIVE_NO_PROGRESS_TOOL_PATTERN, PLAN_TRACKING_TOOL_PATTERN, POSITIVE_HTTP_POST_TARGET_TOKENS, POSITIVE_MUTATION_HTTP_METHOD_PATTERN, SESSION_COORDINATION_TOOL_PATTERN } from './intent-vocabulary.ts';
import { MUTATION_BASH_PATTERN } from './mutation-vocabulary.ts';

function stableValue(value: unknown, depth = 0): unknown {
  if (depth >= 5) return '[depth-limit]';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, 2_048);
  if (Array.isArray(value)) return value.slice(0, 64).map((child: unknown) => stableValue(child, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 64)
      .map(([key, child]) => [key, stableValue(child, depth + 1)]),
  );
}

export function normalizedToolTarget(input: Record<string, unknown> | undefined): string {
  if (!input) return '{}';
  const targetEntries = Object.entries(input)
    .filter(([key]) => OBSERVATION_TARGET_KEY_PATTERN.test(key));
  const source = targetEntries.length > 0 ? Object.fromEntries(targetEntries) : input;
  try {
    return JSON.stringify(stableValue(source)).slice(0, MAX_CANONICAL_INPUT_CHARS);
  } catch {
    return '[unserializable-input]';
  }
}

export function resultDigest(message: Message): string {
  const raw = message.toolResult ?? message.content ?? '';
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  const bounded = normalized.length <= MAX_RESULT_DIGEST_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_RESULT_DIGEST_CHARS / 2)}\n[...bounded...]\n${normalized.slice(-MAX_RESULT_DIGEST_CHARS / 2)}`;
  return createHash('sha256').update(bounded).digest('hex').slice(0, 16);
}

export function mutationTransformDigest(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const transformEntries = Object.entries(input)
    .filter(([key]) => MUTATION_TRANSFORM_KEY_PATTERN.test(key));
  if (transformEntries.length === 0) return undefined;
  let canonical: string;
  try {
    canonical = JSON.stringify(stableValue(Object.fromEntries(transformEntries)));
  } catch {
    canonical = '[unserializable-transform]';
  }
  const bounded = canonical.length <= MAX_TRANSFORM_DIGEST_CHARS
    ? canonical
    : `${canonical.slice(0, MAX_TRANSFORM_DIGEST_CHARS / 2)}[...bounded...]${canonical.slice(-MAX_TRANSFORM_DIGEST_CHARS / 2)}`;
  return createHash('sha256').update(bounded).digest('hex').slice(0, 16);
}

export function isPassiveNoProgressTool(message: Message): boolean {
  const toolName = message.toolName ?? '';
  if (PASSIVE_NO_PROGRESS_TOOL_PATTERN.test(toolName)) return true;
  if (/^(?:write_stdin|read_thread_terminal)$/i.test(toolName)) {
    const chars = message.toolInput?.["chars"];
    if (chars === undefined || chars === '') return true;
  }
  const action = [message.toolInput?.["action"], message.toolInput?.["command"], message.toolInput?.["operation"]]
    .find((value): value is string => typeof value === 'string');
  return action ? PASSIVE_NO_PROGRESS_ACTION_PATTERN.test(action.trim()) : false;
}

export function isObjectiveToolExecutedSuccessfully(message: Message): boolean {
  if (message.role !== 'tool' || message.toolStatus !== 'completed' || message.isError) return false;
  const runtimeMessage = message as Message & {
    continuationRequired?: boolean;
    toolExecutionStatus?: 'executed' | 'not-executed' | string;
  };
  if (
    message.toolExecuted === false
    || message.toolCheckpoint !== undefined
    || runtimeMessage.continuationRequired
    || runtimeMessage.toolExecutionStatus === 'not-executed'
  ) return false;
  const output = message.toolResult ?? message.content ?? '';
  return !NON_EXECUTED_CHECKPOINT_PATTERN.test(output);
}

/** Session transport tools cannot stand in for evidence about the user target. */
export function isObjectiveCoordinationTool(message: Message): boolean {
  return SESSION_COORDINATION_TOOL_PATTERN.test(message.toolName ?? '')
    || PLAN_TRACKING_TOOL_PATTERN.test(message.toolName ?? '');
}

/** True only for a real completed invocation whose persisted result can serve as evidence. */
export function hasObjectiveSubstantiveToolResult(message: Message): boolean {
  if (!isObjectiveToolExecutedSuccessfully(message)
    || isObjectiveCoordinationTool(message)) return false;
  // `content` is only a UI label. Safety-net completion can mark a child tool
  // completed without ever receiving a genuine tool_result, leaving this empty.
  const result = message.toolResult?.trim();
  return !!result && !NON_SUBSTANTIVE_TOOL_RESULT_PATTERN.test(result);
}

function positiveHttpPostTargetMutation(input: Record<string, unknown>): boolean {
  const target = [input["path"], input["url"], input["uri"], input["endpoint"], input["route"]]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!target) return false;
  let pathname = target.trim().split(/[?#]/, 1)[0] ?? '';
  try {
    pathname = new URL(target).pathname;
  } catch {
    // Relative connector paths are the common case.
  }
  const tokens = normalizeToolLeafName(pathname).split('_').filter(Boolean);
  return tokens.some(token => POSITIVE_HTTP_POST_TARGET_TOKENS.has(token));
}

/** High-confidence mutation evidence, not the broader conservative invalidation boundary. */
export function isObjectiveMutationTool(message: Message): boolean {
  const toolName = message.toolName ?? '';
  if (PLAN_TRACKING_TOOL_PATTERN.test(toolName)
    || /^(?:mcp__session__|session__)?(?:set_completion_criteria|project_learning)$/.test(toolName)
    || OBJECTIVE_NON_EXECUTING_PREFLIGHT_TOOLS.has(toolName)) return false;
  const input = message.toolInput ?? {};
  // Structured connector semantics are authoritative even when the connector
  // name itself is neutral (for example graph_request with method: POST).
  // Inspect only the bounded action/method fields here: arbitrary query and
  // command payloads remain meaningful solely for generic executors below.
  const action = [input["action"], input["operation"]]
    .find((value): value is string => typeof value === 'string');
  if (action && classifyToolNameMutationSemantics(action.trim()) === 'mutation') return true;
  const method = input["method"];
  if (typeof method === 'string') {
    const normalizedMethod = method.trim();
    if (POSITIVE_MUTATION_HTTP_METHOD_PATTERN.test(normalizedMethod)) return true;
    if (/^POST$/i.test(normalizedMethod) && positiveHttpPostTargetMutation(input)) return true;
  }
  const usesInputSemantics = GENERIC_EXECUTE_TOOL_PATTERN.test(toolName)
    || /^(?:functions\.)?(?:Bash|Shell)$/i.test(toolName);
  if (!usesInputSemantics) {
    return classifyToolNameMutationSemantics(toolName) === 'mutation';
  }
  const query = [input["query"], input["sql"], input["statement"]]
    .find((value): value is string => typeof value === 'string');
  if (query && MUTATION_SQL_PATTERN.test(query)) return true;
  const command = [message.toolInput?.["command"], message.toolInput?.["cmd"], message.toolInput?.["script"]]
    .find((value): value is string => typeof value === 'string') ?? '';
  // The AST-backed read-only classifier also recognizes non-editing forms of
  // commands such as `sed -n`; the mutation regex alone flags their name.
  if (command && isProvablyReadOnlyShellCommand(command)) return false;
  return MUTATION_BASH_PATTERN.test(command) || hasShellOutputRedirection(command);
}
