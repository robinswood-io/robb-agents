import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SessionManager } from '@earendil-works/pi-coding-agent';

/** turn_end is emitted after the assistant and its tool receipts are persisted. */
export function findSdkTurnAnchor(
  journal: Pick<SessionManager, 'getLeafId' | 'getEntry'>,
  message: AssistantMessage,
): string | undefined {
  let id = journal.getLeafId();
  while (id) {
    const entry = journal.getEntry(id);
    if (!entry) return;
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      return entry.message.timestamp === message.timestamp
        && (!message.responseId || entry.message.responseId === message.responseId)
        ? entry.id : undefined;
    }
    id = entry.parentId;
  }
  return undefined;
}
