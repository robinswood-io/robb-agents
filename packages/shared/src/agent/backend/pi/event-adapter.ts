/**
 * Pi SDK Event Adapter
 *
 * Maps Pi Agent Core events (AgentEvent / AgentSessionEvent) to
 * Craft Agent's AgentEvent format for UI compatibility.
 *
 * Pi emits fine-grained lifecycle events. We translate them into
 * the same event vocabulary the renderer already understands from
 * Claude / Codex / Copilot backends.
 */

import type {
  AgentEvent as CraftAgentEvent,
  ToolExecutionCheckpoint,
} from '@craft-agent/core/types';
import type {
  AgentEvent as PiAgentEvent,
} from '@earendil-works/pi-agent-core';
import type {
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { parseError } from '../../errors.ts';
import { parseReadCommand } from '../read-patterns.ts';
import { adaptPiMessageEvent, createPiMessageState } from './message-events.ts';
import { extractToolMetadataFromEvent, resolveStoredMetadata, normalizeToolInput, resolveToolName, extractToolResult, getToolDisplayName } from './tool-event-payloads.ts';

const OVERFLOW_RECOVERY_EXHAUSTED_MESSAGE =
  'Context is still too large after automatic compaction. Start a new chat, shorten the current input, or remove large attachments.';

/**
 * Combined event type the adapter can handle.
 * AgentSessionEvent is a superset of PiAgentEvent (adds compaction_*, auto_retry_*, queue_update).
 */
type PiEvent = PiAgentEvent | AgentSessionEvent;

/**
 * Maps Pi SDK events to Craft AgentEvents for UI compatibility.
 *
 * Event mapping:
 * - message_update (text_delta in assistantMessageEvent) → text_delta
 * - message_end → text_complete
 * - tool_execution_start → tool_start
 * - tool_execution_end → tool_result
 * - agent_settled → complete (after the worker finishes all SDK work)
 * - compaction_start → status (with "Compacting" keyword)
 * - compaction_end → info/error
 * - auto_retry_start → status
 * - auto_retry_end → status
 * - queue_update → ignored (no current UI consumer)
 */
export class PiEventAdapter extends BaseEventAdapter {
  private messageState = createPiMessageState();
  // Track tool names from execution_start for proper tool_result correlation
  private toolNames: Map<string, string> = new Map();
  // Preserve the exact normalized execution input until the terminal event so
  // host-side capability receipts can be correlated to the call that minted
  // them. Pi's terminal SDK event otherwise carries only the call id/result.
  private toolInputs: Map<string, Record<string, unknown>> = new Map();
  // A repeated id has no occurrence nonce in Pi terminal events. Once seen,
  // discard correlation for every terminal carrying that id until teardown.
  private poisonedToolCallIds: Set<string> = new Set();

  // Selected session model ID for call_llm display default (#596).
  // Used when the caller didn't specify an explicit model — we fill args.model
  // on the tool_start event so the UI shows the effective default instead of
  // leaving the badge blank.
  private callLlmModel: string | undefined;
  private nativeTurnComplete = false;

  constructor() {
    super('pi-event');
  }

  /**
   * Set the model's context window size for usage reporting.
   */
  setContextWindow(cw: number): void {
    this.messageState.contextWindow = cw;
  }

  /**
   * Set the selected session model ID for call_llm badge default.
   * When the agent's call_llm invocation omits `args.model`, we fill it with
   * this so the UI badge shows the effective default instead of nothing.
   * Explicit `args.model` values from the agent are always preserved.
   */
  resetRuntimeState(): void {
    this.messageState.composingActivity = false;
    this.toolNames.clear();
    this.toolInputs.clear();
    this.poisonedToolCallIds.clear();
    this.nativeTurnComplete = false;
    this.clearPendingError();
  }

  clearPendingError(): void {
    this.messageState.heldRetryError = null;
    this.messageState.contextOverflowError = false;
  }

  setCallLlmModel(model: string | undefined): void {
    this.callLlmModel = model;
  }

  protected onTurnStart(): void {
    this.messageState.composingActivity = false;
    this.toolNames.clear();
    this.toolInputs.clear();
    this.messageState.hasStreamedDeltas = false;
    this.messageState.hasEmittedFinalText = false;
    this.messageState.subTurnCounter = 0;
    this.messageState.messageSubTurnId = null;
    this.clearPendingError();
    this.nativeTurnComplete = false;
    this.messageState.turnUsage = undefined;
    this.log.debug('Turn started', { turnIndex: this.turnIndex });
  }

  private adaptAssistantError(errorMessage: string): CraftAgentEvent {
    const parsed = parseError(new Error(errorMessage));
    return parsed.code === 'unknown_error'
      ? { type: 'error', message: errorMessage }
      : { type: 'typed_error', error: parsed };
  }

  /**
   * Adapt a Pi SDK event to zero or more Craft AgentEvents.
   */
  *adaptEvent(event: PiEvent): Generator<CraftAgentEvent> {
    // The worker pairs each assistant event with the exact persisted turn
    // anchor after turn_end. sdkMessageId is an opaque transport correlation.
    if ((event as { type?: string }).type === 'pi_turn_anchor') {
      const e = event as unknown as { sdkMessageId?: string; sdkTurnAnchor?: string };
      if (e.sdkMessageId && e.sdkTurnAnchor) {
        yield {
          type: 'pi_turn_anchor',
          sdkMessageId: e.sdkMessageId,
          sdkTurnAnchor: e.sdkTurnAnchor,
        };
      }
      return;
    }

    switch (event.type) {
      // ============================================================
      // Agent lifecycle events
      // ============================================================

      case 'agent_start':
        this.messageState.hasEmittedFinalText = false;
        break;

      case 'agent_end':
        // Attempt-level SDK events never finish the host turn.
        break;

      case 'agent_settled':
        if (this.nativeTurnComplete) break;
        this.nativeTurnComplete = true;
        this.messageState.composingActivity = false;
        if (!event.aborted && this.messageState.heldRetryError) {
          yield this.adaptAssistantError(this.messageState.contextOverflowError
            ? OVERFLOW_RECOVERY_EXHAUSTED_MESSAGE : this.messageState.heldRetryError);
        }
        this.clearPendingError();
        yield this.messageState.turnUsage
          ? { type: 'complete', usage: { ...this.messageState.turnUsage, contextWindow: this.messageState.contextWindow } }
          : { type: 'complete' };
        break;

      // ============================================================
      // Turn events
      // ============================================================

      case 'turn_start':
        this.messageState.hasEmittedFinalText = false;
        // Pi SDK turn_start has no ID, so generate one for event correlation
        this.currentTurnId = `pi-turn-${this.turnIndex}`;
        break;

      case 'turn_end':
        // Only the worker's settled event closes the turn after deferred work.
        this.currentTurnId = null;
        this.messageState.hasStreamedDeltas = false;
        this.messageState.hasEmittedFinalText = false;
        this.messageState.subTurnCounter = 0;
        this.messageState.messageSubTurnId = null;
        break;

      // ============================================================
      // Message events (text streaming)
      // ============================================================

      case 'message_start':
      case 'message_update':
      case 'message_end':
        yield* adaptPiMessageEvent(event, this.messageState, this.currentTurnId);
        break;





      // ============================================================
      // Tool events
      // ============================================================

      case 'tool_execution_start': {
        this.messageState.composingActivity = false;
        const toolCallId = event.toolCallId;
        const toolName = resolveToolName(event.toolName);

        // Normalize Pi field names to Claude Code format for UI compatibility
        // (diff stats, diff overlay, document routing all expect Claude Code format)
        const args = normalizeToolInput(toolName, (event.args ?? {}) as Record<string, unknown>);
        if (this.toolNames.has(toolCallId)
          || this.toolInputs.has(toolCallId)
          || this.poisonedToolCallIds.has(toolCallId)) {
          this.poisonedToolCallIds.add(toolCallId);
          this.toolNames.delete(toolCallId);
          this.toolInputs.delete(toolCallId);
        } else {
          this.toolNames.set(toolCallId, toolName);
          this.toolInputs.set(toolCallId, args);
        }

        // For call_llm, fill in the default display model when the caller didn't
        // specify one — Pi's call_llm defaults to callLlmModel. We only fill the gap;
        // we never overwrite an explicit agent-provided model (that was the #596 bug).
        if (toolName.includes('call_llm') && this.callLlmModel && !args.model) {
          args.model = this.callLlmModel;
        }

        // Canonical metadata from subprocess event payload (interceptor/bridge-authoritative path).
        const eventMeta = extractToolMetadataFromEvent(event);

        // Backward-compatibility fallback: shared store (legacy side-channel),
        // with id canonicalization fallback for mixed call-id formats.
        const { meta: storedMeta, keyTried } = resolveStoredMetadata(toolCallId, this.sessionDir);

        // Last-resort fallback: args metadata if present.
        const argsIntent = typeof args._intent === 'string' ? args._intent : undefined;
        const argsDisplayName = typeof args._displayName === 'string' ? args._displayName : undefined;

        const intent = eventMeta?.intent
          || storedMeta?.intent
          || argsIntent
          || (typeof args.description === 'string' ? args.description : undefined);

        const displayName = eventMeta?.displayName
          || storedMeta?.displayName
          || argsDisplayName
          || getToolDisplayName(toolName);

        const metadataSource = eventMeta
          ? 'event'
          : storedMeta
            ? `store(${keyTried})`
            : (argsIntent || argsDisplayName)
              ? 'args'
              : (typeof args.description === 'string')
                ? 'description'
                : 'fallback';

        this.log.debug('Tool metadata resolution', {
          toolName,
          toolCallId,
          metadataSource,
          hasIntent: !!intent,
          hasDisplayName: !!displayName,
        });

        // A read-like shell command is still a Bash invocation. Pi emits this
        // event before PreToolUse's durable admission, so changing its identity
        // to Read makes the host reject its own live receipt as a reused id.
        // Keep the executed name/input throughout the lifecycle; classify only
        // the display label, never the evidence or admission identity.
        const isReadCommand = toolName === 'Bash'
          && typeof args.command === 'string'
          && parseReadCommand(args.command) !== null;

        yield this.createToolStart(
          toolCallId,
          toolName,
          args,
          intent,
          isReadCommand ? 'Read File' : displayName,
        );
        break;
      }

      case 'tool_execution_update': {
        // Pi updates are cumulative snapshots, not deltas. Keep only the latest
        // snapshot as a fallback when the terminal event has no result.
        const partialResult = event.partialResult;
        if (partialResult && typeof partialResult === 'object') {
          const content = (partialResult as { content?: Array<{ type: string; text?: string }> }).content;
          if (Array.isArray(content)) {
            this.commandOutput.set(event.toolCallId, content
              .filter(part => part.type === 'text' && typeof part.text === 'string')
              .map(part => part.text!)
              .join('\n'));
          }
        }
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId;
        const poisonedToolCallId = this.poisonedToolCallIds.has(toolCallId);
        const resolvedToolName = poisonedToolCallId
          ? 'tool'
          : this.toolNames.get(toolCallId) || 'tool';
        this.toolNames.delete(toolCallId);
        const resolvedToolInput = poisonedToolCallId
          ? undefined
          : this.toolInputs.get(toolCallId);
        this.toolInputs.delete(toolCallId);

        // Check for block reason
        const blockReason = this.consumeBlockReason(toolCallId, resolvedToolName);

        // Drain the snapshot even when a final result or block takes precedence.
        const partialOutput = this.consumeOutput(toolCallId);

        const details = event.result && typeof event.result === 'object'
          ? (event.result as {
              details?: {
                isError?: unknown;
                continuationRequired?: unknown;
                costControlBlocked?: unknown;
                executed?: unknown;
                checkpoint?: unknown;
              };
            }).details
          : undefined;
        // Defensive for direct/legacy SDK events: a structured tool failure
        // cannot become execution evidence just because execute() resolved.
        const isError = event.isError || details?.isError === true;
        const continuationRequired = details?.continuationRequired === true;
        const costControlBlocked = details?.costControlBlocked === true;
        const executed = details?.executed === false || costControlBlocked
          ? false
          : details?.executed === true
            ? true
            : undefined;
        let result: string;

        if (blockReason) {
          result = blockReason;
        } else if (event.result !== undefined && event.result !== null) {
          // The completed result includes the final output, truncation notices,
          // and execution errors. A streamed preview must never replace it.
          result = extractToolResult(event.result, isError);
        } else if (!isError && partialOutput !== undefined) {
          result = partialOutput;
        } else {
          result = extractToolResult(event.result, isError);
        }

        let checkpoint: ToolExecutionCheckpoint | undefined;
        const rawCheckpoint = details?.checkpoint;
        if (
          rawCheckpoint
          && typeof rawCheckpoint === 'object'
          && (rawCheckpoint as { kind?: unknown }).kind === 'tool-call-budget'
        ) {
          const reason = (rawCheckpoint as { reason?: unknown }).reason;
          checkpoint = {
            schemaVersion: 1,
            kind: 'tool-call-budget',
            reason: typeof reason === 'string' && reason.length > 0 ? reason : result,
          };
        } else if (rawCheckpoint === 'tool-call-budget' || costControlBlocked) {
          // Normalize results emitted by older packaged Pi runtimes.
          checkpoint = { schemaVersion: 1, kind: 'tool-call-budget', reason: result };
        }

        // After tool completion, the assistant may generate new text
        this.messageState.hasEmittedFinalText = false;
        this.messageState.messageSubTurnId = null;

        yield this.createToolResult(
          toolCallId,
          resolvedToolName,
          result,
          isError,
          undefined,
          continuationRequired,
          executed,
          checkpoint,
          resolvedToolInput,
        );
        break;
      }

      // ============================================================
      // Session-level events (AgentSessionEvent extensions)
      // ============================================================

      case 'compaction_start':
        this.messageState.composingActivity = false;
        yield { type: 'status', message: 'Compacting context...' };
        break;

      case 'compaction_end':
        if (event.result && !event.aborted) {
          yield { type: 'info', message: 'Compacted context to fit within limits' };
        } else if (event.errorMessage && !event.aborted) {
          this.messageState.heldRetryError ??= 'Context compaction failed: ' + event.errorMessage;
          this.messageState.contextOverflowError ||= event.reason === 'overflow';
        }
        break;

      case 'auto_retry_start':
        yield { type: 'status', message: 'Retrying (attempt ' + event.attempt + '/' + event.maxAttempts + ')...' };
        break;

      case 'auto_retry_end':
        if (event.success) this.clearPendingError();
        else if (event.finalError) this.messageState.heldRetryError = 'Retry failed: ' + event.finalError;
        break;

      case 'queue_update':
        // Queue contents are currently reflected by existing session/message state.
        // Ignore the event explicitly so newer Pi SDK sessions don't log noisy
        // "Unknown Pi event" warnings until we add a dedicated UI consumer.
        break;

      default:
        this.log.warn(`Unknown Pi event type: ${(event as { type: string }).type}`);
        break;
    }
  }
}
