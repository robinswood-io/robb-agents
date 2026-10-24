import { contextualGmailResolvedConstraints } from './gmail-reply-constraints.ts';
import { contextualGmailExactEffectExpectationFromObjective } from './gmail-reply-expectation.ts';
import { contextualGmailReplyObjective, contextualGmailReplyObjectiveScope } from './gmail-reply-objective.ts';
import type { ContextualGmailReplyObjective, ContextualGmailReplyScope } from './gmail-reply-parsing.ts';
import { CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_KEYS, CONTEXTUAL_GMAIL_REPLY_ALL_TOOL, CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_KEYS, CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL, CONTEXTUAL_GMAIL_REPLY_TOOL, CONTEXTUAL_GMAIL_SEND_TOOL, GMAIL_MESSAGE_ID, LEGACY_CONTEXTUAL_GMAIL_REPLY_TOOL, contextualGmailMessageIds, isCanonicalContextualGmailReplyInput, latestContextualGmailMention } from './gmail-reply-parsing.ts';

/**
 * Host-observed intent for one connector preflight. The connector's signed
 * `recipientBinding` proves that the preflight actually resolved this same
 * closed payload; this record additionally proves that the host saw the
 * resolution attempt under the still-current authenticated human objective.
 */
export interface ContextualGmailReplyPreflightIntent {
  scope: ContextualGmailReplyScope;
  messageId: string;
  body: string;
  isHtml: boolean;
  requiresExactEffectReconciliation: boolean;
  expectedRecipientEmail?: string;
  expectedSenderEmail?: string;
  expectedCc?: string;
  expectedSubject?: string;
  objectiveRequest: string;
}

interface ContextualGmailReplyPreflightAttestationBase
  extends ContextualGmailReplyPreflightIntent {
  recipientBinding: string;
  bindingExpiresAtMs: number;
  preflightToolUseId: string;
}

export type ContextualGmailReplyPreflightAttestation =
  ContextualGmailReplyPreflightAttestationBase & (
    | { anchorEvidence: 'gmail-read'; readToolUseId: string }
    | { anchorEvidence: 'exact-human-objective'; readToolUseId?: never }
  );

export function contextualGmailReplyPreflightAttestationFromObjective(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): ContextualGmailReplyPreflightIntent | undefined {
  const requested = contextualGmailReplyObjective(objectiveSegments);
  if (!requested) return undefined;
  const constraints = contextualGmailResolvedConstraints(requested);
  if (constraints.invalid) return undefined;
  const exactEffect = contextualGmailExactEffectExpectationFromObjective(objectiveSegments);
  const expectedTool = requested.scope === 'reply-all'
    ? 'mcp__google-contacts__gmail_reply_all_preflight'
    : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL;
  const allowedKeys = requested.scope === 'reply-all'
    ? CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_KEYS
    : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_KEYS;
  if (toolName !== expectedTool
    || Object.keys(input).some(key => !allowedKeys.has(key))
    || typeof input.messageId !== 'string'
    || input.messageId !== input.messageId.trim()
    || !GMAIL_MESSAGE_ID.test(input.messageId)
    || typeof input.body !== 'string'
    || input.body.trim().length === 0
    || /\0/u.test(input.body)
    || input.isHtml !== undefined && typeof input.isHtml !== 'boolean') return undefined;

  const messageId = input.messageId.toLowerCase();
  const objectiveMessageIds = constraints.messageIds;
  if (objectiveMessageIds.length > 1
    || objectiveMessageIds.length === 1
      && objectiveMessageIds[0]!.toLowerCase() !== messageId) return undefined;

  const exactBody = constraints.body;
  if (exactBody !== undefined && (input.body !== exactBody || input.isHtml === true)) {
    return undefined;
  }
  const objectiveEmails = constraints.recipients;
  const objectiveSenderEmails = constraints.senders;
  const validOptionalSenderEmail = input.expectedSenderEmail === undefined
    || typeof input.expectedSenderEmail === 'string'
      && input.expectedSenderEmail === input.expectedSenderEmail.trim().toLowerCase()
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedSenderEmail);
  if (objectiveSenderEmails.length > 1
    || !validOptionalSenderEmail
    || objectiveSenderEmails.length === 1
      && input.expectedSenderEmail !== objectiveSenderEmails[0]) return undefined;
  if (requested.scope === 'reply-all') {
    if (input.expectedRecipientEmail !== undefined || objectiveEmails.length > 0) return undefined;
  } else {
    if (typeof input.expectedRecipientEmail !== 'string'
      || input.expectedRecipientEmail !== input.expectedRecipientEmail.trim().toLowerCase()
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedRecipientEmail)
      || objectiveEmails.length > 1
      || objectiveEmails.length === 1
        && input.expectedRecipientEmail !== objectiveEmails[0]) return undefined;
  }

  return {
    scope: requested.scope,
    messageId,
    body: input.body,
    isHtml: input.isHtml === true,
    requiresExactEffectReconciliation: requested.requiresExactEffectReconciliation,
    ...(requested.scope === 'reply'
      ? { expectedRecipientEmail: String(input.expectedRecipientEmail) }
      : {}),
    ...(objectiveSenderEmails.length === 1
      ? { expectedSenderEmail: objectiveSenderEmails[0] }
      : typeof input.expectedSenderEmail === 'string'
        ? { expectedSenderEmail: input.expectedSenderEmail }
        : {}),
    ...(exactEffect?.expectedCc !== undefined
      ? { expectedCc: exactEffect.expectedCc }
      : {}),
    ...(exactEffect?.expectedSubject !== undefined
      ? { expectedSubject: exactEffect.expectedSubject }
      : {}),
    objectiveRequest: constraints.objectiveRequest,
  };
}

