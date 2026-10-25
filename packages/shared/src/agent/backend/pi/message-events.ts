import { AGENT_RUNTIME_ACTIVITY } from '@craft-agent/core/types';
import type { AgentEvent as CraftAgentEvent, AgentModelProvenance } from '@craft-agent/core/types';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent, Usage } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai';

export interface PiMessageState {
  hasStreamedDeltas: boolean;
  composingActivity: boolean;
  lastComposingActivityAt: number;
  hasEmittedFinalText: boolean;
  subTurnCounter: number;
  messageSubTurnId: string | null;
  contextWindow?: number;
  turnUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    contextTokens: number;
  };
  heldRetryError: string | null;
  contextOverflowError: boolean;
}

export function createPiMessageState(): PiMessageState {
  return {
    hasStreamedDeltas: false, composingActivity: false, lastComposingActivityAt: 0,
    hasEmittedFinalText: false, subTurnCounter: 0, messageSubTurnId: null,
    heldRetryError: null, contextOverflowError: false,
  };
}

function clearPendingMessageError(state: PiMessageState): void {
  state.heldRetryError = null;
  state.contextOverflowError = false;
}

/** Translate one SDK message while retaining turn usage and streaming state. */
export function* adaptPiMessageEvent(
  event: Extract<AgentSessionEvent, { type: 'message_start' | 'message_update' | 'message_end' }>,
  state: PiMessageState,
  turnId: string | null,
): Generator<CraftAgentEvent> {
  switch (event.type) {
case 'message_start':
        // The SDK starts an assistant message when the provider call begins.
        // Expose the phase, never its thinking content or encrypted signature.
        if (event.message?.role === 'assistant' && !state.composingActivity) {
          state.composingActivity = true;
          state.lastComposingActivityAt = Date.now();
          yield { type: 'status', message: AGENT_RUNTIME_ACTIVITY.composingResponse };
        }
        break;
case 'message_update': {
        // Pi SDK emits message_update only for assistant messages (streaming deltas)
        const amEvent: AssistantMessageEvent = event.assistantMessageEvent;
        if (
          amEvent.type === 'thinking_start'
          || amEvent.type === 'thinking_delta'
          || amEvent.type === 'toolcall_start'
          || amEvent.type === 'toolcall_delta'
        ) {
          const now = Date.now();
          if (!state.composingActivity || now - state.lastComposingActivityAt >= 30_000) {
            state.composingActivity = true;
            state.lastComposingActivityAt = now;
            yield { type: 'status', message: AGENT_RUNTIME_ACTIVITY.composingResponse };
          }
        }
        if (amEvent.type === 'text_delta' && amEvent.delta) {
          state.composingActivity = false;
          state.lastComposingActivityAt = Date.now();
          state.hasStreamedDeltas = true;
          if (!state.messageSubTurnId) {
            state.messageSubTurnId = nextSubTurnId(state, turnId, 'm');
          }
          yield {
            type: 'text_delta',
            text: amEvent.delta,
            turnId: state.messageSubTurnId,
          };
        }
        break;
      }
case 'message_end': {
        // Pi SDK emits message_end for ALL messages (user, assistant, toolResult).
        // Only process assistant messages — skip user prompts and tool results.
        const msg = event.message as {
          role?: string;
          stopReason?: string;
          errorMessage?: string;
          usage?: Usage;
          id?: string;
          model?: string;
          responseModel?: string;
          provider?: string;
          api?: string;
          customType?: string;
          content?: unknown;
          details?: { schemaVersion?: unknown; toolCallId?: unknown };
        } | undefined;
        // Host guidance has its own SDK message, never part of a tool receipt
        // or an assistant final. Unknown custom messages remain ignored.
        if (msg?.role === 'custom' && msg.customType === 'robb-tool-loop-hint'
          && msg.details?.schemaVersion === 1 && typeof msg.details.toolCallId === 'string'
          && msg.details.toolCallId.length > 0 && typeof msg.content === 'string'
          && msg.content.length > 0 && msg.content.length <= 2048) {
          yield { type: 'info', message: msg.content };
          break;
        }
        // SDK message id, set by pi-agent-server when forwarding the event.
        // SessionManager uses this to correlate the follow-up `pi_turn_anchor`
        // event to the Craft assistant message created here (#782).
        const sdkMessageId = (event as { sdkMessageId?: string }).sdkMessageId ?? msg?.id;
        if (msg?.role !== 'assistant') break;
        state.composingActivity = false;
        const modelProvenance = getModelProvenance(state, msg);

        // Record usage before branching on stopReason so failed/retried calls
        // are included in the final billed total as well. Per-message
        // usage_update events below intentionally remain non-cumulative.
        if (msg.usage && typeof msg.usage.input === 'number') {
          accumulateUsage(state, msg.usage);
        }

        // Surface API errors — Pi SDK sets stopReason: 'error' and errorMessage on failures
        if (msg.stopReason === 'error' && msg.errorMessage) {
          // Craft 8df01c5: failed partials must not survive into a retried response.
          if (state.messageSubTurnId) {
            yield { type: 'text_discard', turnId: state.messageSubTurnId };
            state.messageSubTurnId = null;
            state.hasStreamedDeltas = false;
          }
          state.contextOverflowError = isContextOverflow(event.message as AssistantMessage, state.contextWindow);
          state.heldRetryError = msg.errorMessage;
          break;
        }
        // A successful retry supersedes the buffered attempt error.
        clearPendingMessageError(state);

        // Extract text content from the final assistant message
        const textContent = extractTextFromMessage(event.message);
        // Pi SDK stopReason: 'toolUse' means the model will call tools next (intermediate commentary),
        // 'stop'/'end_turn' means final response. Same logic as Claude's stop_reason === 'tool_use'.
        const isIntermediate = msg.stopReason === 'toolUse';
        if (textContent && (isIntermediate || !state.hasEmittedFinalText)) {
          if (!isIntermediate) state.hasEmittedFinalText = true;

          const mTurnId = state.messageSubTurnId || nextSubTurnId(state, turnId, 'm');
          state.messageSubTurnId = null;

          yield {
            type: 'text_complete',
            text: textContent,
            isIntermediate,
            turnId: mTurnId,
            sdkMessageId,
            ...(modelProvenance ? { modelProvenance } : {}),
          };
          state.hasStreamedDeltas = false;
        }

        // Emit usage_update if the assistant message includes token usage
        if (msg.usage && typeof msg.usage.input === 'number') {
          const inputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          yield {
            type: 'usage_update',
            usage: {
              inputTokens,
              contextWindow: state.contextWindow,
            },
          };
        }
        break;
      }
  }
}

