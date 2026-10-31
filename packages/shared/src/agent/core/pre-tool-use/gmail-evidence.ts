import { isUnknownArray } from '../../../utils/json.ts';
import { createHash } from "node:crypto";
import { contextualGmailClosedExactEffectExpectationFromObjective, type ContextualGmailReplyPreflightAttestation, type ContextualGmailReplyPreflightIntent } from "../sensitive-external-action.ts";
import { CONTEXTUAL_GMAIL_BINDING_FUTURE_SKEW_MS, CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS, CONTEXTUAL_GMAIL_READ_TOOLS, GMAIL_API_MESSAGE_ID, contextualGmailPreflightAttestations, contextualGmailPreflightGenerations } from './gmail-state.ts';

export function contextualGmailObjectiveFingerprint(segments: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(segments), 'utf8').digest('hex');
}

export function nextContextualGmailPreflightGeneration(sessionId: string): number {
  const generation = (contextualGmailPreflightGenerations.get(sessionId) ?? 0) + 1;
  contextualGmailPreflightGenerations.set(sessionId, generation);
  return generation;
}

export function contextualGmailPreflightIntentsMatch(
  first: ContextualGmailReplyPreflightIntent,
  second: ContextualGmailReplyPreflightIntent,
): boolean {
  return first.scope === second.scope
    && first.messageId === second.messageId
    && first.body === second.body
    && first.isHtml === second.isHtml
    && first.requiresExactEffectReconciliation === second.requiresExactEffectReconciliation
    && first.expectedRecipientEmail === second.expectedRecipientEmail
    && first.expectedSenderEmail === second.expectedSenderEmail
    && first.expectedCc === second.expectedCc
    && first.expectedSubject === second.expectedSubject
    && first.objectiveRequest === second.objectiveRequest;
}

export function contextualGmailBindingExpiresAt(
  binding: string,
  bindingExpiresInSeconds: unknown,
  observedAtMs: number,
): number | undefined {
  const match = /^v1\.([0-9]{10})\.[0-9a-f]{64}$/u.exec(binding);
  if (!match
    || typeof bindingExpiresInSeconds !== 'number'
    || !Number.isFinite(bindingExpiresInSeconds)
    || bindingExpiresInSeconds <= 0) return undefined;
  const issuedAtMs = Number(match[1]) * 1000;
  if (!Number.isSafeInteger(issuedAtMs)
    || issuedAtMs > observedAtMs + CONTEXTUAL_GMAIL_BINDING_FUTURE_SKEW_MS
    || observedAtMs - issuedAtMs > CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS) return undefined;
  const receiptExpiryMs = observedAtMs + Math.min(
    bindingExpiresInSeconds * 1000,
    CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS,
  );
  const signedExpiryMs = issuedAtMs + CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS;
  const expiresAtMs = Math.min(receiptExpiryMs, signedExpiryMs);
  return expiresAtMs > observedAtMs ? expiresAtMs : undefined;
}

export function contextualGmailObjectiveProvidesClosedExactHumanAnchor(
  objectiveSegments: readonly string[] | undefined,
  intent: ContextualGmailReplyPreflightIntent,
): boolean {
  const exactEffect = contextualGmailClosedExactEffectExpectationFromObjective(
    objectiveSegments ?? [],
  );
  return intent.requiresExactEffectReconciliation
    && intent.scope === 'reply'
    && exactEffect?.scope === 'reply'
    && exactEffect.anchorMessageId?.toLowerCase() === intent.messageId.toLowerCase()
    && exactEffect.expectedRecipientEmail !== undefined
    && exactEffect.expectedRecipientEmail === intent.expectedRecipientEmail
    && exactEffect.expectedSenderEmail !== undefined
    && exactEffect.expectedSenderEmail === intent.expectedSenderEmail
    && exactEffect.expectedCc === ''
    && intent.expectedCc === ''
    && exactEffect.expectedSubject !== undefined
    && exactEffect.expectedSubject === intent.expectedSubject
    && exactEffect.expectedBody !== undefined
    && exactEffect.expectedBody === intent.body
    && exactEffect.expectedIsHtml === intent.isHtml;
}

export function contextualGmailToolReceipt(value: string): Record<string, unknown> | undefined {
  if (!value || value.length > 2_000_000) return undefined;
  const trimmed = value.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !isUnknownArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    const metadataMatch = /\bResult metadata JSON:\s*(\{[^\r\n]+\})/u.exec(trimmed);
    if (metadataMatch?.[1]) {
      try {
        const parsedMetadata: unknown = JSON.parse(metadataMatch[1]);
        if (parsedMetadata && typeof parsedMetadata === 'object' && !isUnknownArray(parsedMetadata)) {
          return parsedMetadata as Record<string, unknown>;
        }
      } catch {
        // Fall through.
      }
    }
    return undefined;
  }
}