function contextualGmailReplyMatchesPreflightAttestation(
  input: Record<string, unknown>,
  requested: ContextualGmailReplyObjective,
  attestation?: ContextualGmailReplyPreflightAttestation,
): boolean {
  const constraints = contextualGmailResolvedConstraints(requested);
  if (!attestation
    || constraints.invalid
    || attestation.scope !== requested.scope
    || attestation.requiresExactEffectReconciliation
      !== requested.requiresExactEffectReconciliation
    || attestation.objectiveRequest !== constraints.objectiveRequest
    || attestation.messageId !== String(input.messageId).toLowerCase()
    || attestation.recipientBinding !== input.recipientBinding
    || attestation.body !== String(input.body)
    || attestation.isHtml !== (input.isHtml === true)
    || attestation.expectedSenderEmail !== input.expectedSenderEmail) return false;
  return requested.scope === 'reply-all'
    ? attestation.expectedRecipientEmail === undefined
    : attestation.expectedRecipientEmail === input.expectedRecipientEmail;
}

/**
 * Bind deictic reply instructions ("reply to them", "dans le fil existant")
 * only to the closed Gmail reply operation. The messageId fixes the existing
 * thread, while the closed schema prevents an agent from adding recipients,
 * attachments, sender overrides, or another routing field.
 */
export function isContextualGmailReplyAuthorizedByObjective(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
  preflightAttestation?: ContextualGmailReplyPreflightAttestation,
): boolean {
  if (!isCanonicalContextualGmailReplyInput(toolName, input)) return false;
  const requested = contextualGmailReplyObjective(objectiveSegments);
  const constraints = requested ? contextualGmailResolvedConstraints(requested) : undefined;
  const messageId = String(input.messageId).toLowerCase();
  const objectiveMessageIds = constraints?.messageIds ?? [];
  const objectiveEmails = constraints?.recipients ?? [];
  const objectiveSenderEmails = constraints?.senders ?? [];
  const exactBody = constraints?.body;
  // Only the local bound wrappers supply a short-lived signed capability that
  // binds message/thread, resolved recipient set and body. When the human
  // naturally names "this thread" instead of an API id, the host must also
  // have observed the matching preflight under this exact objective. The
  // legacy plain reply tool cannot inherit this contextual authority.
  const exactHumanAnchor = objectiveMessageIds.length === 1
    && objectiveMessageIds[0]!.toLowerCase() === messageId;
  const hostObservedAnchor = requested !== undefined
    && objectiveMessageIds.length === 0
    && contextualGmailReplyMatchesPreflightAttestation(
      input,
      requested,
      preflightAttestation,
    );
  const exactEffectReconciliationAttested = requested !== undefined
    && (!requested.requiresExactEffectReconciliation
      || contextualGmailReplyMatchesPreflightAttestation(
        input,
        requested,
        preflightAttestation,
      ));
  return requested !== undefined
    && constraints !== undefined
    && !constraints.invalid
    && exactEffectReconciliationAttested
    && objectiveMessageIds.length <= 1
    && (exactHumanAnchor || hostObservedAnchor)
    && (exactBody === undefined
      || String(input.body) === exactBody && input.isHtml !== true)
    && objectiveSenderEmails.length <= 1
    && (objectiveSenderEmails.length === 0
      ? input.expectedSenderEmail === undefined || typeof input.expectedSenderEmail === 'string'
      : input.expectedSenderEmail === objectiveSenderEmails[0])
    && (requested.scope === 'reply-all'
      ? objectiveEmails.length === 0
      : objectiveEmails.length <= 1
        && (objectiveEmails.length === 0
          || input.expectedRecipientEmail === objectiveEmails[0]))
    && toolName === (requested.scope === 'reply-all'
      ? CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
      : CONTEXTUAL_GMAIL_REPLY_TOOL);
}

