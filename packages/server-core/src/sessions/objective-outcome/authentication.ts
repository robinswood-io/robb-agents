import type { Message } from "@craft-agent/core/types";
import { isObjectiveToolExecutedSuccessfully } from "../objective-contract.ts";
import { AUTHENTICATION_PENDING_STATES, AUTHENTICATION_SUCCESS_STATES, KNOWN_AUTHENTICATION_HOSTS, MAX_AUTHENTICATION_RECEIPT_CHARS, MAX_AUTHORIZATION_RECEIPT_TTL_MS } from './declaration.ts';

/**
 * A successful structured negative is authoritative only when it comes from a
 * connector operation whose exact name describes an interactive auth receipt.
 * Generic shell/read tools can print attacker-controlled JSON and session MCP
 * tools are orchestration surfaces, not external authorization authorities.
 */
export function isStructuredAuthenticationReceiptTool(toolName?: string): boolean {
  const canonical = (toolName ?? '').replace(/^functions\./i, '');
  const match = /^mcp__(?!session__)[a-z0-9][a-z0-9_-]{0,127}__([a-z0-9][a-z0-9_-]{0,127})$/i.exec(canonical);
  if (!match) return false;
  const operation = match[1]!;
  const authSubject = /(?:^|_)(?:auth(?:entication|orization)?|oauth|device(?:_code)?|consent)(?:_|$)/i.test(operation);
  const receiptAction = /(?:^|_)(?:poll|status|check|wait|receipt|start|begin|request|connect|login|authorize|consent)(?:_|$)/i.test(operation);
  return authSubject && receiptAction;
}

interface StructuredAuthenticationToolName {
  connector: string;
  operation: string;
}

interface StructuredAuthenticationPollBinding {
  pollToolName: StructuredAuthenticationToolName;
  correlations: AuthCorrelations;
}

interface StructuredAuthenticationStartReceipt extends StructuredAuthenticationPollBinding {
  expiresAtMs: number;
}

type AuthCorrelationKind = 'id' | 'request' | 'connection';

type AuthCorrelations = Record<AuthCorrelationKind, Map<string, string>>;

export function structuredAuthenticationToolName(toolName?: string): StructuredAuthenticationToolName | undefined {
  const canonical = (toolName ?? '').replace(/^functions\./i, '');
  const match = /^mcp__(?!session__)([a-z0-9][a-z0-9_-]{0,127})__([a-z0-9][a-z0-9_-]{0,127})$/i.exec(canonical);
  return match ? { connector: match[1]!.toLowerCase(), operation: match[2]!.toLowerCase() } : undefined;
}

function boundedStringField(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function authCorrelationDescriptor(key: string): { kind: AuthCorrelationKind; key: string } | undefined {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (normalized === 'id' || /^(?:auth|authorization|oauth)_id$/.test(normalized)) {
    return { kind: 'id', key: 'id' };
  }
  if (normalized === 'request' || /^(?:(?:auth|authorization|oauth)_)?request_id$/.test(normalized)) {
    return { kind: 'request', key: 'request_id' };
  }
  // A device code may coexist with a provider request ID and legitimately
  // carry a different value. Keep it in the request domain for cross-domain
  // isolation, but do not collapse these two distinct protocol identifiers.
  if (normalized === 'device_code') return { kind: 'request', key: 'device_code' };
  if (normalized === 'connection' || /^(?:(?:connector|oauth)_)?connection_id$/.test(normalized)) {
    return { kind: 'connection', key: 'connection_id' };
  }
  return undefined;
}

function authCorrelationValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0 && value.length <= 512) return JSON.stringify(value);
  return typeof value === 'number' && Number.isFinite(value) ? JSON.stringify(value) : undefined;
}

function setAuthCorrelation(
  correlations: AuthCorrelations, kind: AuthCorrelationKind, key: string, value: string,
): boolean {
  const previous = correlations[kind].get(key);
  if (previous !== undefined && previous !== value) return false;
  correlations[kind].set(key, value);
  return true;
}

function authCorrelations(value: Record<string, unknown>, authRequestId?: string): AuthCorrelations | undefined {
  const correlations: AuthCorrelations = {
    id: new Map(), request: new Map(), connection: new Map(),
  };
  for (const [key, candidate] of Object.entries(value)) {
    const descriptor = authCorrelationDescriptor(key);
    if (!descriptor) continue;
    const projected = authCorrelationValue(candidate);
    if (projected === undefined
      || !setAuthCorrelation(correlations, descriptor.kind, descriptor.key, projected)) return undefined;
  }
  if (authRequestId
    && !setAuthCorrelation(correlations, 'request', 'request_id', JSON.stringify(authRequestId))) {
    return undefined;
  }
  return correlations;
}

function mergeAuthCorrelations(left: AuthCorrelations, right: AuthCorrelations): AuthCorrelations | undefined {
  const merged: AuthCorrelations = {
    id: new Map(left.id), request: new Map(left.request), connection: new Map(left.connection),
  };
  for (const kind of ['id', 'request', 'connection'] as const) {
    for (const [key, value] of right[kind]) {
      if (!setAuthCorrelation(merged, kind, key, value)) return undefined;
    }
  }
  return merged;
}

