import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import type { UserInputRequest } from '@craft-agent/core';
import type { FileAttachment } from '@craft-agent/shared/protocol';
import type { Message, StoredAttachment } from '@craft-agent/core/types';
import type { ManagedSession } from '../managed-session.ts';
import type { SourceActivationOrigin } from '../source-activation.ts';

export interface UserMessagePreparationInput {
    readonly managed: ManagedSession;
    readonly existingMessageId: string | undefined;
    readonly supersedableAutomaticRecovery: boolean;
    readonly activeMessageState: SessionMessageState;
    readonly sessionOperationContext: SessionOperationContext;
    readonly explicitRetry: boolean;
    readonly trustedUserInput: UserInputRequest | undefined;
    readonly explicitRetryAllowanceToken: symbol | undefined;
    readonly ownsActiveTurn: () => boolean;
    readonly sessionId: string;
    readonly myGeneration: number;
    readonly assertAuthenticatedInternalContinuation: () => void;
    readonly durableMessageId: () => string;
    readonly storedAttachments: StoredAttachment[] | undefined;
    readonly cleanExplicitRetry: boolean;
    readonly explicitRetryIntent: ReturnType<SessionOperationContext['state']['explicitRetryAllowanceTokens']['get']>;
    readonly diagnosticFromMessageCount: number;
    readonly explicitRetryContextLimitRequest: UserInputRequest | undefined;
    readonly resetProviderResumeStateForCleanBoundary: (boundaryMessageId: string) => void;
    readonly explicitRetryContextLimitRequestBefore: Pick<UserInputRequest, "status" | "answeredAt"> | undefined;
    readonly authenticatedSourceActivation: boolean;
    readonly sourceActivationDispatchToken: symbol | undefined;
    readonly removeSyntheticAutomaticMessage: () => boolean;
    readonly sourceActivationOrigin: SourceActivationOrigin | undefined;
    readonly restoreStartedAutomaticDispatch: () => boolean;
    readonly queuedItem: ManagedSession['messageQueue'][number] | undefined;
    readonly attachments: FileAttachment[] | undefined;
    readonly abandonStoppedTurn: () => Promise<void>;
    readonly directHumanContinuation: boolean;
    readonly directHumanStopWon: () => boolean;
    readonly freshAgentDeliveryStopWon: () => boolean;
    readonly lastMessageRoleBeforeDispatch: "user" | "assistant" | "plan" | "tool" | "error" | undefined;
    readonly stoppedFreshAgentDeliveryError: () => Error;
    readonly stoppedDirectHumanError: () => Error;
    readonly sourceActivationStillCurrent: () => boolean;
    readonly onAck: ((messageId: string) => void) | undefined;
    readonly finishSupersededAutomaticRecovery: () => Promise<boolean>;
}

export interface PreparedUserMessage {
    readonly userMessage: Message;
    readonly existingTurnRollback: (() => void) | undefined;
    readonly cleanExplicitRetrySetupRollback: (() => string | undefined) | undefined;
    readonly durablyAcknowledged: boolean;
    readonly cleanRecoveryProviderStateAtomized: boolean;
}
