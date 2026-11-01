import { isUnknownArray } from '../../../utils/json.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@craft-agent/core/types';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { ToolIndex, extractToolStarts, extractToolResults, isParentTaskTool, type ContentBlock } from '../../tool-matching.ts';
import { buildWindowsSkillsDirError, VALID_TASK_STATUSES } from './event-contracts.ts';
import type { ClaudeAdapterCallbacks, AssistantUsage, TaskNotificationMessage, TaskStatus } from './event-contracts.ts';
export { buildWindowsSkillsDirError } from './event-contracts.ts';
export type { ClaudeAdapterCallbacks } from './event-contracts.ts';

export class ClaudeEventAdapter extends BaseEventAdapter {
  // Per-turn state (reset on each startTurn)
  private toolIndex = new ToolIndex();
  private emittedToolStarts = new Set<string>();
  private activeParentTools = new Set<string>();
  private pendingText: string | null = null;

  // Session-persistent state (survives across turns)
  private lastAssistantUsage: AssistantUsage | null = null;
  private cachedContextWindow?: number;
  private _sdkTools: string[] = [];

  private callbacks: ClaudeAdapterCallbacks;

  constructor(callbacks: ClaudeAdapterCallbacks) {
    super('claude-adapter');
    this.callbacks = callbacks;
  }

  // ============================================================
  // Turn Lifecycle
  // ============================================================

  protected onTurnStart(): void {
    this.toolIndex = new ToolIndex();
    this.emittedToolStarts = new Set();
    this.activeParentTools = new Set();
    this.pendingText = null;
    this.lastAssistantUsage = null;
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Convert an SDK message to AgentEvents.
   * Main entry point called from ClaudeAgent's for-await loop.
   */
  async adapt(message: SDKMessage): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // Debug: log non-streaming SDK message types (stream_event is too frequent)
    if (this.callbacks.onDebug && message.type !== 'stream_event') {
      const msgInfo = message.type === 'user' && 'tool_use_result' in message
        ? `user (tool_result for ${message.parent_tool_use_id})`
        : message.type;
      this.callbacks.onDebug(`SDK message: ${msgInfo}`);
    }

    switch (message.type) {
      case 'assistant':
        await this.adaptAssistant(message, events);
        break;

      case 'stream_event':
        this.adaptStreamEvent(message, events);
        break;

      case 'user':
        this.adaptUser(message, events);
        break;

      case 'tool_progress':
        this.adaptToolProgress(message, events);
        break;

      case 'result':
        this.adaptResult(message, events);
        break;

      case 'system':
        this.adaptSystem(message, events);
        break;

      case 'auth_status':
        this.adaptAuthStatus(message, events);
        break;

      default:
        if (this.callbacks.onDebug) {
          this.callbacks.onDebug(`Unhandled SDK message type: ${message.type}`);
        }
        break;
    }

    return events;
  }

  /**
   * Flush any pending text that hasn't been emitted.
   * Called after the for-await loop exits to handle edge cases
   * (e.g., SDK sends assistant message with text but skips message_delta).
   */
  flushPending(): AgentEvent | null {
    if (this.pendingText) {
      const event: AgentEvent = {
        type: 'text_complete',
        text: this.pendingText,
        isIntermediate: false,
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      };
      this.pendingText = null;
      return event;
    }
    return null;
  }

  /**
   * Get SDK tools captured from init message.
   */
  get sdkTools(): string[] {
    return this._sdkTools;
  }

  /**
   * Get the tool index (for agent-level operations like inactive source detection).
   */
  getToolIndex(): ToolIndex {
    return this.toolIndex;
  }

  /**
   * Get the set of active parent tools (exposed for source activation detection).
   */
  getActiveParentTools(): Set<string> {
    return this.activeParentTools;
  }

  /**
   * Update the session directory for tool metadata lookups.
   */
  updateSessionDir(sessionDir: string): void {
    this.callbacks.sessionDir = sessionDir;
  }

