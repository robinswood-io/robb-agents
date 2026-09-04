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
  AgentModelProvenance,
} from '@craft-agent/core/types';
import type {
  AgentEvent as PiAgentEvent,
} from '@earendil-works/pi-agent-core';
import type {
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent, Usage } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { PI_TOOL_NAME_MAP } from './constants.ts';
import { toolMetadataStore } from '../../../interceptor-common.ts';
import { parseError } from '../../errors.ts';

/**
 * Pi SDK auto-compaction race signature — the AbortController crash described
 * in `_runAutoCompaction` (`@earendil-works/pi-coding-agent` agent-session.ts).
 * When two `_runAutoCompaction` calls overlap, one's `finally` clears the
 * shared `_autoCompactionAbortController` field while the other is still
 * suspended on an await; the next `.signal` read crashes. Matched against
 * `compaction_end.errorMessage` to surface a friendly message instead of the
 * raw stack until the upstream fix lands. See plans/fix-pi-gpt-compaction.md.
 */
const SDK_AUTOCOMPACT_RACE_SIGNATURE = /_autoCompactionAbortController\.signal/;

/** How long to wait after a held overflow `agent_end` for a `compaction_start`
 *  before giving up and surfacing the original error. The SDK fires
 *  `_checkCompaction` on the same event-queue tick, so the only delay is event
 *  serialization — 5 s is well above any plausible jitter. */
const OVERFLOW_FALLBACK_TIMEOUT_MS = 5_000;
const OVERFLOW_RECOVERY_START_TIMEOUT_MS = 20_000;

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
 * - agent_end → complete
 * - compaction_start → status (with "Compacting" keyword)
 * - compaction_end → info/error
 * - auto_retry_start → status
 * - auto_retry_end → status
 * - queue_update → ignored (no current UI consumer)
 */
export class PiEventAdapter extends BaseEventAdapter {
  // Track tool names from execution_start for proper tool_result correlation
  private toolNames: Map<string, string> = new Map();

  // Track whether streaming deltas have been received for the current message
  private hasStreamedDeltas: boolean = false;

  // Track whether a final (non-intermediate) text_complete has been emitted this turn
  private hasEmittedFinalText: boolean = false;

  // Sub-turnId isolation for tool calls within a single Pi turn
  private subTurnCounter: number = 0;
  private messageSubTurnId: string | null = null;

  // Model context window for usage_update events
  private contextWindow: number | undefined;

  // Mini model ID for call_llm display default (#596).
  // Used when the caller didn't specify an explicit model — we fill args.model
  // on the tool_start event so the UI shows the effective default instead of
  // leaving the badge blank.
  private miniModel: string | undefined;

