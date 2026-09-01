import type { SendMessageOptions } from '@craft-agent/shared/protocol';

export interface InternalQueuedMessage {
  message: string;
  options?: SendMessageOptions;
  messageId?: string;
}

export function selectInternalMessageCoalesceTarget<T extends InternalQueuedMessage>(
  queue: T[],
  senderSessionId: string | undefined,
  maxQueuedMessages: number,
): T | undefined {
  const reverseQueue = [...queue].reverse();
  const sameSender = reverseQueue.find(item =>
    item.options?.internalOrigin?.senderSessionId === senderSessionId
  );
  if (sameSender) return sameSender;
  if (queue.length < Math.max(1, maxQueuedMessages)) return undefined;
  return reverseQueue.find(item => item.options?.internalOrigin);
}

export function appendCoalescedInternalMessage(target: InternalQueuedMessage, message: string): void {
  target.message = `${target.message}\n\n[Coalesced update]\n${message}`;
}
