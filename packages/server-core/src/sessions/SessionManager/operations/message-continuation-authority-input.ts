import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';

export interface MessageContinuationAuthorityInput {
    readonly directHumanContinuation: boolean;
    readonly sessionOperationContext: SessionOperationContext;
    readonly managed: ManagedSession;
    readonly activeMessageState: SessionMessageState;
    readonly authenticatedSourceActivation: boolean;
    readonly existingMessageId: string | undefined;
    readonly sourceActivationDispatchToken: symbol | undefined;
    readonly sourceActivationCancellationEpochAtEntry: number;
    readonly ownsQueuedDispatch: boolean;
    readonly queuedItem: ManagedSession['messageQueue'][number] | undefined;
    readonly sessionId: string;
}