  // ============================================================
  // Per-message-type Handlers
  // ============================================================

  private async adaptAssistant(message: Extract<SDKMessage, { type: 'assistant' }>, events: AgentEvent[]): Promise<void> {
    // Check for SDK-level errors FIRST (auth, network, rate limits, etc.)
    if ('error' in message && message.error) {
      const errorEvent = await this.callbacks.mapSDKError(
        message.error,
      );
      const sdkMessage = message.message?.content
        .find(block => block.type === 'text')?.text ?? '';
      if (message.error === 'authentication_failed'
        && /OAuth (?:session expired and could not be refreshed|access token has expired.*Re-authenticate to continue)/i.test(sdkMessage)) {
        errorEvent.error = {
          ...errorEvent.error,
          code: 'expired_oauth_token',
          title: 'Session expired',
          message: `${sdkMessage} Reconnect this account in Settings before retrying.`,
          actions: [{ key: 'r', label: 'Re-authenticate', action: 'reauth' }],
          canRetry: false,
        };
      }
      events.push(errorEvent);
      return;
    }

    // Skip replayed messages when resuming a session
    if ('isReplay' in message && message.isReplay) {
      return;
    }

    // Track usage from non-sidechain assistant messages
    const isSidechain = message.parent_tool_use_id !== null;
    if (!isSidechain && message.message?.usage) {
      const usage = message.message.usage;
      this.lastAssistantUsage = {
        input_tokens: usage.input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      };

      const currentInputTokens =
        this.lastAssistantUsage.input_tokens +
        this.lastAssistantUsage.cache_read_input_tokens +
        this.lastAssistantUsage.cache_creation_input_tokens;

      events.push({
        type: 'usage_update',
        usage: {
          inputTokens: currentInputTokens,
          ...(this.cachedContextWindow !== undefined ? { contextWindow: this.cachedContextWindow } : {}),
        },
      });
    }

    // Full assistant message with content blocks
    const content = message.message?.content ?? [];

    // Extract text from content blocks
    let textContent = '';
    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    // Stateless tool start extraction
    const sdkParentId = message.parent_tool_use_id;
    const toolStartEvents = extractToolStarts(
      content as ContentBlock[],
      sdkParentId,
      this.toolIndex,
      this.emittedToolStarts,
      this.currentTurnId || undefined,
      this.activeParentTools,
      this.callbacks.sessionDir,
    );

    // Track active Task tools for fallback parent assignment
    for (const event of toolStartEvents) {
      if (event.type === 'tool_start' && isParentTaskTool(event.toolName)) {
        this.activeParentTools.add(event.toolUseId);
      }
    }

    events.push(...toolStartEvents);

    if (textContent) {
      // Don't emit text_complete yet — wait for message_delta to get stop_reason
      this.pendingText = textContent;
    }
  }