function hasAuthCorrelation(correlations: AuthCorrelations): boolean {
  return correlations.id.size > 0 || correlations.request.size > 0 || correlations.connection.size > 0;
}

/** Match the strongest identity domain emitted by the auth operation. A
 * shared connection is insufficient once the receipt exposes a request,
 * device-code or auth ID; every supplied comparable value must also agree. */
function matchingAuthCorrelations(expected: AuthCorrelations, candidate: AuthCorrelations): boolean {
  const requiresSpecificIdentity = expected.id.size > 0 || expected.request.size > 0;
  let matchedRequiredDomain = false;
  for (const kind of ['id', 'request', 'connection'] as const) {
    for (const [key, candidateValue] of candidate[kind]) {
      const expectedValue = expected[kind].get(key);
      if (expectedValue === undefined) continue;
      if (candidateValue !== expectedValue) return false;
      if (requiresSpecificIdentity ? kind !== 'connection' : kind === 'connection') {
        matchedRequiredDomain = true;
      }
    }
  }
  return matchedRequiredDomain;
}

export function structuredAuthenticationStartReceipt(message: Message): StructuredAuthenticationStartReceipt | undefined {
  if (!isObjectiveToolExecutedSuccessfully(message) || !message.toolResult
    || message.toolResult.length > MAX_AUTHENTICATION_RECEIPT_CHARS) return undefined;
  const startToolName = structuredAuthenticationToolName(message.toolName);
  if (!startToolName
    || !/(?:^|_)(?:auth(?:entication|orization)?|oauth|device(?:_code)?|consent)(?:_|$)/i.test(startToolName.operation)
    || !/(?:^|_)(?:start|begin|request|connect|login|authorize|consent)(?:_|$)/i.test(startToolName.operation)) {
    return undefined;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(message.toolResult.trim()); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.ok !== undefined && typeof value.ok !== 'boolean') return undefined;
  if (value.success !== undefined && typeof value.success !== 'boolean') return undefined;
  if (value.pending !== undefined && typeof value.pending !== 'boolean') return undefined;
  if ((value.ok !== true && value.success !== true)
    || value.ok === false || value.success === false || value.pending === false) return undefined;
  if (value.error !== undefined && value.error !== null) {
    if (typeof value.error !== 'string' || value.error.length > 4_096 || value.error.trim().length > 0) {
      return undefined;
    }
  }
  for (const field of ['status', 'state'] as const) {
    if (value[field] === undefined) continue;
    if (!boundedStringField(value[field], 64)
      || !AUTHENTICATION_PENDING_STATES.has(value[field].trim().toLowerCase())) return undefined;
  }
  const verificationUri = value.verification_uri ?? value.verificationUri;
  const userCode = value.user_code ?? value.userCode;
  const pollOperationValue = value.pollAfterHumanLoginWith ?? value.poll_after_human_login_with;
  const expiresAt = value.expiresAt ?? value.expires_at;
  if (!boundedStringField(verificationUri, 2_048)
    || !/^https:\/\/[^\s]+$/i.test(verificationUri)
    || !boundedStringField(userCode, 128)
    || !/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(userCode)
    || !boundedStringField(pollOperationValue, 128)
    || !boundedStringField(expiresAt, 128)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(expiresAt)) {
    return undefined;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(message.timestamp)
    || expiresAtMs > message.timestamp + MAX_AUTHORIZATION_RECEIPT_TTL_MS) {
    return undefined;
  }
  const explicitPollToolName = structuredAuthenticationToolName(pollOperationValue);
  const pollToolName = explicitPollToolName ?? {
    connector: startToolName.connector,
    operation: pollOperationValue.toLowerCase(),
  };
  if (pollToolName.connector !== startToolName.connector
    || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(pollToolName.operation)
    || !/(?:auth|oauth|device|consent).*(?:poll|status|check)|(?:poll|status|check).*(?:auth|oauth|device|consent)/i.test(pollToolName.operation)) {
    return undefined;
  }
  const inputCorrelations = authCorrelations(message.toolInput ?? {}, message.authRequestId);
  const resultCorrelations = authCorrelations(value, message.authRequestId);
  if (!inputCorrelations || !resultCorrelations) return undefined;
  const correlations = mergeAuthCorrelations(inputCorrelations, resultCorrelations);
  if (!correlations) return undefined;
  return {
    expiresAtMs,
    pollToolName,
    correlations,
  };
}

export function matchingAuthenticationPoll(
  binding: StructuredAuthenticationPollBinding, candidate: Message, resultCorrelations: AuthCorrelations,
): boolean {
  const candidateToolName = structuredAuthenticationToolName(candidate.toolName);
  if (!candidateToolName
    || candidateToolName.connector !== binding.pollToolName.connector
    || candidateToolName.operation !== binding.pollToolName.operation) return false;
  const inputCorrelations = authCorrelations(candidate.toolInput ?? {}, candidate.authRequestId);
  if (!inputCorrelations) return false;
  const candidateCorrelations = mergeAuthCorrelations(inputCorrelations, resultCorrelations);
  if (!candidateCorrelations) return false;
  return matchingAuthCorrelations(binding.correlations, candidateCorrelations);
}

