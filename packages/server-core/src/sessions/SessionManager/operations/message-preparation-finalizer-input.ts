import type { Message } from '@craft-agent/core/types';
import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import type { FileAttachment } from '@craft-agent/shared/protocol';
import type { StoredAttachment } from '@craft-agent/core/types';
import type { perf } from '@craft-agent/shared/utils';
import type { ManagedSession } from '../managed-session.ts';
import type { SourceActivationOrigin } from '../source-activation.ts';

export interface MessagePreparationFinalizerInput {
    readonly ownsActiveTurn: () => boolean;
    readonly sessionOperationContext: SessionOperationContext;
    readonly sessionId: string;
    readonly restoreStartedAutomaticDispatch: () => boolean;
    readonly userMessage: Message;
    readonly deliveryAttemptsBeforePreparation: number | undefined;
    readonly managed: ManagedSession;
    readonly myGeneration: number;
    readonly queuedItem: ManagedSession['messageQueue'][number] | undefined;
    readonly activeMessageState: SessionMessageState;
    readonly attachments: FileAttachment[] | undefined;
    readonly storedAttachments: StoredAttachment[] | undefined;
    readonly sendSpan: ReturnType<typeof perf.span>;
    readonly abandonStoppedTurn: () => Promise<void>;
    readonly sourceActivationOrigin: SourceActivationOrigin | undefined;
    readonly authenticatedInternalContinuationToken: symbol | undefined;
    readonly existingMessageId: string | undefined;
    readonly existingTurnRollback: (() => void) | undefined;
    readonly delegatedDispatchContinuationToken: symbol | undefined;
}
