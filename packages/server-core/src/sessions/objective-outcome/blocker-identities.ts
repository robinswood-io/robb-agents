import type { Message } from "@craft-agent/core/types";
import { classifyAgentFailure } from "@craft-agent/shared/agent";
import type { ObjectiveBlockerKind } from './declaration.ts';
import { BUILTIN_BASH_EVIDENCE_ALIASES, BUILTIN_BASH_TOOL_NAMES } from './declaration.ts';

export interface ToolAliasCandidateGroup {
  aliases: readonly string[];
  messageIndexes: Set<number>;
}

const ROOT_TOOL_REQUEST_UI_METADATA = new Set(['_intent', '_displayName']);

export interface CurrentObjectiveBlockerObservation {
  kind: ObjectiveBlockerKind;
  message: Message;
  messageIndex: number;
}

export function toolAliasDescriptor(toolName: string): { key: string; aliases: readonly string[] } {
  return BUILTIN_BASH_TOOL_NAMES.has(toolName)
    ? { key: 'native:bash', aliases: BUILTIN_BASH_EVIDENCE_ALIASES }
    : { key: `exact:${toolName}`, aliases: [`tool:${toolName}`] };
}

/**
 * Stable bounded projection of persisted JSON data. If a request cannot be
 * compared exactly, keep the earlier blocker rather than guessing that an
 * unrelated success resolved it.
 */
function stableRequestValue(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.length <= 4_096 ? JSON.stringify(value) : undefined;
  if (value === null || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    if (value.length > 128) return undefined;
    const items = value.map((item: unknown) => stableRequestValue(item, depth + 1));
    return items.every((item): item is string => item !== undefined) ? `[${items.join(',')}]` : undefined;
  }
  // These two root fields are renderer annotations injected around the real
  // tool request. They may legitimately change between retries and are not
  // part of target identity. Nested fields with the same names remain real
  // arguments and must still compare exactly.
  const keys = Object.keys(value)
    .filter(key => depth > 0 || !ROOT_TOOL_REQUEST_UI_METADATA.has(key))
    .sort();
  if (keys.length > 128) return undefined;
  const fields: string[] = [];
  for (const key of keys) {
    if (key.length > 256) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    const projected = stableRequestValue(descriptor.value, depth + 1);
    if (projected === undefined) return undefined;
    fields.push(`${JSON.stringify(key)}:${projected}`);
  }
  return `{${fields.join(',')}}`;
}

export function sameToolRequest(left: Message, right: Message): boolean {
  if (!left.toolName || !right.toolName
    || toolAliasDescriptor(left.toolName).key !== toolAliasDescriptor(right.toolName).key) return false;
  const leftRequest = stableRequestValue(left.toolInput ?? {});
  const rightRequest = stableRequestValue(right.toolInput ?? {});
  return leftRequest !== undefined && leftRequest === rightRequest;
}

export function blockerKindsForFailureSignal(message: Message, signal = message.toolResult ?? message.content,
  code?: string): ObjectiveBlockerKind[] {
  const normalizedSignal = signal.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const failure = classifyAgentFailure({
    message: signal,
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(code !== undefined ? { code: code } : {}),
  });
  if (failure.failureClass === 'interactive-auth-required') {
    if (/\b(?:mfa|2fa|two[- ]factor|deux\s+facteurs)\b/i.test(normalizedSignal)) return ['mfa'];
    if (/authorization_pending|consent|device[-_ ]code|autorisation/.test(normalizedSignal)) {
      return ['external_authorization'];
    }
    return ['credential'];
  }
  if (failure.failureClass === 'credential-required') return ['credential'];
  if (failure.failureClass === 'permission-denied') return ['external_authorization', 'irreversible_authority'];
  if (failure.failureClass === 'sandbox-denied') return ['policy'];
  return [];
}

export function failureBlockerKinds(message: Message): ObjectiveBlockerKind[] {
  return blockerKindsForFailureSignal(message);
}
