import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import type { UserInputRequest } from '@craft-agent/core';
import type { Message } from '@craft-agent/core/types';
import type { perf } from '@craft-agent/shared/utils';
import type { ManagedSession } from '../managed-session.ts';
import type { AgentInstance } from '../runtime-types.ts';

export interface RuntimePreparationInput {
    readonly managed: ManagedSession;
    readonly activeMessageState: SessionMessageState;
    readonly userMessage: Message;
    readonly trustedUserInput: UserInputRequest | undefined;
    readonly sessionOperationContext: SessionOperationContext;
    readonly assertActivePreparation: () => void;
    readonly sendSpan: ReturnType<typeof perf.span>;
    readonly sessionId: string;
    readonly myGeneration: number;
    readonly hasSources: boolean;
    readonly workspaceRootPath: string;
    readonly enabledSlugs: string[];
    readonly ownsActiveTurn: () => boolean;
    readonly cleanRecoveryProviderReset: boolean;
    readonly trustedContextLimitAnswer: UserInputRequest | undefined;
    readonly finishSupersededDelegatedDispatch: () => Promise<void>;
    readonly finishSupersededAuthenticatedInternalContinuation: () => Promise<void>;
    readonly finishSupersededAutomaticRecovery: () => Promise<boolean>;
    readonly finishSupersededSourceActivation: () => Promise<void>;
    readonly finishCancelledPreparation: () => Promise<void>;
    readonly finishDeferredPreparation: () => Promise<void>;
    readonly contextLimitAnswerSetupRollback: (() => string | undefined) | undefined;
    readonly removeSyntheticAutomaticMessage: () => boolean;
    readonly rollbackQueuedAgentDeliveryPreparation: (reason: string, setupError?: unknown) => Promise<boolean>;
    readonly cleanExplicitRetry: boolean;
    readonly cleanExplicitRetrySetupRollback: (() => string | undefined) | undefined;
    readonly restoreStartedAutomaticDispatch: () => boolean;
}

export interface PreparedAgentRuntime {
    readonly agent: AgentInstance;
    readonly cleanRecoveryHandoffPrompt: boolean;
}
