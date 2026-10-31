import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';

export interface MessageRetryAdmissionInput {
    readonly activeMessageState: SessionMessageState;
    readonly sessionOperationContext: SessionOperationContext;
    readonly managed: ManagedSession;
    readonly explicitRetryIntentAtEntry: ReturnType<SessionOperationContext['state']['explicitRetryAllowanceTokens']['get']>;
    readonly existingMessageId: string | undefined;
    readonly sessionId: string;
    readonly explicitRetryAllowanceToken: symbol | undefined;
}