export function canonicalGmailEmailSet(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const emails = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)
    ?.map(email => email.toLowerCase()) ?? [];
  const residue = value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '')
    .replace(/[\s,;]+/gu, '');
  return residue || new Set(emails).size !== emails.length
    ? undefined
    : [...new Set(emails)].sort();
}

export function hasConclusiveContextualGmailExactEffectReconciliation(
  receipt: Record<string, unknown>,
): boolean {
  const reconciliation = receipt["exactEffectReconciliation"];
  if (!reconciliation || typeof reconciliation !== 'object'
    || isUnknownArray(reconciliation)) return false;
  const proof = reconciliation as Record<string, unknown>;
  return proof["checked"] === true
    && proof["conclusive"] === true
    && proof["paginationComplete"] === true
    && proof["source"] === 'gmail_threads_get_full'
    && isUnknownArray(proof["scopes"])
    && proof["scopes"].length === 2
    && proof["scopes"][0] === 'SENT'
    && proof["scopes"][1] === 'DRAFT'
    && proof["candidateCount"] === 0
    && typeof receipt["threadId"] === 'string'
    && GMAIL_API_MESSAGE_ID.test(receipt["threadId"])
    && proof["threadId"] === receipt["threadId"]
    && typeof receipt["operationKey"] === 'string'
    && /^[0-9a-f]{64}$/u.test(receipt["operationKey"])
    && proof["operationKey"] === receipt["operationKey"];
}

export function exactObservedGmailMessageId(
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
): string | undefined {
  if (!CONTEXTUAL_GMAIL_READ_TOOLS.has(toolName) || result["error"] !== undefined) return undefined;
  if (toolName === 'mcp__orion-mcp__orion_mcp_read' || toolName === 'mcp__orion-mcp__orion_mcp_call') {
    const innerTool = typeof input?.["name"] === 'string' ? input["name"] : typeof result["tool"] === 'string' ? result["tool"] : '';
    if (innerTool !== 'gmail_get_message' && innerTool !== 'gmail_get_message_by_url') return undefined;
  }
  const payload = result["data"] && typeof result["data"] === 'object' && !isUnknownArray(result["data"])
    ? result["data"] as Record<string, unknown>
    : result;
  if (payload["error"] !== undefined) return undefined;
  const directId = typeof payload["id"] === 'string' && GMAIL_API_MESSAGE_ID.test(payload["id"])
    ? payload["id"].toLowerCase()
    : undefined;
  const latest = payload["latestMessage"] && typeof payload["latestMessage"] === 'object'
    ? payload["latestMessage"] as Record<string, unknown>
    : undefined;
  const latestId = typeof latest?.["id"] === 'string' && GMAIL_API_MESSAGE_ID.test(latest["id"])
    ? latest["id"].toLowerCase()
    : undefined;
  const messageId = directId ?? latestId;
  if (!messageId) return undefined;
  const nestedArgs = input?.["arguments"] && typeof input["arguments"] === 'object' && !isUnknownArray(input["arguments"])
    ? input["arguments"] as Record<string, unknown>
    : undefined;
  const rawRequestedId = typeof input?.["messageId"] === 'string'
    ? input["messageId"]
    : typeof nestedArgs?.["messageId"] === 'string'
      ? nestedArgs["messageId"]
      : undefined;
  const requestedId = rawRequestedId && GMAIL_API_MESSAGE_ID.test(rawRequestedId.trim())
    ? rawRequestedId.trim().toLowerCase()
    : undefined;
  if (requestedId && requestedId !== messageId) return undefined;
  return messageId;
}

export function currentContextualGmailPreflightAttestation(
  sessionId: string,
  objectiveFingerprint: string,
): ContextualGmailReplyPreflightAttestation | undefined {
  const stored = contextualGmailPreflightAttestations.get(sessionId);
  if (!stored) return undefined;
  if (stored.expiresAt <= Date.now()
    || stored.objectiveFingerprint !== objectiveFingerprint
    || stored.generation !== contextualGmailPreflightGenerations.get(sessionId)) {
    contextualGmailPreflightAttestations.delete(sessionId);
    return undefined;
  }
  return stored.value;
}
