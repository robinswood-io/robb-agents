import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { isProvablyReadOnlyShellCommand } from "@craft-agent/shared/agent";
import { isObjectiveToolExecutedSuccessfully } from "../objective-contract.ts";
import { atPath, canonicalToolName } from './criterion-identities.ts';

/** A single final LF/CRLF terminates text output; all other whitespace is data. */
export function withoutFinalLineTerminator(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** Pi appends pagination advice after a user-requested bounded Read. Compare
 * only the returned file lines when the exact native format, line count and
 * next offset all agree with the recorded invocation. A byte-truncated Read,
 * another tool, or an invented continuation notice is never projected. */
function matchesBoundedReadText(message: Message, expected: string): boolean {
  if (canonicalToolName(message.toolName ?? '') !== 'read'
    || message.toolExecuted !== true || !isObjectiveToolExecutedSuccessfully(message)
    || typeof message.toolInput?.path !== 'string' || !message.toolInput.path
    || typeof message.toolResult !== 'string') return false;
  const { offset, limit } = message.toolInput;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)
    || (offset as number) < 1 || (limit as number) < 1 || (limit as number) > 2_000
    || (offset as number) + (limit as number) > Number.MAX_SAFE_INTEGER) return false;
  const match = /^([\s\S]*)\n\n\[([1-9]\d{0,8}) more lines in file\. Use offset=([1-9]\d{0,8}) to continue\.\]$/
    .exec(message.toolResult);
  if (!match || Number(match[3]) !== (offset as number) + (limit as number)
    || match[1]!.split('\n').length !== limit) return false;
  return withoutFinalLineTerminator(match[1]!) === expected;
}

/** A registered text predicate may observe the stdout field of the trusted
 * SSH connector's successful read-only envelope or the exact bounded Read
 * payload. Preserve the persisted criterion and exact expected value; never
 * treat arbitrary JSON, stderr or an unsuccessful command as evidence. */
export function matchesAcceptanceResultCheck(
  message: Message,
  projection: unknown,
  check: { path: string; equals: unknown },
): boolean {
  if (check.path !== '$text') return atPath(projection, check.path) === check.equals;
  if (typeof check.equals !== 'string' || message.toolResult === undefined) return false;
  const expected = withoutFinalLineTerminator(check.equals);
  if (withoutFinalLineTerminator(message.toolResult) === expected) return true;
  if (matchesBoundedReadText(message, expected)) return true;
  if (message.toolName !== 'mcp__rbw-servers__ssh_execute'
    || message.toolExecuted !== true) return false;
  const command = message.toolInput?.command;
  if (typeof command !== 'string' || !isProvablyReadOnlyShellCommand(command)) return false;
  const stdout = atPath(projection, '$.stdout');
  return typeof stdout === 'string'
    && atPath(projection, '$.success') === true
    && atPath(projection, '$.code') === 0
    && atPath(projection, '$.stderr') === ''
    && withoutFinalLineTerminator(stdout) === expected;
}

/** Legacy objectives retain their conservative objective-wide registration boundary. */
export function criterionRegisteredAt(objective: ActiveSessionObjective, criterionId: string): number {
  const fallback = objective.acceptanceRegisteredAt ?? objective.startedAt;
  const entry = Object.getOwnPropertyDescriptor(objective.acceptanceRegisteredAtById ?? {}, criterionId);
  const value = entry && 'value' in entry ? entry.value : undefined;
  return typeof value === 'number' && Number.isFinite(value)
    && value >= objective.startedAt && value <= fallback ? value : fallback;
}
