import { isJsonObject } from '@craft-agent/shared/utils/json';
import type { Message, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { classifyToolNameMutationSemantics } from "@craft-agent/shared/agent";
import { inspectReadOnlyReviewCommand } from "@craft-agent/shared/agent/bash-validator";
import { completionCriterionPathKeys } from "@craft-agent/session-tools-core";
import { posix } from "node:path";
import { hasObjectiveSubstantiveToolResult, isObjectiveCoordinationTool, isObjectiveEvidenceInvalidatingMutation, isObjectiveToolExecutedSuccessfully } from "../objective-contract.ts";
import type { DelegatedReviewRequest } from './host-scope.ts';
import { COORDINATION, LOCAL_REVIEW_READ_TOOLS, LOCAL_REVIEW_SHELL_TOOLS, isHostReviewTargetCheckTool } from './host-scope.ts';

export function shellCommand(message: Message): string | undefined {
  return [message.toolInput?.["command"], message.toolInput?.["cmd"], message.toolInput?.["script"]].find((value): value is string => typeof value === 'string');
}

export function isShellTool(message: Message): boolean {
  return /(?:^|[_:.])(?:bash|shell|exec_command|ssh_execute|run_command)(?:$|[_:.])/i.test(message.toolName ?? '');
}

export function reviewCommand(message: Message, request: DelegatedReviewRequest) {
  const command = shellCommand(message);
  if (command === undefined || !request.target
    || (!request.remote && !LOCAL_REVIEW_SHELL_TOOLS.has(message.toolName ?? ''))
    || (request.remote && (
    message.toolName !== `mcp__${request.remote.source}__ssh_execute`
    || message.toolInput?.["server"] !== request.remote.server
    || message.toolInput?.["cwd"] !== request.target
    || message.toolInput?.["command"] !== command
  ))) return { safe: false, observesTarget: false, revisionProbe: false };
  return inspectReadOnlyReviewCommand(command, request.target,
    typeof message.toolInput?.["cwd"] === 'string' ? message.toolInput["cwd"] : undefined);
}

export function observationalTool(message: Message, request: DelegatedReviewRequest): boolean {
  if (!hasObjectiveSubstantiveToolResult(message) || COORDINATION.test(message.toolName ?? '') || isObjectiveCoordinationTool(message)
    || isObjectiveEvidenceInvalidatingMutation(message)
    || classifyToolNameMutationSemantics(message.toolName ?? '') === 'ambiguous-compound') return false;
  const command = shellCommand(message);
  if (command !== undefined) return reviewCommand(message, request).observesTarget;
  if (request.remote) return false;
  const { target } = request;
  if (!target) return false;
  if (!LOCAL_REVIEW_READ_TOOLS.has(message.toolName ?? '')) return false;
  return ['file_path', 'path', 'url', 'uri'].some(key => {
    const value = message.toolInput?.[key];
    if (typeof value !== 'string') return false;
    if (target.startsWith('/')) return value.startsWith('/') && (posix.normalize(value) === posix.normalize(target)
      || posix.normalize(value).startsWith(`${posix.normalize(target)}/`));
    try {
      const actual = new URL(value); const expected = new URL(target);
      return actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search;
    } catch { return false; }
  });
}

export function observedRevision(message: Message, request: DelegatedReviewRequest): string | undefined {
  const command = shellCommand(message);
  if (!command || !reviewCommand(message, request).revisionProbe) return undefined;
  let text = message.toolResult ?? '';
  try {
    const envelope: unknown = JSON.parse(text);
    // The command's stdout only; echoed input/stderr/envelope metadata cannot
    // supply a requested commit that HEAD did not actually return.
    if (!isJsonObject(envelope) || typeof envelope['stdout'] !== 'string') return undefined;
    text = envelope['stdout'];
  } catch { /* Native Bash returns plain stdout. */ }
  const hashes = [...new Set(text.split(/\r?\n/).filter(line => /^[a-f0-9]{7,40}$/i.test(line)).map(line => line.toLowerCase()))];
  return hashes.length === 1 ? hashes[0] : undefined;
}

const BUILTIN_TOOL_NAMES = new Map([
  ['bash', 'bash'], ['read', 'read'], ['write', 'write'], ['edit', 'edit'],
  ['find', 'find'], ['glob', 'glob'], ['grep', 'grep'], ['ls', 'ls'],
  ['webfetch', 'web_fetch'], ['web_fetch', 'web_fetch'],
  ['websearch', 'web_search'], ['web_search', 'web_search'],
]);

function canonicalToolName(name: string): string {
  const candidate = name.startsWith('functions.') ? name.slice('functions.'.length) : name;
  return BUILTIN_TOOL_NAMES.get(candidate.toLowerCase()) ?? name;
}

function atPath(value: unknown, path: string): unknown {
  const keys = completionCriterionPathKeys(path);
  if (!keys) return undefined;
  for (const key of keys) {
    // Criterion selectors support non-negative array indexes. Keep this
    // traversal identical to the primary acceptance evaluator: arrays are JSON
    // containers too, and Object.getOwnPropertyDescriptor safely reads their
    // own indexed properties without consulting prototypes or getters.
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}

export function criterionInvocationMatches(criterion: ObjectiveAcceptanceCriterion, message: Message): boolean {
  return !!message.toolName && canonicalToolName(message.toolName) === canonicalToolName(criterion.toolName)
    && Object.entries(criterion.input).every(([path, expected]) => atPath(message.toolInput, path) === expected);
}

/**
 * An exact shell invocation is still opaque executable code. It becomes a
 * review observation only when the registered check binds an absolute cwd (or,
 * for local Bash where the tool schema has no cwd field, explicit absolute
 * target paths) and the closed reviewer grammar proves the command read-only.
 */
export function isBoundReadOnlyHostTargetCheck(criterion: ObjectiveAcceptanceCriterion, message: Message): boolean {
  if (!criterionInvocationMatches(criterion, message)
    || classifyToolNameMutationSemantics(message.toolName ?? '') === 'ambiguous-compound') return false;
  if (!isShellTool(message)) {
    if (!isHostReviewTargetCheckTool(criterion.toolName, criterion.input, undefined, true)) return false;
    return !isObjectiveEvidenceInvalidatingMutation(message);
  }
  if (!LOCAL_REVIEW_SHELL_TOOLS.has(message.toolName ?? '')
    && message.toolName !== 'mcp__rbw-servers__ssh_execute') return false;
  const command = shellCommand(message);
  if (!command) return false;
  const cwdBinding = Object.entries(criterion.input).find(([path]) => {
    const keys = completionCriterionPathKeys(path);
    return keys?.length === 1 && keys[0] === 'cwd';
  })?.[1];
  if (cwdBinding === undefined) {
    if (!LOCAL_REVIEW_SHELL_TOOLS.has(message.toolName ?? '')
      || message.toolInput?.["cwd"] !== undefined) return false;
    const inspection = inspectReadOnlyReviewCommand(command, '/');
    return inspection.safe && inspection.observesTarget;
  }
  if (typeof cwdBinding !== 'string' || !cwdBinding.startsWith('/')
    || message.toolInput?.["cwd"] !== cwdBinding) return false;
  const inspection = inspectReadOnlyReviewCommand(command, cwdBinding, cwdBinding);
  return inspection.safe && inspection.observesTarget;
}

/** Persisted MCP attempts can say toolExecuted=true although policy rejected them before execution. */
export function isExplicitHostPolicyRefusal(message: Message): boolean {
  if (message.toolStatus !== 'error' || !message.isError || isObjectiveToolExecutedSuccessfully(message)) return false;
  const result = message.toolResult ?? '';
  return /(?:MCP write operations are blocked in Explore|blocked \(Explore mode\)|operation denied by policy|high-stakes evidence gate)/i.test(result)
    || /(?:Bash command blocked:|is not in the read-only allowlist|not allowed in Explore mode|blocked in Explore mode)[\s\S]{0,2048}Effective mode:\s*Explore/i.test(result);
}