function nextSubTurnId(state: PiMessageState, turnId: string | null, prefix: string): string {
    const base = turnId || 'unknown';
    return `${base}__${prefix}${state.subTurnCounter++}`;
  }

function accumulateUsage(state: PiMessageState, usage: Usage): void {
    const totals = state.turnUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      contextTokens: 0,
    };

    const currentContextTokens = usage.input + (usage.cacheRead || 0);
    totals.inputTokens += currentContextTokens;
    totals.outputTokens += usage.output;
    totals.cacheReadTokens += usage.cacheRead || 0;
    totals.cacheCreationTokens += usage.cacheWrite || 0;
    totals.costUsd += usage.cost.total;
    totals.contextTokens = currentContextTokens;
    state.turnUsage = totals;
  }

function getModelProvenance(state: PiMessageState, message: {
    model?: string;
    responseModel?: string;
    provider?: string;
    api?: string;
  }): AgentModelProvenance | undefined {
    const requestedModel = message.model || undefined;
    const model = message.responseModel || requestedModel;
    const provider = message.provider || undefined;
    const api = message.api || undefined;
    const contextWindow = state.contextWindow;

    if (!model && !requestedModel && !provider && !api && contextWindow === undefined) {
      return undefined;
    }

    return {
      ...(model ? { model } : {}),
      ...(requestedModel ? { requestedModel } : {}),
      ...(provider ? { provider } : {}),
      ...(api ? { api } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  }

function extractTextFromMessage(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;

    const msg = message as {
      role?: string;
      content?: string | Array<{ type: string; text?: string }>;
    };

    if (typeof msg.content === 'string') {
      return msg.content || null;
    }

    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      return textParts.length > 0 ? textParts.join('') : null;
    }

    return null;
  }