  // Aggregate every assistant model call in the current Craft turn. A Pi agent
  // run can contain several SDK turns separated by tool calls, each with its own
  // usage. The final complete event must report the billed total for the run.
  private turnUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    contextTokens: number;
  } | undefined;

  // ============================================================
  // Overflow-recovery state machine
  // ============================================================
  //
  // When a Pi-routed assistant message returns a context_length_exceeded
  // error, the Pi SDK's `_checkCompaction` fires `_runAutoCompaction("overflow",
  // true)` and, on success, calls `agent.continue()` to retry. That recovered
  // turn arrives AFTER the original `agent_end`. If we yield `complete` and
  // call `eventQueue.complete()` on the original `agent_end` (the historic
  // behavior), the recovered turn lands in a closed iterator. The state
  // machine below holds the queue open across the SDK's recovery flow so the
  // recovered response reaches the UI.
  private overflowState: 'none' | 'held' | 'awaiting' | 'compacting' | 'recovering' = 'none';
  private heldOverflowError: string | null = null;
  private fallbackTimerId: ReturnType<typeof setTimeout> | null = null;
  /** One wrapper-managed compact-and-continue attempt is allowed after the
   * SDK recovery is skipped or hits its known transient race. This makes the
   * recovery bounded and prevents an infinite compact/retry loop. */
  private fallbackRecoveryAttempted: boolean = false;
  /** Set when the adapter wants the caller to call `eventQueue.complete()`
   *  on a non-`agent_end` event (e.g. `compaction_end` failure). Consumed by
   *  `shouldCompleteQueue()`. */
  private pendingQueueComplete: boolean = false;
  /** The SDK emits an `agent_end` for every failed attempt, including attempts
   *  it will retry. Keep the Craft queue open until the retry sequence reaches
   *  a successful response or a terminal failure. */
  private retryInProgress: boolean = false;
  private heldRetryError: string | null = null;
  private terminalRetryHandled: boolean = false;
  /** Caller-supplied callbacks for the asynchronous fallback timer path —
   *  the timer fires outside `adaptEvent()` so we can't yield through the
   *  generator. */
  private onFallbackEvent: ((event: CraftAgentEvent) => void) | null = null;
  private onFallbackComplete: (() => void) | null = null;
  private onFallbackRecover: (() => void | Promise<void>) | null = null;

  constructor() {
    super('pi-event');
  }

  /**
   * Set the model's context window size for usage reporting.
   */
  setContextWindow(cw: number): void {
    this.contextWindow = cw;
  }

  /**
   * Register handlers invoked when the overflow-recovery fallback timer fires
   * (the SDK didn't emit a `compaction_start` after a held overflow `agent_end`
   * within `OVERFLOW_FALLBACK_TIMEOUT_MS`). Adapter calls `onEvent` to enqueue
   * the buffered original error, then `onComplete` to terminate the iterator.
   * When `onRecover` is provided, the adapter asks the caller for one guarded
   * manual compact-and-continue attempt before surfacing an error.
   */
  setOverflowFallbackHandlers(
    onEvent: (event: CraftAgentEvent) => void,
    onComplete: () => void,
    onRecover?: () => void | Promise<void>,
  ): void {
    this.onFallbackEvent = onEvent;
    this.onFallbackComplete = onComplete;
    this.onFallbackRecover = onRecover ?? null;
  }

  /**
   * Decide whether the caller should call `eventQueue.complete()` after
   * processing this SDK event. The historical rule was "always on
   * `agent_end`"; with overflow recovery we defer completion until the
   * recovered turn finishes (or recovery fails / times out).
   */
  shouldCompleteQueue(isAgentEnd: boolean): boolean {
    if (this.pendingQueueComplete) {
      this.pendingQueueComplete = false;
      return true;
    }
    return isAgentEnd && this.overflowState === 'none' && !this.retryInProgress;
  }

  /**
   * Reset overflow-recovery state. Call from session disposal so a stale
   * fallback timer doesn't fire on a torn-down adapter.
   */
  resetOverflowState(): void {
    this.cancelOverflowFallbackTimer();
    this.overflowState = 'none';
    this.heldOverflowError = null;
    this.fallbackRecoveryAttempted = false;
    this.pendingQueueComplete = false;
    this.retryInProgress = false;
    this.heldRetryError = null;
    this.terminalRetryHandled = false;
  }

  private armOverflowFallbackTimer(timeoutMs = OVERFLOW_FALLBACK_TIMEOUT_MS): void {
    this.cancelOverflowFallbackTimer();
    this.fallbackTimerId = setTimeout(() => {
      this.fallbackTimerId = null;
      // Re-check state at fire time — a late `compaction_start` may have
      // already transitioned us to `compacting`.
      if (this.overflowState !== 'awaiting') return;
      if (this.startFallbackRecovery('SDK emitted no compaction events')) return;
      this.finishOverflowRecoveryFailure(
        this.fallbackRecoveryAttempted
          ? OVERFLOW_RECOVERY_EXHAUSTED_MESSAGE
          : (this.heldOverflowError ?? 'Context overflow'),
      );
    }, timeoutMs);
  }

  private startFallbackRecovery(reason: string): boolean {
    if (this.fallbackRecoveryAttempted || !this.onFallbackRecover) return false;

    this.fallbackRecoveryAttempted = true;
    this.cancelOverflowFallbackTimer();
    this.log.warn('Starting guarded overflow recovery fallback', { reason });

    // The callback may start an RPC asynchronously. Keep a second watchdog so
    // a lost command cannot leave the chat iterator open forever.
    Promise.resolve()
      .then(() => {
        if (this.overflowState !== 'awaiting') return;
        return this.onFallbackRecover?.();
      })
      .catch((error) => {
        if (this.overflowState !== 'awaiting') return;
        this.log.warn('Overflow recovery fallback could not start', {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        this.finishOverflowRecoveryFailure(OVERFLOW_RECOVERY_EXHAUSTED_MESSAGE);
      });
    this.armOverflowFallbackTimer(OVERFLOW_RECOVERY_START_TIMEOUT_MS);
    return true;
  }

  private finishOverflowRecoveryFailure(message: string): void {
    this.cancelOverflowFallbackTimer();
    this.heldOverflowError = null;
    this.overflowState = 'none';
    this.onFallbackEvent?.({ type: 'error', message });
    this.onFallbackComplete?.();
  }

  private cancelOverflowFallbackTimer(): void {
    if (this.fallbackTimerId !== null) {
      clearTimeout(this.fallbackTimerId);
      this.fallbackTimerId = null;
    }
  }

  /**
   * Set the mini model ID for call_llm badge default.
   * When the agent's call_llm invocation omits `args.model`, we fill it with
   * this so the UI badge shows the effective default instead of nothing.
   * Explicit `args.model` values from the agent are always preserved.
   */
  setMiniModel(model: string | undefined): void {
    this.miniModel = model;
  }

  /**
   * Generate a unique sub-turnId for a text block within the current turn.
   */
  private nextSubTurnId(prefix: string): string {
    const base = this.currentTurnId || 'unknown';
    return `${base}__${prefix}${this.subTurnCounter++}`;
  }

  protected onTurnStart(): void {
    this.toolNames.clear();
    this.hasStreamedDeltas = false;
    this.hasEmittedFinalText = false;
    this.subTurnCounter = 0;
    this.messageSubTurnId = null;
    this.retryInProgress = false;
    this.heldRetryError = null;
    this.terminalRetryHandled = false;
    this.fallbackRecoveryAttempted = false;
    this.turnUsage = undefined;
    this.log.debug('Turn started', { turnIndex: this.turnIndex });
  }

  private accumulateUsage(usage: Usage): void {
    const totals = this.turnUsage ?? {
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
    this.turnUsage = totals;
  }

  private getModelProvenance(message: {
    model?: string;
    responseModel?: string;
    provider?: string;
    api?: string;
  }): AgentModelProvenance | undefined {
    const requestedModel = message.model || undefined;
    const model = message.responseModel || requestedModel;
    const provider = message.provider || undefined;
    const api = message.api || undefined;
    const contextWindow = this.contextWindow;

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
    // Craft-injected event from pi-agent-server (not part of the Pi SDK).
    // The subprocess emits this immediately after each `message_end` to deliver
    // the correct `sdkTurnAnchor` (the leaf id AFTER the SDK has appended the
    // assistant entry). We forward it through as-is — SessionManager correlates
    // it to a Craft assistant message via `sdkMessageId`. See craft-agents-oss#782.
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
        // Internal — agent run has started
        break;

      case 'agent_end':
        // Overflow recovery: hold the queue open while the SDK runs
        // _runAutoCompaction("overflow") + agent.continue(). The recovered
        // turn will arrive as a fresh agent_start … agent_end pair.
        if (this.overflowState === 'held') {
          this.overflowState = 'awaiting';
          this.armOverflowFallbackTimer();
          break;
        }
        if (this.overflowState === 'awaiting' || this.overflowState === 'compacting') {
          // Defensive: an agent_end while still mid-recovery shouldn't happen
          // in the SDK's normal flow. Keep the queue open and wait for
          // compaction_end (success → recovering, error → drain).
          break;
        }
        if (this.overflowState === 'recovering') {
          // Recovered turn just finished — fall through to normal completion.
          this.overflowState = 'none';
        }

        // AgentSession annotates attempt-level agent_end events with
        // `willRetry`. Closing the queue here loses every later retry event and
        // recovered response even though the subprocess keeps working.
        if ((event as AgentSessionEvent & { willRetry?: boolean }).willRetry === true) {
          this.retryInProgress = true;
          break;
        }

        this.retryInProgress = false;
        if (this.heldRetryError) {
          yield this.adaptAssistantError(this.heldRetryError);
          this.heldRetryError = null;
          this.terminalRetryHandled = true;
        }
        if (this.turnUsage) {
          yield {
            type: 'complete',
            usage: {
              ...this.turnUsage,
              contextWindow: this.contextWindow,
            },
          };
        } else {
          yield { type: 'complete' };
        }
        break;

      // ============================================================
      // Turn events
      // ============================================================

      case 'turn_start':
        // Pi SDK turn_start has no ID, so generate one for event correlation
        this.currentTurnId = `pi-turn-${this.turnIndex}`;
        break;

      case 'turn_end':
        // Don't emit 'complete' here — agent_end handles it.
        // Emitting from both causes duplicate messages in session persistence.
        this.currentTurnId = null;
        this.hasStreamedDeltas = false;
        this.hasEmittedFinalText = false;
        this.subTurnCounter = 0;
        this.messageSubTurnId = null;
        break;

      // ============================================================
      // Message events (text streaming)
      // ============================================================

      case 'message_start':
        // Pi SDK emits message_start for user messages too — skip non-assistant
        break;

      case 'message_update': {
        // Pi SDK emits message_update only for assistant messages (streaming deltas)
        const amEvent: AssistantMessageEvent = event.assistantMessageEvent;
        if (amEvent.type === 'text_delta' && amEvent.delta) {
          this.hasStreamedDeltas = true;
          if (!this.messageSubTurnId) {
            this.messageSubTurnId = this.nextSubTurnId('m');
          }
          yield {
            type: 'text_delta',
            text: amEvent.delta,
            turnId: this.messageSubTurnId,
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
        } | undefined;
        // SDK message id, set by pi-agent-server when forwarding the event.
        // SessionManager uses this to correlate the follow-up `pi_turn_anchor`
        // event to the Craft assistant message created here (#782).
        const sdkMessageId = (event as { sdkMessageId?: string }).sdkMessageId ?? msg?.id;
        if (msg?.role !== 'assistant') break;
        const modelProvenance = this.getModelProvenance(msg);

        // Record usage before branching on stopReason so failed/retried calls
        // are included in the final billed total as well. Per-message
        // usage_update events below intentionally remain non-cumulative.
        if (msg.usage && typeof msg.usage.input === 'number') {
          this.accumulateUsage(msg.usage);
        }

        // Surface API errors — Pi SDK sets stopReason: 'error' and errorMessage on failures
        if (msg.stopReason === 'error' && msg.errorMessage) {
          // Context overflow: hand recovery to the SDK's _runAutoCompaction
          // and keep the UI quiet until we know the outcome (recovered turn
          // arrives, or compaction fails). Suppress the raw provider error.
          if (isContextOverflow(event.message as AssistantMessage, this.contextWindow)) {
            if (this.overflowState === 'none') {
              this.overflowState = 'held';
              this.heldOverflowError = msg.errorMessage;
              break;
            }

            // A recovered attempt may itself overflow. Give the wrapper one
            // deeper compaction attempt; after that, replace the provider's raw
            // error with a stable, actionable terminal message.
            if (this.overflowState === 'recovering') {
              if (!this.fallbackRecoveryAttempted) {
                this.overflowState = 'held';
                this.heldOverflowError = msg.errorMessage;
              } else {
                this.heldRetryError = OVERFLOW_RECOVERY_EXHAUSTED_MESSAGE;
              }
              break;
            }
          }

          // Retryability is only known on the following `agent_end.willRetry`.
          // Buffer every non-overflow assistant error until that event so a
          // transient provider failure never escapes before SDK retries finish.
          this.heldRetryError = msg.errorMessage;
          break;
        }

        // A successful retry supersedes the buffered attempt error.
        this.heldRetryError = null;

        // Extract text content from the final assistant message
        const textContent = this.extractTextFromMessage(event.message);
        // Pi SDK stopReason: 'toolUse' means the model will call tools next (intermediate commentary),
        // 'stop'/'end_turn' means final response. Same logic as Claude's stop_reason === 'tool_use'.
        const isIntermediate = msg.stopReason === 'toolUse';
        if (textContent && (isIntermediate || !this.hasEmittedFinalText)) {
          if (!isIntermediate) this.hasEmittedFinalText = true;

          const mTurnId = this.messageSubTurnId || this.nextSubTurnId('m');
          this.messageSubTurnId = null;

          yield {
            type: 'text_complete',
            text: textContent,
            isIntermediate,
            turnId: mTurnId,
            sdkMessageId,
            ...(modelProvenance ? { modelProvenance } : {}),
          };
          this.hasStreamedDeltas = false;
        }

        // Emit usage_update if the assistant message includes token usage
        if (msg.usage && typeof msg.usage.input === 'number') {
          const inputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          yield {
            type: 'usage_update',
            usage: {
              inputTokens,
              contextWindow: this.contextWindow,
            },
          };
        }
        break;
      }

      // ============================================================
      // Tool events
      // ============================================================

      case 'tool_execution_start': {
        const toolCallId = event.toolCallId;
        const toolName = this.resolveToolName(event.toolName);
        this.toolNames.set(toolCallId, toolName);

        // Normalize Pi field names to Claude Code format for UI compatibility
        // (diff stats, diff overlay, document routing all expect Claude Code format)
        const args = this.normalizeToolInput(toolName, (event.args ?? {}) as Record<string, unknown>);

        // For call_llm, fill in the default display model when the caller didn't
        // specify one — Pi's call_llm defaults to miniModel. We only fill the gap;
        // we never overwrite an explicit agent-provided model (that was the #596 bug).
        if (toolName.includes('call_llm') && this.miniModel && !args.model) {
          args.model = this.miniModel;
        }

        // Canonical metadata from subprocess event payload (interceptor/bridge-authoritative path).
        const eventMeta = this.extractToolMetadataFromEvent(event);

        // Backward-compatibility fallback: shared store (legacy side-channel),
        // with id canonicalization fallback for mixed call-id formats.
        const { meta: storedMeta, keyTried } = this.resolveStoredMetadata(toolCallId);

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
          || this.getToolDisplayName(toolName);

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

        // Classify bash commands that are actually file reads
        if (toolName === 'Bash' && typeof args.command === 'string') {
          const readInfo = this.classifyReadCommand(toolCallId, args.command);
          if (readInfo) {
            yield this.createReadToolStart(
              toolCallId,
              readInfo,
              intent,
              'Read File',
            );
            break;
          }
        }

        yield this.createToolStart(
          toolCallId,
          toolName,
          args,
          intent,
          displayName,
        );
        break;
      }

      case 'tool_execution_update': {
        // Accumulate partial output for streaming tool results
        const partialResult = event.partialResult;
        if (partialResult && typeof partialResult === 'object') {
          const content = (partialResult as { content?: Array<{ type: string; text?: string }> }).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'text' && part.text) {
                this.accumulateOutput(event.toolCallId, part.text);
              }
            }
          }
        }
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId;
        const resolvedToolName = this.toolNames.get(toolCallId) || 'tool';
        this.toolNames.delete(toolCallId);

        // Check for block reason
        const blockReason = this.consumeBlockReason(toolCallId, resolvedToolName);

        // Use accumulated output from partial results if available
        const accumulatedOutput = this.consumeOutput(toolCallId);

        const isError = event.isError;
        const continuationRequired = Boolean(
          event.result
          && typeof event.result === 'object'
          && (event.result as { details?: { continuationRequired?: unknown } }).details?.continuationRequired === true
        );
        let result: string;

        if (accumulatedOutput) {
          result = accumulatedOutput;
        } else if (blockReason) {
          result = blockReason;
        } else {
          result = this.extractToolResult(event.result, isError);
        }

        // After tool completion, the assistant may generate new text
        this.hasEmittedFinalText = false;
        this.messageSubTurnId = null;

        // Check if this was classified as a file read
        const readInfo = this.consumeReadCommand(toolCallId);
        if (readInfo) {
          yield this.createToolResult(toolCallId, 'Read', result, isError, undefined, continuationRequired);
          break;
        }

        yield this.createToolResult(toolCallId, resolvedToolName, result, isError, undefined, continuationRequired);
        break;
      }

      // ============================================================
      // Session-level events (AgentSessionEvent extensions)
      // ============================================================

      case 'compaction_start':
        // Cancel the overflow fallback timer — the SDK is now actively
        // recovering, so we no longer need the "no compaction event arrived"
        // safety net. State transitions: held|awaiting → compacting.
        if (this.overflowState === 'held' || this.overflowState === 'awaiting') {
          this.cancelOverflowFallbackTimer();
          this.overflowState = 'compacting';
        }
        // Use "Compacting" keyword so session handler detects statusType: 'compacting'
        yield { type: 'status', message: 'Compacting context...' };
        break;

      case 'compaction_end': {
        const compactionEvent = event as Extract<AgentSessionEvent, { type: 'compaction_end' }>;
        if (compactionEvent.result && !compactionEvent.aborted) {
          // Success: stay open and wait for the recovered agent_end. State
          // transitions: compacting → recovering. Threshold-only compactions
          // (state was 'none') just emit the info and continue normally.
          if (this.overflowState === 'compacting') {
            this.overflowState = 'recovering';
            this.heldOverflowError = null;
          }
          // Use "Compacted" keyword so session handler detects statusType: 'compaction_complete'
          yield { type: 'info', message: 'Compacted context to fit within limits' };
        } else if (compactionEvent.errorMessage) {
          const nativeRetryExhausted =
            compactionEvent.reason === 'overflow' &&
            /failed after one compact-and-retry attempt/i.test(compactionEvent.errorMessage);
          const sdkRace = SDK_AUTOCOMPACT_RACE_SIGNATURE.test(compactionEvent.errorMessage);

          // The SDK deliberately stops after its own retry, and older SDKs can
          // also hit a transient AbortController race. At this point its
          // compaction has ended, so a serialized manual fallback is safe.
          if (
            !this.fallbackRecoveryAttempted &&
            this.onFallbackRecover &&
            (nativeRetryExhausted || sdkRace) &&
            (this.overflowState === 'compacting' ||
              this.overflowState === 'awaiting' ||
              this.overflowState === 'held')
          ) {
            this.overflowState = 'awaiting';
            if (this.startFallbackRecovery(
              nativeRetryExhausted ? 'SDK compact-and-retry was exhausted' : 'SDK auto-compaction race',
            )) {
              yield { type: 'status', message: 'Context limit reached; compacting and retrying...' };
              break;
            }
          }

          // Defensive handler for the Pi SDK auto-compaction race (cause A
          // in plans/fix-pi-gpt-compaction.md). The raw stack
          // `undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')`
          // is unhelpful to the user; convert it to a friendly retry hint and
          // log for diagnostics. Remove once the upstream fix ships.
          if (sdkRace) {
            this.log.warn('Pi SDK auto-compaction race; recommend manual /compact', {
              errorMessage: compactionEvent.errorMessage,
            });
            yield {
              type: 'error',
              message: 'Auto-compaction hit a transient error. Try /compact manually.',
            };
          } else {
            yield {
              type: 'error',
              message: `Context compaction failed: ${compactionEvent.errorMessage}`,
            };
          }
          // If we were holding the queue open for overflow recovery, finalize
          // the turn now — no recovered agent_end will arrive on the failure
          // path. pendingQueueComplete signals the caller to terminate the
          // iterator since this is a non-agent_end event.
          if (
            this.overflowState === 'compacting' ||
            this.overflowState === 'awaiting' ||
            this.overflowState === 'held'
          ) {
            yield { type: 'complete' };
            this.pendingQueueComplete = true;
            this.overflowState = 'none';
            this.heldOverflowError = null;
            this.cancelOverflowFallbackTimer();
          }
        }
        break;
      }

      case 'auto_retry_start': {
        const retryEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_start' }>;
        this.retryInProgress = true;
        yield {
          type: 'status',
          message: `Retrying (attempt ${retryEvent.attempt}/${retryEvent.maxAttempts})...`,
        };
        break;
      }

      case 'auto_retry_end': {
        const retryEndEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_end' }>;
        if (!retryEndEvent.success && retryEndEvent.finalError) {
          // Exhausted retries are normally drained by the terminal agent_end.
          // A cancelled backoff has no second agent_end, so this is its fallback
          // terminal path.
          if (!this.terminalRetryHandled) {
            this.retryInProgress = false;
            this.heldRetryError = null;
            yield this.adaptAssistantError(`Retry failed: ${retryEndEvent.finalError}`);
            yield { type: 'complete' };
            this.pendingQueueComplete = true;
          }
        }
        break;
      }

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

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Extract canonical tool metadata from enriched tool_execution_start events.
   * This is the interceptor-authoritative path emitted by pi-agent-server.
   */
  private extractToolMetadataFromEvent(event: PiEvent): { intent?: string; displayName?: string } | undefined {
    const metadata = (event as {
      toolMetadata?: { intent?: unknown; displayName?: unknown };
    }).toolMetadata;

    if (!metadata) return undefined;

    const intent = typeof metadata.intent === 'string' ? metadata.intent : undefined;
    const displayName = typeof metadata.displayName === 'string' ? metadata.displayName : undefined;

    if (!intent && !displayName) return undefined;
    return { intent, displayName };
  }

  /**
   * Resolve stored metadata by tool call id with fallback variants.
   * Handles mixed id forms like `call_xxx|fc_yyy` by trying the base id.
   */
  private resolveStoredMetadata(toolCallId: string): { meta?: { intent?: string; displayName?: string }; keyTried?: string } {
    const candidates = new Set<string>([toolCallId]);
    if (toolCallId.includes('|')) {
      const [base] = toolCallId.split('|');
      if (base) candidates.add(base);
    }

    for (const candidate of candidates) {
      const meta = toolMetadataStore.get(candidate, this.sessionDir);
      if (meta) return { meta, keyTried: candidate };
    }

    return { meta: undefined, keyTried: Array.from(candidates).join(' -> ') };
  }

  /**
   * Normalize Pi SDK tool input field names to Claude Code format.
   * Pi uses camelCase (oldText, newText, path) while Claude Code uses
   * snake_case (old_string, new_string, file_path). The UI pipeline expects
   * Claude Code format for diff computation, overlay rendering, and
   * document type detection.
   */
  private normalizeToolInput(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === 'Edit') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }

      // Pi SDK >= 0.63.2 uses edits[] array instead of top-level oldText/newText.
      // Preserve the full edits[] payload so the renderer can expand and display
      // every replacement block. Also derive the first edit into flat old/new
      // fields as a compatibility bridge for UI paths that still expect them.
      const edits = normalized.edits as Array<{ oldText?: string; newText?: string }> | undefined;
      if (Array.isArray(edits) && edits.length > 0 && edits[0]) {
        const first = edits[0];
        if (first.oldText != null && !('old_string' in normalized)) {
          normalized.old_string = first.oldText;
        }
        if (first.newText != null && !('new_string' in normalized)) {
          normalized.new_string = first.newText;
        }
      }

      // Legacy path: top-level oldText/newText (Pi SDK < 0.63.2 or resumed sessions)
      if ('oldText' in normalized && !('old_string' in normalized)) {
        normalized.old_string = normalized.oldText;
        delete normalized.oldText;
      }
      if ('newText' in normalized && !('new_string' in normalized)) {
        normalized.new_string = normalized.newText;
        delete normalized.newText;
      }
      return normalized;
    }

    if (toolName === 'Write') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    return args;
  }

  /**
   * Resolve Pi tool name to PascalCase for UI consistency.
   * Pi tools use lowercase names (read, write, edit, bash, grep, find, ls).
   */
  private resolveToolName(rawName: string): string {
    return PI_TOOL_NAME_MAP[rawName] || rawName;
  }

  /**
   * Extract text content from a Pi AgentMessage.
   * Pi messages use the pi-ai Message format with content arrays.
   */
  private extractTextFromMessage(message: unknown): string | null {
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

  /**
   * Extract a string result from Pi tool execution result.
   */
  private extractToolResult(result: unknown, isError: boolean): string {
    if (!result) {
      return isError ? 'Tool execution failed' : 'Success';
    }

    if (typeof result === 'string') return result;

    // Pi tool results follow the AgentToolResult shape: { content: [...], details: ... }
    const typed = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
    };

    if (Array.isArray(typed.content)) {
      const texts = typed.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      if (texts.length > 0) return texts.join('\n');
    }

    // Fall back to JSON
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  /**
   * Get a human-readable display name for a tool.
   */
  private getToolDisplayName(toolName: string): string | undefined {
    switch (toolName) {
      case 'Bash':
        return 'Run Command';
      case 'Read':
        return 'Read File';
      case 'Write':
        return 'Write File';
      case 'Edit':
        return 'Edit File';
      case 'Glob':
      case 'Find':
        return 'Search Files';
      case 'Grep':
        return 'Search Content';
      case 'Ls':
        return 'List Directory';
      default:
        return undefined;
    }
  }
}
