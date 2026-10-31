import type { SessionMessageState } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';

export interface MessageSourceActivationClaimInput {
    readonly activeMessageState: SessionMessageState;
    readonly existingMessageId: string | undefined;
    readonly queuedDispatchToken: symbol | undefined;
    readonly managed: ManagedSession;
    readonly sourceActivationDispatchToken: symbol | undefined;
    readonly sessionId: string;
}
