import { hasSingleMailboxShape } from "../../../utils/string-boundaries.ts";
import { contextualGmailExactConstraintSegment } from './gmail-reply-constraints.ts';
import { hasClosedExactContextualGmailReplyContract } from './gmail-reply-contract.ts';
import type { ContextualGmailReplyObjective, ContextualGmailReplyScope } from './gmail-reply-parsing.ts';
import { CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_TOOL, CONTEXTUAL_GMAIL_REPLY_ALL_TOOL, CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL, CONTEXTUAL_GMAIL_REPLY_TOOL, CONTEXTUAL_REPLY_ALL_SCOPE, CONTEXTUAL_REPLY_AUDIENCE_CHANGE, CONTEXTUAL_REPLY_CONCLUSIVE_ABSENCE_CONTINUATION, CONTEXTUAL_REPLY_CONFIRMATION_BOUNDARY, CONTEXTUAL_REPLY_DEFERRED_BOUNDARY, CONTEXTUAL_REPLY_DUPLICATE_AMBIGUITY_NO_SEND, CONTEXTUAL_REPLY_DUPLICATE_CHECK, CONTEXTUAL_REPLY_EXACT_EFFECT_CONTINUATION, CONTEXTUAL_REPLY_EXPLICIT_NO_AUDIENCE_CHANGE, CONTEXTUAL_REPLY_EXPLICIT_RETARGET, CONTEXTUAL_REPLY_META_INSTRUCTION, CONTEXTUAL_REPLY_NAMED_AUDIENCE_CHANGE, CONTEXTUAL_REPLY_NAMED_AUDIENCE_REMOVAL, CONTEXTUAL_REPLY_NEGATION, CONTEXTUAL_REPLY_NON_AUDIENCE_CONSTRAINT, CONTEXTUAL_REPLY_NON_DIRECTIVE, CONTEXTUAL_REPLY_NO_SEND_BOUNDARY, CONTEXTUAL_REPLY_PREPARATION, CONTEXTUAL_REPLY_PRONOUN, CONTEXTUAL_REPLY_REPLACED_BY_READ_ONLY, CONTEXTUAL_REPLY_REPORTED_SPEECH, CONTEXTUAL_REPLY_SENT_DRAFTS_RECONCILIATION, CONTEXTUAL_REPLY_SIGNED_PREFLIGHT_FIELDS, CONTEXTUAL_REPLY_STRUCTURED_BOUND_EXECUTION, CONTEXTUAL_REPLY_STRUCTURED_EXACT_EFFECT_CONTINUATION, CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD, CONTEXTUAL_REPLY_STRUCTURED_RECONCILIATION, CONTEXTUAL_REPLY_STRUCTURED_UNCERTAIN_RESULT, CONTEXTUAL_REPLY_THREAD, CONTEXTUAL_REPLY_THREAD_REJECTION, CONTEXTUAL_REPLY_VERB, CONTEXTUAL_SEND_VERB, CONTEXTUAL_UNRELATED_ADDITIONAL_SEND, contextualGmailMessageIds, contextualGmailRoutingText, contextualGmailStructuredImmutableControlText, contextualGmailTargetEmails, hasContextualReplyUnsatisfiedCondition } from './gmail-reply-parsing.ts';
import { parseHostAuthenticatedUserAuthorization } from './host-authorization.ts';
import { EXPLICIT_ACTION_AFTER_CONFIRMATION, EXPLICIT_STOP_BEFORE_EXTERNAL_ACTION, hasGlobalExternalActionRevocation, isNonAuthorizingRequest, requestClauses } from './request-authorization.ts';
import { isTargetFreeGenericContinuation } from './structured-gmail-send.ts';
import { normalizeForMatch } from './target-syntax.ts';

/**
 * A host-validated affirmative answer can authorize several Gmail replies in
 * one choice. Project only the current preflight/reply target into the
 * single-target policy grammar; the full objective remains the receipt
 * fingerprint. The signed preflight and a separately observed Gmail read
 * still bind this target to its actual thread and recipients.
 */