/** True when the accepted objective calls for a reply in an already selected Gmail thread. */
export function isContextualGmailReplyRequestedByObjective(
  objectiveSegments: readonly string[],
): boolean {
  return contextualGmailReplyObjectiveScope(objectiveSegments) !== undefined;
}

/** A contextual Gmail reply mentioned anywhere in the accepted objective must
 * stay on the signed connector path, including when the latest wording asks
 * for a draft, pause, or confirmation rather than authorizing the send. */
export function hasContextualGmailReplyMention(
  objectiveSegments: readonly string[],
): boolean {
  return latestContextualGmailMention(objectiveSegments) !== undefined;
}

/**
 * A new Gmail send cannot safely implement an existing-thread reply: its
 * model-supplied To/CC fields are not proof of the thread's participants.
 */
export function contextualGmailReplyRecoveryReason(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
  preflightAttestation?: ContextualGmailReplyPreflightAttestation,
): string | undefined {
  const requested = contextualGmailReplyObjective(objectiveSegments);
  const requestedScope = requested?.scope;
  if (![
    CONTEXTUAL_GMAIL_SEND_TOOL,
    LEGACY_CONTEXTUAL_GMAIL_REPLY_TOOL,
    CONTEXTUAL_GMAIL_REPLY_TOOL,
    CONTEXTUAL_GMAIL_REPLY_ALL_TOOL,
  ].includes(toolName)) return undefined;
  if (!requestedScope) {
    const contextualMention = latestContextualGmailMention(objectiveSegments);
    if (!contextualMention) {
      return toolName === CONTEXTUAL_GMAIL_SEND_TOOL
        ? undefined
        : 'Validation failed: Gmail thread replies must use one exact messageId and the signed closed preflight/reply contract. Do not use a legacy or unbound reply path, infer another recipient, or use a browser fallback.';
    }
    const mentionedIds = contextualGmailMessageIds(contextualMention);
    const selectedId = typeof input.messageId === 'string' ? input.messageId.trim().toLowerCase() : '';
    if (mentionedIds.length !== 1
      || toolName !== CONTEXTUAL_GMAIL_SEND_TOOL
        && mentionedIds[0]!.toLowerCase() !== selectedId) {
      return 'Validation failed: the accepted objective does not bind this contextual Gmail reply to one exact messageId. Do not choose another thread or use a browser fallback; obtain one target-bound instruction before sending.';
    }
    return 'Objective authority: a newer accepted instruction restricts or replaces the earlier contextual Gmail reply and does not authorize this exact target now. Continue only with read-only or draft work explicitly requested; do not send or use a browser fallback.';
  }
  const constraints = requested ? contextualGmailResolvedConstraints(requested) : undefined;
  if (!constraints || constraints.invalid) {
    return 'Validation failed: the accepted Gmail objective contains a conflicting or ambiguous exact delimited body or exact fields across its authenticated amendments. Do not infer a target or payload, send, or use a browser fallback; obtain one unambiguous exact instruction.';
  }
  const objectiveMessageIds = constraints.messageIds;
  const objectiveEmails = constraints.recipients;
  const objectiveSenderEmails = constraints.senders;
  const messageId = typeof input.messageId === 'string' ? input.messageId.trim().toLowerCase() : '';
  if (objectiveMessageIds.length > 1) {
    return 'Validation failed: the accepted objective names more than one Gmail messageId. Do not choose a thread or use a browser fallback; obtain one unambiguous target-bound instruction before sending.';
  }
  const exactHumanAnchor = objectiveMessageIds.length === 1
    && objectiveMessageIds[0]!.toLowerCase() === messageId;
  const hostObservedAnchor = objectiveMessageIds.length === 0
    && requested !== undefined
    && contextualGmailReplyMatchesPreflightAttestation(
      input,
      requested,
      preflightAttestation,
    );
  const targetBound = toolName === CONTEXTUAL_GMAIL_SEND_TOOL
    ? objectiveMessageIds.length === 1
    : !!messageId && (exactHumanAnchor || hostObservedAnchor);
  if (!targetBound) {
    if (objectiveMessageIds.length === 0) {
      const preflightTool = requestedScope === 'reply-all'
        ? 'mcp__google-contacts__gmail_reply_all_preflight'
        : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL;
      return `Validation failed: this natural-language thread reply has not yet been host-attested to the selected Gmail message. Use the concrete messageId already returned by the read step with ${preflightTool}, preserving the exact body and recipient scope, then retry only with its signed recipientBinding. Do not ask the user for an internal Gmail id and do not use a browser fallback.`;
    }
    return 'Validation failed: the accepted objective does not bind that authorization to this exact messageId; it binds the contextual Gmail reply to a different messageId. Do not choose another thread or use a browser fallback; obtain one target-bound instruction before sending.';
  }
  if (requestedScope === 'reply-all' && objectiveEmails.length > 0
    || requestedScope === 'reply' && objectiveEmails.length > 1) {
    return 'Validation failed: the accepted contextual Gmail objective contains an ambiguous or incompatible recipient scope. Obtain one target-bound instruction instead of inferring or changing the thread audience.';
  }
  if (objectiveSenderEmails.length > 1) {
    return 'Validation failed: the accepted contextual Gmail objective names more than one sender identity. Obtain one exact From address instead of selecting an account or alias autonomously.';
  }
  if (toolName === (requestedScope === 'reply-all'
    ? CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
    : CONTEXTUAL_GMAIL_REPLY_TOOL)
    && objectiveSenderEmails.length === 1
    && input.expectedSenderEmail !== objectiveSenderEmails[0]) {
    return 'Validation failed: expectedSenderEmail does not match the exact From identity named in the accepted human objective. Re-run the signed preflight for that authenticated Gmail profile; do not select another account or alias.';
  }
  if (requestedScope === 'reply'
    && toolName === CONTEXTUAL_GMAIL_REPLY_TOOL
    && objectiveEmails.length === 1
    && input.expectedRecipientEmail !== objectiveEmails[0]) {
    return 'Validation failed: expectedRecipientEmail does not match the exact recipient named in the accepted human objective. Re-run the signed preflight for that exact address; do not retarget the reply.';
  }
  const exactBody = constraints.body;
  const suppliedBody = typeof input.body === 'string' ? input.body : '';
  if (exactBody !== undefined && suppliedBody !== exactBody) {
    return 'Validation failed: the Gmail reply body does not match the exact delimited body in the accepted human objective. Reuse that body verbatim in the signed preflight and reply; do not paraphrase it or use a browser fallback.';
  }
  const requiredTool = requestedScope === 'reply-all'
    ? CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
    : CONTEXTUAL_GMAIL_REPLY_TOOL;
  if (toolName === requiredTool
    && requested.requiresExactEffectReconciliation
    && !contextualGmailReplyMatchesPreflightAttestation(
      input,
      requested,
      preflightAttestation,
    )) {
    const preflightTool = requestedScope === 'reply-all'
      ? 'mcp__google-contacts__gmail_reply_all_preflight'
      : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL;
    return `Validation failed: this resumed exact Gmail effect requires one fresh host-observed ${preflightTool} receipt proving a complete, conclusive Sent + Drafts reconciliation with no matching candidate. Run that read-only preflight on the exact anchor and payload, then use only its signed recipientBinding; missing, incomplete, paginated, ambiguous, or candidate-bearing receipts cannot authorize the reply.`;
  }
  if (toolName === requiredTool && isCanonicalContextualGmailReplyInput(toolName, input)) {
    return undefined;
  }
  const preflightTool = requestedScope === 'reply-all'
    ? 'mcp__google-contacts__gmail_reply_all_preflight'
    : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL;
  const preflightDetail = requestedScope === 'reply-all'
    ? 'whose To/Cc headers match the approved participant set'
    : 'with the exact expected recipient email resolved from that anchor';
  return `Validation failed: the accepted objective requires a contextual ${requestedScope === 'reply-all' ? 'reply-all preserving the thread recipients' : 'recipient-bound reply'} in the existing Gmail thread. Run ${preflightTool} on the exact anchor ${preflightDetail}, then use its recipientBinding with ${requiredTool} and the same closed payload. The legacy mcp__google-contacts__gmail_reply tool is not authorized because it does not bind the recipient. Do not ask for broader permission and do not use a browser fallback.`;
}
