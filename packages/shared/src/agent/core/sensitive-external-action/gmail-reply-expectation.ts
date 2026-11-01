import type { ContextualGmailExactEffectExpectation } from './gmail-reply-constraints.ts';
import { contextualGmailResolvedConstraints } from './gmail-reply-constraints.ts';
import { hasClosedExactContextualGmailReplyContract } from './gmail-reply-contract.ts';
import { contextualGmailReplyObjective } from './gmail-reply-objective.ts';

export function contextualGmailExactEffectExpectationFromObjective(
  objectiveSegments: readonly string[],
): ContextualGmailExactEffectExpectation | undefined {
  const requested = contextualGmailReplyObjective(objectiveSegments);
  if (!requested) return undefined;
  const constraints = contextualGmailResolvedConstraints(requested);
  if (constraints.invalid) return undefined;
  const {
    messageIds, recipients, senders, subjects, body, cc,
  } = constraints;
  return {
    scope: requested.scope,
    ...(messageIds.length === 1 ? { anchorMessageId: messageIds[0] } : {}),
    ...(requested.scope === 'reply' && recipients.length === 1
      ? { expectedRecipientEmail: recipients[0] } : {}),
    ...(senders.length === 1 ? { expectedSenderEmail: senders[0] } : {}),
    ...(cc !== undefined ? { expectedCc: cc } : {}),
    ...(subjects.length === 1 ? { expectedSubject: subjects[0] } : {}),
    ...(body !== undefined ? { expectedBody: body, expectedIsHtml: false } : {}),
  };
}

/**
 * Narrow capability for replacing a separate Gmail anchor read. This is
 * intentionally stricter than the general exact-effect expectation: the same
 * authenticated objective must close every externally visible field of one
 * recipient-bound plain-text reply and require exact-effect reconciliation.
 */
export function contextualGmailClosedExactEffectExpectationFromObjective(
  objectiveSegments: readonly string[],
): ContextualGmailExactEffectExpectation | undefined {
  const requested = contextualGmailReplyObjective(objectiveSegments);
  if (!requested
    || !requested.requiresExactEffectReconciliation
    || !hasClosedExactContextualGmailReplyContract(requested)) return undefined;
  const expectation = contextualGmailExactEffectExpectationFromObjective(objectiveSegments);
  return expectation?.scope === 'reply'
    && expectation.anchorMessageId !== undefined
    && expectation.expectedRecipientEmail !== undefined
    && expectation.expectedSenderEmail !== undefined
    && expectation.expectedCc === ''
    && expectation.expectedSubject !== undefined
    && expectation.expectedBody !== undefined
    && expectation.expectedIsHtml === false
    ? expectation
    : undefined;
}
