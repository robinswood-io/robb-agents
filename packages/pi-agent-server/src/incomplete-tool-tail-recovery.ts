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
 * Inspect the authoritative transcript only after SDK prompt and idle settle.
 * A tool-result tail or an unexpectedly aborted assistant can still require a
 * final response. Resume that persisted tail before reporting completion, with
 * bounded attempts so a broken provider cannot create an infinite loop.
 */
export class IncompleteToolTailRecovery {
  private activePromptCalls = 0;
  private abortRequested = false;
  private pendingIncompleteTail = false;
  private recoveryPromise: Promise<IncompleteToolTailRecoveryResult> | null = null;

  constructor(private readonly maxRecoveryAttempts = DEFAULT_MAX_RECOVERY_ATTEMPTS) {}

  beginPrompt(): boolean {
    const first = this.activePromptCalls === 0;
    if (this.activePromptCalls === 0) {
      this.abortRequested = false;
      this.pendingIncompleteTail = false;
    }
    this.activePromptCalls += 1;
    return first;
  }

  endPrompt(): boolean {
    this.activePromptCalls = Math.max(0, this.activePromptCalls - 1);
    if (this.activePromptCalls === 0) {
      this.abortRequested = false;
      this.pendingIncompleteTail = false;
    }
    return this.activePromptCalls === 0;
  }

  get isAbortRequested(): boolean { return this.abortRequested; }

  requestAbort(): void {
    if (this.activePromptCalls > 0) {
      this.abortRequested = true;
    }
  }

  /** Inspect the authoritative tail after the SDK has settled its run. */
  observeSettledTail(messages: AgentEndMessage[] | undefined): boolean {
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
      this.pendingIncompleteTail = false;
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
