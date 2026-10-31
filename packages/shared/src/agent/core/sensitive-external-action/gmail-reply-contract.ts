import { contextualGmailHasStrictClosedFields, contextualGmailResolvedConstraints } from './gmail-reply-constraints.ts';
import type { ContextualGmailReplyObjective } from './gmail-reply-parsing.ts';

export function hasClosedExactContextualGmailReplyContract(
  objective: ContextualGmailReplyObjective,
): boolean {
  const constraints = contextualGmailResolvedConstraints(objective);
  return objective.scope === 'reply'
    && !constraints.invalid
    && contextualGmailHasStrictClosedFields(objective.rawRequest)
    && constraints.messageIds.length === 1
    && constraints.recipients.length === 1
    && constraints.senders.length === 1
    && constraints.subjects.length === 1
    && constraints.cc === ''
    && constraints.body !== undefined;
}
