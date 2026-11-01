import type { SessionOperationContext } from '../operation-context.ts';
import type { UserInputRequest } from '@craft-agent/core';
import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol';
import type { StoredAttachment } from '@craft-agent/core/types';
import type { ManagedSession } from '../managed-session.ts';
import type { SourceActivationOrigin } from '../source-activation.ts';

export interface QueuedMessageInput {
  readonly existingMessageId: string | undefined;
  readonly trustedUserInput: UserInputRequest | undefined;
  readonly managed: ManagedSession;
  readonly message: string;
  readonly attachments: FileAttachment[] | undefined;
  readonly storedAttachments: StoredAttachment[] | undefined;
  readonly options: SendMessageOptions | undefined;
  readonly sessionOperationContext: SessionOperationContext;
  readonly queuedDispatchToken: symbol | undefined;
  readonly sessionId: string;
  readonly onAck: ((messageId: string) => void) | undefined;
  readonly waitingForInbox: boolean;
  readonly forceDirectHumanQueue: boolean;
  readonly durableMessageId: () => string;
  readonly deliveryId: string | undefined;
  readonly authenticatedSourceActivation: boolean;
  readonly sourceActivationDispatchToken: symbol | undefined;
  readonly stoppedFreshAgentDeliveryError: () => Error;
  readonly directHumanContinuation: boolean;
  readonly stoppedDirectHumanError: () => Error;
  readonly directHumanStopWon: () => boolean;
  readonly freshAgentDeliveryStopWon: () => boolean;
  readonly sourceActivationOrigin: SourceActivationOrigin | undefined;
  readonly sourceActivationStillCurrent: () => boolean;
  readonly queueCostLimitContinuationBehindDelivery: boolean;
}
