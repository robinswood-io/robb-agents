const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

type AgentEndMessage = {
  role?: string;
};

export type IncompleteToolTailRecoveryResult =
  | 'none'
  | 'recovered'
  | 'aborted'
  | 'exhausted';

/**
 * Pi occasionally emits agent_end immediately after a successful tool result,
 * without asking the model for the final assistant response. The SDK considers
 * that a normal end, so the caller otherwise receives `complete` with neither a
 * final answer nor an error.
 *
 * This state machine holds that premature agent_end and resumes from the
 * persisted tool result. Recovery is deliberately bounded so a broken provider
 * cannot create an infinite continuation loop.
 */
export class IncompleteToolTailRecovery {
  private activePromptCalls = 0;
  private abortRequested = false;
  private pendingToolTail = false;
  private recoveryPromise: Promise<IncompleteToolTailRecoveryResult> | null = null;

  constructor(private readonly maxRecoveryAttempts = DEFAULT_MAX_RECOVERY_ATTEMPTS) {}

  beginPrompt(): void {
    if (this.activePromptCalls === 0) {
      this.abortRequested = false;
      this.pendingToolTail = false;
    }
    this.activePromptCalls += 1;
  }

  endPrompt(): void {
    this.activePromptCalls = Math.max(0, this.activePromptCalls - 1);
    if (this.activePromptCalls === 0) {
      this.abortRequested = false;
      this.pendingToolTail = false;
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
      // tool-tail end was already held, this event replaces it.
      this.pendingToolTail = false;
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role !== 'toolResult') {
      return false;
    }

    this.pendingToolTail = true;
    return true;
  }

  async recover(
    continueTurn: () => Promise<void>,
  ): Promise<IncompleteToolTailRecoveryResult> {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (!this.pendingToolTail) return 'none';

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

    while (this.pendingToolTail) {
      if (this.abortRequested) {
        this.pendingToolTail = false;
        return 'aborted';
      }
      if (attempts >= this.maxRecoveryAttempts) {
        this.pendingToolTail = false;
        return 'exhausted';
      }

      this.pendingToolTail = false;
      attempts += 1;
      await continueTurn();
      // A second incomplete agent_end will set pendingToolTail again while
      // continueTurn() is running. A normal final response leaves it false.
    }

    return attempts > 0 ? 'recovered' : 'none';
  }
}
