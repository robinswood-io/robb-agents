import type { Message } from '@craft-agent/core/types';
import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import type { UserInputRequest } from '@craft-agent/core';
import type { ManagedSession } from '../managed-session.ts';

export interface ObjectiveAdmissionInput {
    readonly managed: ManagedSession;
    readonly activeMessageState: SessionMessageState;
    readonly trustedUserInput: UserInputRequest | undefined;
    readonly sessionOperationContext: SessionOperationContext;
    readonly userMessage: Message;
    readonly localCompactCommand: boolean;
    readonly durablyAcknowledged: boolean;
    readonly ownsActiveTurn: () => boolean;
    readonly abandonStoppedTurn: () => Promise<void>;
    readonly explicitRetry: boolean;
    readonly cleanExplicitRetry: boolean;
    readonly resetProviderResumeStateForCleanBoundary: (boundaryMessageId: string) => void;
    readonly cleanRecoveryProviderStateAtomized: boolean;
    readonly sessionId: string;
    readonly queuedDispatchToken: symbol | undefined;
    readonly directHumanContinuation: boolean;
    readonly ownsQueuedDispatch: boolean;
    readonly queuedItem: ManagedSession['messageQueue'][number] | undefined;
    readonly rollbackQueuedAgentDeliveryPreparation: (reason: string, setupError?: unknown) => Promise<boolean>;
    readonly myGeneration: number;
    readonly removeSyntheticAutomaticMessage: () => boolean;
    readonly existingTurnRollback: (() => void) | undefined;
    readonly diagnosticFromMessageCount: number;
    readonly existingMessageId: string | undefined;
    readonly finishSupersededAutomaticRecovery: () => Promise<boolean>;
    readonly assertActivePreparation: () => void;
    readonly retryWithRetainedInbox: boolean;
    readonly onAck: ((messageId: string) => void) | undefined;
}

export interface AdmittedSessionObjective {
    readonly trustedContextLimitAnswer: UserInputRequest | undefined;
    readonly contextLimitAnswerSetupRollback: (() => string | undefined) | undefined;
    readonly cleanRecoveryProviderReset: boolean;
}