export function contextualGmailTargetScopedAuthorizationSegments(
  objectiveSegments: readonly string[],
  authenticatedUserAuthorizationSegments: readonly string[],
  toolName: string,
  input: Record<string, unknown>,
): readonly string[] {
  if (![
    CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL,
    CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_TOOL,
    CONTEXTUAL_GMAIL_REPLY_TOOL,
    CONTEXTUAL_GMAIL_REPLY_ALL_TOOL,
  ].includes(toolName)) return objectiveSegments;
  const messageId = typeof input.messageId === 'string'
    ? input.messageId.trim().toLowerCase() : '';
  const recipient = typeof input.expectedRecipientEmail === 'string'
    ? input.expectedRecipientEmail.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{12,32}$/u.test(messageId)
    || !hasSingleMailboxShape(recipient)) return objectiveSegments;
  const latest = authenticatedUserAuthorizationSegments.at(-1);
  if (!latest || objectiveSegments.at(-1) !== latest) return objectiveSegments;
  const latestGrant = parseHostAuthenticatedUserAuthorization(latest);
  if (!latestGrant) return objectiveSegments;
  const latestScope = normalizeForMatch(
    latestGrant.selection + ' ' + latestGrant.displayedScope,
  );
  if (!/\b(?:repondre|reply|answer)\b/u.test(latestScope)
    || CONTEXTUAL_REPLY_NEGATION.test(latestScope)) return objectiveSegments;
  const ids = contextualGmailMessageIds(latestGrant.selection);
  if (ids.length > 0 && !ids.includes(messageId)) return objectiveSegments;
  const recipientGrant = [...authenticatedUserAuthorizationSegments].reverse()
    .map(parseHostAuthenticatedUserAuthorization)
    .find(grant => grant && /\b(?:repondre|reply|answer)\b/u.test(
      normalizeForMatch(grant.selection),
    ) && /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(grant.selection));
  if (!recipientGrant) return objectiveSegments;
  const selectedRecipients = recipientGrant.selection.match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  )?.map(email => email.toLowerCase()) ?? [];
  if (!selectedRecipients.includes(recipient)
    || new Set(selectedRecipients).size !== selectedRecipients.length
    || ids.length > 0
      && (ids.length !== selectedRecipients.length
        || ids.indexOf(messageId) !== selectedRecipients.indexOf(recipient))) {
    return objectiveSegments;
  }
  const anchor = ids.length > 0 ? ` MessageId: ${messageId}.` : '';
  return [...objectiveSegments,
    `Réponds dans ce fil Gmail. Cible exacte: ${recipient}.${anchor}`];
}

