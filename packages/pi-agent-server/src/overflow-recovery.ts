/**
 * Keep the fallback summary focused on the durable state needed to resume the
 * current task. Raw tool output and repeated transcript text are the usual
 * source of a second context overflow, so the fallback explicitly drops them.
 */
export const OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS = [
  'Create a precise, fact-preserving operational handoff for continuing the current task.',
  'Preserve the user goal, verified facts and evidence, decisions, user constraints, negative findings,',
  'exact file paths, identifiers, values, tests, completed external effects, pending approvals, blockers, and the next safe action.',
  'Distinguish verified facts from hypotheses and do not invent details.',
  'Discard repeated progress chatter, acknowledgements, superseded attempts, raw tool output, and non-essential prose.',
].join(' ');

type ContinuationMessage = {
  role: string;
  stopReason?: string;
};

/**
 * Manual compaction rebuilds the in-memory transcript from the session journal,
 * which can restore the terminal assistant overflow error. Agent.continue()
 * requires the transcript to end with a user/tool-result message, so mirror the
 * Pi SDK's native overflow recovery and remove only that trailing error.
 */
export function prepareMessagesForOverflowContinuation<T extends ContinuationMessage>(
  messages: T[],
): { messages: T[]; removedTrailingError: boolean } {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.stopReason === 'error') {
    return {
      messages: messages.slice(0, -1),
      removedTrailingError: true,
    };
  }
  return { messages, removedTrailingError: false };
}

/** The caller claims its single fallback attempt before entering this sequence. */
export async function recoverContextOverflow<T extends ContinuationMessage>(session: {
  waitForIdle(): Promise<void>;
  compact(instructions: string): Promise<unknown>;
  agent: { state: { messages: T[] }; continue(): Promise<void> };
}): Promise<void> {
  await session.waitForIdle();
  await session.compact(OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS);
  const prepared = prepareMessagesForOverflowContinuation(session.agent.state.messages);
  if (prepared.removedTrailingError) session.agent.state.messages = prepared.messages;
  await session.agent.continue();
  await session.waitForIdle();
}
