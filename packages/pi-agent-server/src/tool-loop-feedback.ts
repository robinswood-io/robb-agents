import type { AgentSession, AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { ToolLoopDecision } from './tool-loop-budget.ts';

export const TOOL_LOOP_HINT_CUSTOM_TYPE = 'robb-tool-loop-hint';
export interface ToolLoopHintMessage {
  role: 'custom';
  customType: typeof TOOL_LOOP_HINT_CUSTOM_TYPE;
  content: string;
  display: true;
  timestamp: number;
  details: { schemaVersion: 1; toolCallId: string };
}
export interface ToolLoopFeedbackChannel {
  session: Pick<AgentSession, 'isStreaming' | 'agent'> | null;
  isCurrentSession: () => boolean;
  toolCallId: string;
  signal?: AbortSignal;
  onHint?: (message: ToolLoopHintMessage) => void;
  onError?: (error: unknown) => void;
}
interface FeedbackState {
  latest?: { signal: AbortSignal; isCurrentSession: () => boolean; message: ToolLoopHintMessage };
}
const feedbackStates = new WeakMap<object, FeedbackState>();

/**
 * Append at most one advisory to the next model context, never to a queue.
 * Pi can continue a nonempty steering queue after abort, so guidance must not
 * use sendCustomMessage/steer/followUp or change the durable tool transcript.
 */
function feedbackState(session: NonNullable<ToolLoopFeedbackChannel['session']>): FeedbackState {
  let state = feedbackStates.get(session);
  if (state) return state;
  state = {};
  feedbackStates.set(session, state);
  const current = state;
  const originalTransform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const transformed = originalTransform ? await originalTransform(messages, signal) : messages;
    const hint = current.latest;
    if (!hint || !signal || signal !== hint.signal || signal.aborted
      || !session.isStreaming || !hint.isCurrentSession()) return transformed;
    return [...transformed, hint.message];
  };
  return state;
}

// Agent snapshots transformContext at the beginning of a run, so install this
// before the first prompt, not only when a tool later reaches the hint threshold.
export function installToolLoopFeedback(session: NonNullable<ToolLoopFeedbackChannel['session']>): void {
  feedbackState(session);
}

/** Return the exact authoritative result; model/UI guidance travels separately. */
export async function finishToolLoopResult<T extends AgentToolResult<any>>(
  result: T, decision: ToolLoopDecision, channel: ToolLoopFeedbackChannel,
): Promise<T> {
  const { session, signal } = channel;
  if (decision.action === 'hint' && decision.message && !result.terminate && session?.isStreaming
    && signal && !signal.aborted && channel.isCurrentSession()) {
    try {
      const message: ToolLoopHintMessage = {
        role: 'custom', customType: TOOL_LOOP_HINT_CUSTOM_TYPE, content: decision.message, display: true,
        timestamp: Date.now(), details: { schemaVersion: 1, toolCallId: channel.toolCallId },
      };
      feedbackState(session).latest = { signal, isCurrentSession: channel.isCurrentSession, message };
      // The host persists this as info. It is not appended to SDK history and
      // can neither become evidence nor lend authority to a subsequent turn.
      channel.onHint?.(message);
    } catch (error) {
      try { channel.onError?.(error); } catch { /* Logging cannot erase a receipt. */ }
    }
  }
  return result;
}