export function successfulAuthenticationPollReceipt(message: Message): AuthCorrelations | undefined {
  if (!isObjectiveToolExecutedSuccessfully(message) || !message.toolResult
    || message.toolResult.length > MAX_AUTHENTICATION_RECEIPT_CHARS) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(message.toolResult.trim()); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.pending !== undefined && typeof value.pending !== 'boolean') return undefined;
  if (value.ok !== undefined && typeof value.ok !== 'boolean') return undefined;
  if (value.success !== undefined && typeof value.success !== 'boolean') return undefined;
  if (value.pending === true || value.ok === false || value.success === false) return undefined;
  if (value.error !== undefined && value.error !== null) {
    if (typeof value.error !== 'string' || value.error.length > 4_096 || value.error.trim().length > 0) {
      return undefined;
    }
  }
  const states: string[] = [];
  for (const field of ['status', 'state'] as const) {
    if (value[field] === undefined) continue;
    if (!boundedStringField(value[field], 64)) return undefined;
    const normalized = value[field].trim().toLowerCase();
    if (!AUTHENTICATION_SUCCESS_STATES.has(normalized)) return undefined;
    states.push(normalized);
  }
  if (value.pending !== false && states.length === 0) return undefined;
  return authCorrelations(value);
}

/** A pending poll is durable blocker evidence only when its machine fields are
 * internally consistent. Free-form prose is deliberately excluded: the host
 * must be able to distinguish pending from terminal/fatal responses without
 * interpreting connector text. */
function pendingAuthenticationPollReceipt(value: Record<string, unknown>): boolean {
  if (value.pending !== undefined && typeof value.pending !== 'boolean') return false;
  if (value.ok !== undefined && typeof value.ok !== 'boolean') return false;
  if (value.success !== undefined && typeof value.success !== 'boolean') return false;
  if (value.ok !== undefined && value.success !== undefined && value.ok !== value.success) return false;
  if (value.pending === false || value.success === true) return false;

  let pending = value.pending === true;
  for (const field of ['status', 'state'] as const) {
    if (value[field] === undefined) continue;
    if (!boundedStringField(value[field], 64)) return false;
    const normalized = value[field].trim().toLowerCase();
    if (!AUTHENTICATION_PENDING_STATES.has(normalized)) return false;
    pending = true;
  }
  for (const field of ['code', 'error'] as const) {
    if (value[field] === undefined || value[field] === null || value[field] === '') continue;
    if (!boundedStringField(value[field], field === 'error' ? 4_096 : 256)) return false;
    if (!AUTHENTICATION_PENDING_STATES.has(value[field].trim().toLowerCase())) return false;
    pending = true;
  }
  return pending;
}

/** Bind a blocker emitted directly by an auth poll/status/receipt operation.
 * Unlike an auth-start receipt it has no declared follow-up operation, so only
 * a strict success from this exact connector operation and correlated flow can
 * retire it. */
export function structuredAuthenticationPollBlocker(message: Message): StructuredAuthenticationPollBinding | undefined {
  if (!isObjectiveToolExecutedSuccessfully(message) || !message.toolResult
    || message.toolResult.length > MAX_AUTHENTICATION_RECEIPT_CHARS) return undefined;
  const pollToolName = structuredAuthenticationToolName(message.toolName);
  if (!pollToolName
    || !/(?:^|_)(?:auth(?:entication|orization)?|oauth|device(?:_code)?|consent)(?:_|$)/i.test(pollToolName.operation)
    || !/(?:^|_)(?:poll|status|check|wait|receipt)(?:_|$)/i.test(pollToolName.operation)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(message.toolResult.trim()); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (!pendingAuthenticationPollReceipt(parsed as Record<string, unknown>)) return undefined;
  const inputCorrelations = authCorrelations(message.toolInput ?? {}, message.authRequestId);
  const resultCorrelations = authCorrelations(parsed as Record<string, unknown>, message.authRequestId);
  if (!inputCorrelations || !resultCorrelations) return undefined;
  const correlations = mergeAuthCorrelations(inputCorrelations, resultCorrelations);
  return correlations && hasAuthCorrelation(correlations) ? { pollToolName, correlations } : undefined;
}

export function structuredAuthenticationSurface(text: string): boolean {
  const rawUrl = /^url:\s*(https?:\/\/\S+)/im.exec(text)?.[1];
  if (!rawUrl || rawUrl.length > 2_048) return false;
  try {
    const url = new URL(rawUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    // A browser snapshot is observation-only and cannot prove that a custom
    // application's login form is the credential boundary for the objective.
    // Custom authentication must instead emit the structured auth request or
    // receipt handled above. Only known identity-provider hosts are strong
    // enough for a snapshot alone to prove a current human blocker.
    return KNOWN_AUTHENTICATION_HOSTS.has(hostname);
  } catch {
    return false;
  }
}
