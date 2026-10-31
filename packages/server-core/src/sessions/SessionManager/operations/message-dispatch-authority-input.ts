import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';

export interface MessageDispatchAuthorityInput {
    readonly existingMessageId: string | undefined;
    readonly queuedDispatchToken: symbol | undefined;
    readonly activeMessageState: SessionMessageState;
    readonly sessionOperationContext: SessionOperationContext;
    readonly sessionId: string;
    readonly managed: ManagedSession;
    readonly authenticatedInternalContinuationToken: symbol | undefined;
    readonly delegatedDispatchContinuationToken: symbol | undefined;
    readonly explicitRetryIntentAtEntry: ReturnType<SessionOperationContext['state']['explicitRetryAllowanceTokens']['get']>;
    readonly queuedItem: ManagedSession['messageQueue'][number] | undefined;
    readonly explicitRetryAllowanceToken: symbol | undefined;
}
