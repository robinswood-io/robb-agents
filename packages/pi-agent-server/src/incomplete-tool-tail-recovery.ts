const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

type AgentEndMessage = {
  role?: string;
  stopReason?: string;
};

/**
 * Pi's `Agent.continue()` accepts tool-result/user tails, but rejects an
 * assistant tail even when that assistant was aborted mid-sentence. Remove
 * only that known-incomplete tail before continuation; terminal assistant
 * messages remain authoritative.
 */
export function prepareMessagesForIncompleteTailContinuation<T extends AgentEndMessage>(
  messages: T[],
): { messages: T[]; removedAbortedAssistant: boolean } {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'assistant' && lastMessage.stopReason === 'aborted') {
    return {
      messages: messages.slice(0, -1),
      removedAbortedAssistant: true,
    };
  }

  return { messages, removedAbortedAssistant: false };
}

export type IncompleteToolTailRecoveryResult =
  | 'none'
  | 'recovered'
  | 'aborted'
  | 'exhausted';

/**
 * Pi occasionally emits agent_end before the model has produced a final answer:
 * either immediately after a successful tool result, or with an unexpectedly
 * aborted assistant message containing only partial commentary. The SDK
 * considers both runs complete, so the caller otherwise receives `complete`
 * without a usable final answer.
 *
 * This state machine holds that premature agent_end and asks the caller to
 * resume from the recoverable persisted tail. Recovery is deliberately bounded
 * so a broken provider cannot create an infinite continuation loop.
 */
export class IncompleteToolTailRecovery {
  private activePromptCalls = 0;
  private abortRequested = false;
  private pendingIncompleteTail = false;
  private recoveryPromise: Promise<IncompleteToolTailRecoveryResult> | null = null;

  constructor(private readonly maxRecoveryAttempts = DEFAULT_MAX_RECOVERY_ATTEMPTS) {}

  beginPrompt(): void {
    if (this.activePromptCalls === 0) {
      this.abortRequested = false;
      this.pendingIncompleteTail = false;
    }
    this.activePromptCalls += 1;
  }

  endPrompt(): void {
    this.activePromptCalls = Math.max(0, this.activePromptCalls - 1);
    if (this.activePromptCalls === 0) {
      this.abortRequested = false;
      this.pendingIncompleteTail = false;
    }
  }

  requestAbort(): void {
    if (this.activePromptCalls > 0) {
      this.abortRequested = true;
    }
  }

  /** Return true when the caller must withhold this agent_end event. */
  shouldSuppressAgentEnd(messages: AgentEndMessage[] | undefined): boolean {
    if (this.activePromptCalls === 0 || !messages?.length) {
      return false;
    }

    if (this.abortRequested) {
      // The explicit abort's own agent_end is authoritative. If a premature
      // incomplete end was already held, this event replaces it.
      this.pendingIncompleteTail = false;
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    const endedAfterToolResult = lastMessage?.role === 'toolResult';
    const endedWithUnexpectedAssistantAbort =
      lastMessage?.role === 'assistant' && lastMessage.stopReason === 'aborted';

    if (!endedAfterToolResult && !endedWithUnexpectedAssistantAbort) {
      return false;
    }

    this.pendingIncompleteTail = true;
    return true;
  }

  async recover(
    continueTurn: () => Promise<void>,
  ): Promise<IncompleteToolTailRecoveryResult> {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (!this.pendingIncompleteTail) return 'none';

    this.recoveryPromise = this.runRecovery(continueTurn);
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  private async runRecovery(
    continueTurn: () => Promise<void>,
  ): Promise<IncompleteToolTailRecoveryResult> {
    let attempts = 0;

    while (this.pendingIncompleteTail) {
      if (this.abortRequested) {
        this.pendingIncompleteTail = false;
        return 'aborted';
      }
      if (attempts >= this.maxRecoveryAttempts) {
        this.pendingIncompleteTail = false;
        return 'exhausted';
      }

      this.pendingIncompleteTail = false;
      attempts += 1;
      await continueTurn();
      // A second incomplete agent_end will set pendingIncompleteTail again
      // while continueTurn() is running. A normal final response leaves it
      // false.
    }

    return attempts > 0 ? 'recovered' : 'none';
  }
}
