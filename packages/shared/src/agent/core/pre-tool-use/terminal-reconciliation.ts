import { isUnknownArray } from '../../../utils/json.ts';
import { isBrowserToolNameOrAlias } from "../../browser-tool-names.ts";
import { createHmac } from "node:crypto";
import type { TerminalReconciliationPolicy } from "../../backend/types.ts";
import type { ToolEffectDescriptor } from './contracts.ts';

/**
 * Canonicalize only inert JSON data. Accessors, exotic prototypes, sparse
 * arrays, symbols, cycles and non-JSON scalars are rejected rather than read.
 * This is an exact capability key: case, whitespace, omitted/default fields
 * and array order remain significant.
 */
export function canonicalTerminalReconciliationToolInput(value: unknown): string | undefined {
  let nodes = 0;
  const seen = new Set<object>();
  const encode = (item: unknown, depth: number): string | undefined => {
    if (++nodes > 4_096 || depth > 64) return undefined;
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : undefined;
    if (typeof item !== 'object' || seen.has(item)) return undefined;
    seen.add(item);
    try {
      if (isUnknownArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) return undefined;
        const own = Reflect.ownKeys(item);
        if (own.some(key => typeof key !== 'string'
          || key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key))) return undefined;
        const values: string[] = [];
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
          const encoded = encode(descriptor.value, depth + 1);
          if (encoded === undefined) return undefined;
          values.push(encoded);
        }
        return `[${values.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const record = item as Record<string, unknown>;
      const keys = Reflect.ownKeys(record);
      if (keys.some(key => typeof key !== 'string')) return undefined;
      // These two root fields are display metadata stripped by the normal
      // tool pipeline and never reach the operation. Ignore them on both the
      // persisted and replay side; every operational field stays exact.
      for (const key of keys as string[]) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      }
      const ordered = (keys as string[])
        .filter(key => depth !== 0 || key !== '_intent' && key !== '_displayName')
        .sort((left, right) => left.localeCompare(right));
      const entries: string[] = [];
      for (const key of ordered) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !('value' in descriptor)) return undefined;
        const encoded = encode(descriptor.value, depth + 1);
        if (encoded === undefined) return undefined;
        entries.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      seen.delete(item);
    }
  };
  const encoded = encode(value, 0);
  return encoded !== undefined && encoded.length <= 65_536 ? encoded : undefined;
}

/** Reserved transport field injected only after the terminal allowlist passes. */
export const TERMINAL_RECONCILIATION_CAPABILITY_FIELD = '_hostTerminalReconciliationCapability';

export function terminalReconciliationCoordinationTool(toolName: string): boolean {
  return /^(?:mcp__session__|session__)?(?:set_completion_criteria|spawn_session|wait_sessions)$/u.test(toolName);
}

/**
 * Bind the host-only policy key to one exact executable coordination input.
 * The handler receives only this digest, never the key, so a capability for
 * objective A or payload A cannot be retargeted to objective/payload B.
 */
export function deriveTerminalReconciliationInvocationCapability(
  capabilityKey: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!capabilityKey || !terminalReconciliationCoordinationTool(toolName)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, TERMINAL_RECONCILIATION_CAPABILITY_FIELD);
  if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) return undefined;
  const operationalInput = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') return undefined;
    if (key === TERMINAL_RECONCILIATION_CAPABILITY_FIELD) continue;
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field || !field.enumerable || !('value' in field)) return undefined;
    operationalInput[key] = field.value;
  }
  const inputJson = canonicalTerminalReconciliationToolInput(operationalInput);
  if (inputJson === undefined) return undefined;
  return createHmac('sha256', capabilityKey)
    .update('\0', 'utf8')
    .update(toolName, 'utf8')
    .update('\0', 'utf8')
    .update(inputJson, 'utf8')
    .digest('base64url');
}

export function terminalReconciliationToolAllowed(
  policy: TerminalReconciliationPolicy,
  toolName: string,
  input: Record<string, unknown>,
  toolEffect: ToolEffectDescriptor,
): boolean {
  // The model can never present a host capability. Only this pipeline adds it
  // after all policy, source, prerequisite and input-transform checks pass.
  if (Object.prototype.hasOwnProperty.call(input, TERMINAL_RECONCILIATION_CAPABILITY_FIELD)) return false;
  // Browser state is live and cannot be an immutable evidence replay. This
  // remains forbidden even when an external Playwright/Puppeteer source calls
  // the operation trusted, read-only and idempotent, or the exact invocation
  // appears in the persisted replay list.
  if (isBrowserToolNameOrAlias(toolName)) return false;
  const inertUiMetadata = (key: string): boolean => {
    if (key !== '_intent' && key !== '_displayName') return false;
    const value = input[key];
    return typeof value === 'string' && value.length <= 4_096;
  };
  if (/^(?:mcp__session__|session__)?set_completion_criteria$/u.test(toolName)) {
    return policy.allowInitialCriteriaRegistration
      && canonicalTerminalReconciliationToolInput(input) !== undefined
      && Object.keys(input).every(key => (
        key === 'criteria' || key === 'procedure' || inertUiMetadata(key)
      ));
  }
  if (/^(?:mcp__session__|session__)?spawn_session$/u.test(toolName)) {
    return policy.allowReviewerSpawn && input["role"] === 'reviewer'
      && typeof input["prompt"] === 'string' && input["prompt"].trim().length > 0
      && (input["permissionMode"] === undefined || input["permissionMode"] === 'safe')
      && Object.keys(input).every(key => (
        key === 'prompt' || key === 'name' || key === 'role' || key === 'permissionMode'
        || inertUiMetadata(key)
      ));
  }
  if (/^(?:mcp__session__|session__)?wait_sessions$/u.test(toolName)) {
    const sessionIds = input["sessionIds"];
    if (canonicalTerminalReconciliationToolInput(input) === undefined
      || !isUnknownArray(sessionIds)
      || sessionIds.length < 1 || sessionIds.length > 8
      || new Set(sessionIds).size !== sessionIds.length
      || sessionIds.some((id: unknown) => typeof id !== 'string'
        || !policy.waitReviewerSessionIds.includes(id))) return false;
    if (input["afterCursors"] !== undefined) {
      if (!input["afterCursors"] || typeof input["afterCursors"] !== 'object'
        || isUnknownArray(input["afterCursors"])
        || Object.keys(input["afterCursors"]).some((id) => !sessionIds.includes(id))) return false;
    }
    if (input["mode"] !== undefined && input["mode"] !== 'first' && input["mode"] !== 'all') return false;
    return Object.keys(input).every(key => (
      key === 'sessionIds' || key === 'timeoutMs' || key === 'afterCursors' || key === 'mode'
      || inertUiMetadata(key)
    ));
  }
  if (toolEffect.kind !== 'read') return false;
  const toolInputJson = canonicalTerminalReconciliationToolInput(input);
  return toolInputJson !== undefined && policy.readReplays.some(replay => (
    replay.toolName === toolName && replay.toolInputJson === toolInputJson
  ));
}