  private adaptStreamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>, events: AgentEvent[]): void {
    const event = message.event;

    // Debug: log key stream events only (skip per-chunk deltas and frequent pings)
    if (this.callbacks.onDebug && (event.type === 'message_start' || event.type === 'message_stop')) {
      this.callbacks.onDebug(
        `stream_event: ${event.type}`,
      );
    }

    // Capture turn ID from message_start
    if (event.type === 'message_start') {
      const messageId = event.message?.id;
      if (messageId) {
        this.currentTurnId = messageId;
      }
    }

    // message_delta contains the actual stop_reason — emit pending text now
    if (event.type === 'message_delta') {
      const stopReason = event.delta?.stop_reason;
      if (this.pendingText) {
        const isIntermediate = stopReason === 'tool_use';
        const optionalParentToolUseId = message.parent_tool_use_id || undefined;
        events.push({
          type: 'text_complete',
          text: this.pendingText,
          isIntermediate,
          ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
          ...(optionalParentToolUseId !== undefined ? { parentToolUseId: optionalParentToolUseId } : {}),
        });
        this.pendingText = null;
      }
    }

    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const optionalParentToolUseId2 = message.parent_tool_use_id || undefined;
      events.push({
        type: 'text_delta',
        text: event.delta.text,
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
        ...(optionalParentToolUseId2 !== undefined ? { parentToolUseId: optionalParentToolUseId2 } : {}),
      });
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      // Stream events arrive with empty input — the full input comes later
      const toolBlock = event.content_block;
      const sdkParentId = message.parent_tool_use_id;
      const streamBlocks: ContentBlock[] = [{
        type: 'tool_use' as const,
        id: toolBlock.id,
        name: toolBlock.name,
        input: (toolBlock.input ?? {}) as Record<string, unknown>,
      }];
      const streamEvents = extractToolStarts(
        streamBlocks,
        sdkParentId,
        this.toolIndex,
        this.emittedToolStarts,
        this.currentTurnId || undefined,
        this.activeParentTools,
        this.callbacks.sessionDir,
      );

      // Track active Task/Agent tools for fallback parent assignment
      for (const evt of streamEvents) {
        if (evt.type === 'tool_start' && isParentTaskTool(evt.toolName)) {
          this.activeParentTools.add(evt.toolUseId);
        }
      }

      events.push(...streamEvents);
    }
  }

  private adaptUser(message: Extract<SDKMessage, { type: 'user' }>, events: AgentEvent[]): void {
    // Skip replayed messages when resuming
    if ('isReplay' in message && message.isReplay) {
      return;
    }

    // Tool result matching
    if (message.tool_use_result !== undefined || ('message' in message && message.message)) {
      const msgContent = ('message' in message && message.message)
        ? ((message.message as { content?: unknown[] }).content ?? [])
        : [];
      const contentBlocks = (isUnknownArray(msgContent) ? msgContent : []) as ContentBlock[];

      const sdkParentId = message.parent_tool_use_id;
      const toolUseResultValue = message.tool_use_result;

      const resultEvents = extractToolResults(
        contentBlocks,
        sdkParentId,
        toolUseResultValue,
        this.toolIndex,
        this.currentTurnId || undefined,
      );

      // Remove completed Task/Agent tools from activeParentTools
      for (const event of resultEvents) {
        if (event.type === 'tool_result' && isParentTaskTool(event.toolName ?? '')) {
          this.activeParentTools.delete(event.toolUseId);
        }
      }

      events.push(...resultEvents);
    }
  }

  private adaptToolProgress(message: Extract<SDKMessage, { type: 'tool_progress' }>, events: AgentEvent[]): void {
    const progress = message;

    // Forward elapsed time for live progress updates
    if (progress.elapsed_time_seconds !== undefined) {
      events.push({
        type: 'task_progress',
        toolUseId: progress.parent_tool_use_id || progress.tool_use_id,
        elapsedSeconds: progress.elapsed_time_seconds,
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      });
    }

    // Emit tool_start for tools discovered through progress events
    if (!this.emittedToolStarts.has(progress.tool_use_id)) {
      const progressBlocks: ContentBlock[] = [{
        type: 'tool_use' as const,
        id: progress.tool_use_id,
        name: progress.tool_name,
        input: {},
      }];
      const progressEvents = extractToolStarts(
        progressBlocks,
        progress.parent_tool_use_id,
        this.toolIndex,
        this.emittedToolStarts,
        this.currentTurnId || undefined,
        this.activeParentTools,
        this.callbacks.sessionDir,
      );

      // Track active Task/Agent tools discovered via progress events
      for (const evt of progressEvents) {
        if (evt.type === 'tool_start' && isParentTaskTool(evt.toolName)) {
          this.activeParentTools.add(evt.toolUseId);
        }
      }

      events.push(...progressEvents);
    }
  }

  private adaptResult(message: Extract<SDKMessage, { type: 'result' }>, events: AgentEvent[]): void {
    const msg = message;

    // Debug logging
    console.error(
      `[ClaudeAdapter] result message: subtype=${msg.subtype}, errors=${'errors' in msg ? JSON.stringify(msg.errors) : 'none'}`,
    );

    // Get contextWindow from modelUsage
    const modelUsageEntries = Object.values(msg.modelUsage || {});
    const primaryModelUsage = modelUsageEntries[0];

    if (primaryModelUsage?.contextWindow) {
      this.cachedContextWindow = primaryModelUsage.contextWindow;
    }

    // Use lastAssistantUsage for per-message context display (not cumulative)
    let inputTokens: number;
    let cacheRead: number;
    let cacheCreation: number;

    if (this.lastAssistantUsage) {
      inputTokens = this.lastAssistantUsage.input_tokens +
                    this.lastAssistantUsage.cache_read_input_tokens +
                    this.lastAssistantUsage.cache_creation_input_tokens;
      cacheRead = this.lastAssistantUsage.cache_read_input_tokens;
      cacheCreation = this.lastAssistantUsage.cache_creation_input_tokens;
    } else {
      cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      cacheCreation = msg.usage.cache_creation_input_tokens ?? 0;
      inputTokens = msg.usage.input_tokens + cacheRead + cacheCreation;
    }

    const usage: Extract<AgentEvent, { type: 'complete' }>['usage'] = {
      inputTokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      costUsd: msg.total_cost_usd,
      ...(primaryModelUsage?.contextWindow !== undefined ? { contextWindow: primaryModelUsage?.contextWindow } : {}),
    };

    if (msg.subtype === 'success' && !msg.is_error) {
      events.push({ type: 'complete', ...(usage !== undefined ? { usage } : {}) });
    } else {
      const errorMsg = 'errors' in msg ? msg.errors.join(', ')
        : 'result' in msg && typeof msg.result === 'string' ? msg.result : 'Query failed';

      const windowsError = buildWindowsSkillsDirError(errorMsg);
      if (windowsError) {
        events.push(windowsError);
      } else {
        events.push({ type: 'error', message: errorMsg });
      }
      events.push({ type: 'complete', ...(usage !== undefined ? { usage } : {}) });
    }
  }

  private adaptSystem(message: Extract<SDKMessage, { type: 'system' }>, events: AgentEvent[]): void {
    const msg = message;

    if (msg.subtype === 'init') {
      // Capture tools list from SDK init message
      if ('tools' in msg && isUnknownArray(msg.tools)) {
        this._sdkTools = msg.tools;
        this.callbacks.onDebug?.(`SDK init: captured ${this._sdkTools.length} tools`);
      }
    } else if (msg.subtype === 'compact_boundary') {
      events.push({
        type: 'info',
        message: 'Compacted Conversation',
      });
    } else if (msg.subtype === 'status' && msg.status === 'compacting') {
      events.push({ type: 'status', message: 'Compacting conversation...' });
    } else if (msg.subtype === 'task_notification') {
      const notification = msg as TaskNotificationMessage;
      if (!notification.task_id) {
        this.callbacks.onDebug?.('[EventAdapter] task_notification missing task_id, skipping');
        return;
      }
      const status: TaskStatus = VALID_TASK_STATUSES.includes(notification.status as TaskStatus)
        ? (notification.status as TaskStatus)
        : 'completed';
      events.push({
        type: 'task_completed',
        taskId: notification.task_id,
        status,
        ...(notification.output_file !== undefined ? { outputFile: notification.output_file } : {}),
        ...(notification.summary !== undefined ? { summary: notification.summary } : {}),
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      });
    }
  }

  private adaptAuthStatus(message: Extract<SDKMessage, { type: 'auth_status' }>, events: AgentEvent[]): void {
    const msg = message;
    if (msg.error) {
      events.push({
        type: 'error',
        message: `Auth error: ${msg.error}. Try running /auth to re-authenticate.`,
      });
    }
  }
}