export function contextualGmailReplyObjective(
  objectiveSegments: readonly string[],
): ContextualGmailReplyObjective | undefined {
  const constraintRequests: string[] = [];
  let requiresPriorClosedExactEffect = false;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRoutingRequest = normalizeForMatch(contextualGmailRoutingText(rawRequest));
    const normalizedRequest = normalizedRoutingRequest;
    if (!normalizedRoutingRequest) continue;
    if (hasGlobalExternalActionRevocation(contextualGmailRoutingText(rawRequest))) return undefined;
    if (isTargetFreeGenericContinuation(normalizedRoutingRequest)) continue;

    const preparesReply = CONTEXTUAL_REPLY_PREPARATION.test(normalizedRoutingRequest);
    const namesReply = CONTEXTUAL_REPLY_VERB.test(normalizedRoutingRequest);
    const namesThreadBoundSend = CONTEXTUAL_SEND_VERB.test(normalizedRoutingRequest)
      && CONTEXTUAL_REPLY_THREAD.test(normalizedRoutingRequest);
    const namesContextualScope = CONTEXTUAL_REPLY_PRONOUN.test(normalizedRoutingRequest)
      || CONTEXTUAL_REPLY_THREAD.test(normalizedRoutingRequest)
      || CONTEXTUAL_REPLY_ALL_SCOPE.test(normalizedRoutingRequest)
      || contextualGmailTargetEmails(rawRequest).length > 0
      || contextualGmailMessageIds(rawRequest).length > 0
      || preparesReply;
    const namesExternalSend = namesReply || CONTEXTUAL_SEND_VERB.test(normalizedRoutingRequest)
      || preparesReply;
    const continuesPriorExactEffect = (
      CONTEXTUAL_REPLY_CONCLUSIVE_ABSENCE_CONTINUATION.test(normalizedRoutingRequest)
      || CONTEXTUAL_REPLY_STRUCTURED_EXACT_EFFECT_CONTINUATION.test(normalizedRoutingRequest)
    ) && contextualGmailMessageIds(rawRequest).length === 1;
    const exactEffectContinuation = continuesPriorExactEffect
      || CONTEXTUAL_REPLY_EXACT_EFFECT_CONTINUATION.test(normalizedRoutingRequest);
    const blockingRoutingText = continuesPriorExactEffect
      ? requestClauses(contextualGmailRoutingText(rawRequest))
        .filter(clause => {
          const normalizedClause = normalizeForMatch(clause);
          return !CONTEXTUAL_REPLY_DUPLICATE_AMBIGUITY_NO_SEND.test(normalizedClause)
            && !CONTEXTUAL_REPLY_SENT_DRAFTS_RECONCILIATION.test(normalizedClause)
            && !CONTEXTUAL_REPLY_STRUCTURED_BOUND_EXECUTION.test(normalizedClause)
            && !CONTEXTUAL_REPLY_STRUCTURED_RECONCILIATION.test(normalizedClause)
            && !CONTEXTUAL_REPLY_STRUCTURED_UNCERTAIN_RESULT.test(normalizedClause);
        })
        .join('. ')
      : contextualGmailRoutingText(rawRequest);
    const normalizedBlockingRequest = normalizeForMatch(blockingRoutingText);
    const structuredImmutablePayload = CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(
      contextualGmailRoutingText(rawRequest),
    );
    const audienceRoutingText = continuesPriorExactEffect && structuredImmutablePayload
      ? contextualGmailStructuredImmutableControlText(rawRequest)
      : contextualGmailRoutingText(rawRequest);
    let audienceMutationText = normalizeForMatch(audienceRoutingText)
      .replace(CONTEXTUAL_REPLY_EXPLICIT_NO_AUDIENCE_CHANGE, ' ')
      .replace(CONTEXTUAL_REPLY_NON_AUDIENCE_CONSTRAINT, ' ')
      .replace(CONTEXTUAL_REPLY_DUPLICATE_CHECK, ' ')
      .replace(CONTEXTUAL_REPLY_SIGNED_PREFLIGHT_FIELDS, ' ');
    if (continuesPriorExactEffect) {
      // In the closed exact-once continuation, `au plus une unique réponse`
      // limits operation cardinality. It is not the generic audience-change
      // construction `plus <recipient>` and must not revoke the prior exact
      // Gmail contract after the host has proved Sent + Drafts absence.
      audienceMutationText = audienceMutationText.replace(
        /\bau\s+plus\s+un(?:e)?\s+unique\s+(?:reponse|gmail\s+reply\s+bound)\b/gu,
        ' ',
      );
    }
    // A recipient-bound reply is closed to one To address and no Cc by both
    // its schema and signed preflight. `CC vide` documents that invariant; it
    // is not an instruction to remove recipients from a reply-all thread.
    if (!CONTEXTUAL_REPLY_ALL_SCOPE.test(normalizedRoutingRequest)) {
      audienceMutationText = audienceMutationText.replace(/\bcc\s+(?:vide|empty|none)\b/gu, ' ');
    }
    let retargetDetectionText = audienceMutationText;
    const routingRequest = contextualGmailRoutingText(rawRequest);
    for (const pattern of [
      /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    ]) {
      for (const match of routingRequest.matchAll(pattern)) {
        retargetDetectionText = retargetDetectionText.replace(normalizeForMatch(match[0]), ' ');
      }
    }
    const explicitRetarget = CONTEXTUAL_REPLY_EXPLICIT_RETARGET.test(
      normalizedRoutingRequest.replace(
        CONTEXTUAL_REPLY_EXPLICIT_NO_AUDIENCE_CHANGE,
        ' ',
      ),
    )
      || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(audienceRoutingText)
        && /\b(?:instead|plutot|rather|recipient|destinataire)\b/u.test(retargetDetectionText);

    const blocksContextualReply = isNonAuthorizingRequest(
      contextualGmailRoutingText(rawRequest),
      normalizedRoutingRequest,
    )
      || CONTEXTUAL_REPLY_NEGATION.test(normalizedBlockingRequest)
      || CONTEXTUAL_REPLY_THREAD_REJECTION.test(normalizedBlockingRequest)
      || CONTEXTUAL_REPLY_CONFIRMATION_BOUNDARY.test(normalizedRequest)
      || CONTEXTUAL_REPLY_DEFERRED_BOUNDARY.test(normalizedRequest)
      || CONTEXTUAL_REPLY_AUDIENCE_CHANGE.test(audienceMutationText)
      || CONTEXTUAL_REPLY_NAMED_AUDIENCE_CHANGE.test(audienceMutationText)
      || CONTEXTUAL_REPLY_NAMED_AUDIENCE_REMOVAL.test(audienceMutationText)
      || CONTEXTUAL_REPLY_NO_SEND_BOUNDARY.test(normalizedBlockingRequest)
      || CONTEXTUAL_REPLY_REPORTED_SPEECH.test(normalizedRequest)
      || CONTEXTUAL_REPLY_META_INSTRUCTION.test(normalizedRequest)
      || /(?:^|\r?\n)(?:[ \t]{4,}|\s*(?:(?:[-*+]\s+|\d+[.)]\s+)?(?:```|~~~|>)|<\/?(?:blockquote|pre|code)\b))/iu.test(
        contextualGmailRoutingText(rawRequest),
      )
      || /^\s*[«“"]/.test(rawRequest) && /[»”"]\s*$/.test(rawRequest)
      || CONTEXTUAL_REPLY_NON_DIRECTIVE.test(normalizedRequest)
      || CONTEXTUAL_REPLY_REPLACED_BY_READ_ONLY.test(normalizedRequest)
      || hasContextualReplyUnsatisfiedCondition(blockingRoutingText)
      || preparesReply
      || EXPLICIT_STOP_BEFORE_EXTERNAL_ACTION.test(normalizedRequest)
      || EXPLICIT_ACTION_AFTER_CONFIRMATION.test(normalizedRequest)
      || explicitRetarget;

    // Accepted amendments are additive by default. An unrelated additional
    // task must not silently discard an already authorized pending reply, but
    // an explicit wait, analysis-only, draft, negation, retarget, or approval
    // boundary still owns and closes the newer authority boundary.
    if (!namesExternalSend && !explicitRetarget) {
      if (blocksContextualReply) return undefined;
      if (contextualGmailExactConstraintSegment(rawRequest)) {
        constraintRequests.unshift(rawRequest);
      }
      continue;
    }
    // This wording explicitly depends on the exact effect "authorized in this
    // chat". Preserve its one anchor as an additive constraint, then require a
    // preceding authenticated reply objective to supply the closed payload.
    // With no preceding authority, or with a conflicting anchor, resolution
    // remains fail-closed.
    if (!blocksContextualReply && continuesPriorExactEffect) {
      // A restart can be self-contained instead of inheriting an earlier
      // segment. Admit that shape only when this same authenticated segment
      // explicitly orders the reply and closes every externally visible
      // field needed by the recipient-bound schema. A deictic continuation
      // such as "reprends" still follows the prior-segment path below.
      if (namesReply && namesContextualScope) {
        const standaloneObjective: ContextualGmailReplyObjective = {
          scope: CONTEXTUAL_REPLY_ALL_SCOPE.test(normalizedRoutingRequest)
            ? 'reply-all'
            : 'reply',
          rawRequest,
          constraintRequests,
          requiresExactEffectReconciliation: true,
        };
        return hasClosedExactContextualGmailReplyContract(standaloneObjective)
          ? standaloneObjective
          : undefined;
      }
      constraintRequests.unshift(rawRequest);
      requiresPriorClosedExactEffect = true;
      continue;
    }
    if (!namesReply && !namesThreadBoundSend
      && CONTEXTUAL_UNRELATED_ADDITIONAL_SEND.test(normalizedRequest)
      && !blocksContextualReply) continue;
    // A later duplicate-safe instruction may authorize execution of the exact
    // reply already bound by the preceding authenticated segment without
    // restating its target or payload. Inherit only this closed grammar; an
    // ordinary target-free send/reply directive remains fail-closed below.
    if (!blocksContextualReply && !namesContextualScope && exactEffectContinuation) continue;
    if (blocksContextualReply
      || !namesContextualScope
      || !namesReply && !namesThreadBoundSend) return undefined;
    const objective: ContextualGmailReplyObjective = {
      scope: CONTEXTUAL_REPLY_ALL_SCOPE.test(normalizedRoutingRequest) ? 'reply-all' : 'reply',
      rawRequest,
      constraintRequests,
      requiresExactEffectReconciliation: requiresPriorClosedExactEffect,
    };
    if (requiresPriorClosedExactEffect
      && !hasClosedExactContextualGmailReplyContract(objective)) return undefined;
    return objective;
  }
  return undefined;
}

export function contextualGmailReplyObjectiveScope(
  objectiveSegments: readonly string[],
): ContextualGmailReplyScope | undefined {
  return contextualGmailReplyObjective(objectiveSegments)?.scope;
}
