/**
 * Renderer — converts SessionManager events into chat messages.
 *
 * Three modes selected per binding via `BindingConfig.responseMode`:
 *
 *   - `streaming` (legacy): on Telegram, posts on first `text_delta` and
 *     edits every ~editIntervalMs as tokens arrive; each `text_complete`
 *     finalises the current message, so one agent run with multiple turns
 *     produces multiple messages. On platforms without editing, accumulates
 *     per turn and sends on each `text_complete`.
 *
 *   - `progress` (default): one evolving message per run. Posts
 *     "💭 thinking…" on first activity, edits to "🔧 <tool>…" on each
 *     `tool_start`, back to "💭 thinking…" on `tool_result`, and replaces
 *     the whole bubble with the final text on `complete`. Intermediate
 *     assistant text (`text_complete` with `isIntermediate`) is dropped.
 *     On adapters without `messageEditing`, degrades to a single
 *     send-on-complete (identical to `final_only`).
 *
 *   - `final_only`: silent until `complete`, then sends one message with
 *     the accumulated final text. Nothing is sent for empty completions.
 *
 * Permissions and errors are orthogonal: when the session requests a
 * permission or an error fires, the renderer flushes current mode state
 * and emits the prompt/error as a distinct message regardless of mode.
 */
import type { PlatformAdapter, ChannelBinding } from "../types";
import type { Renderer } from '../renderer.ts';
import { bindingOpts, DEFAULT_EDIT_INTERVAL_MS, BACKOFF_RESET_MS, resolveResponseMode, truncateForAdapter } from './shared.ts';
import type { SessionEvent, RenderState } from './shared.ts';

export function getState(transportOwner: Renderer, bindingId: string): RenderState {
    let state = transportOwner.states.get(bindingId);
    if (!state) {
        state = {
            textBuffer: '',
            processing: false,
            streamingMessageId: null,
            editTimer: null,
            lastEditedLength: 0,
            currentEditIntervalMs: DEFAULT_EDIT_INTERVAL_MS,
            finalBuffer: '',
            lastAssistantText: '',
            progressMessageId: null,
            progressStatus: null,
        };
        transportOwner.states.set(bindingId, state);
    }
    return state;
}

export async function handle(transportOwner: Renderer, event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
    // Permission / error prompts are mode-agnostic — handle first so they
    // can't be swallowed by mode state.
    if (event.type === 'permission_request') {
        await transportOwner.handlePermissionRequest(event, binding, adapter, transportOwner.getState(binding.id));
        return;
    }
    if (event.type === 'credential_request') {
        await transportOwner.handleCredentialRequest(binding, adapter);
        return;
    }
    if (event.type === 'plan_submitted') {
        await transportOwner.handlePlanSubmitted(event, binding, adapter);
        return;
    }
    if (event.type === 'error' || event.type === 'typed_error') {
        await transportOwner.handleError(event, binding, adapter, transportOwner.getState(binding.id));
        return;
    }
    const mode = resolveResponseMode(binding.config.responseMode, binding.config.streamResponses);
    switch (mode) {
        case 'streaming':
            return transportOwner.handleStreaming(event, binding, adapter);
        case 'progress':
            return transportOwner.handleProgress(event, binding, adapter);
        case 'final_only':
            return transportOwner.handleFinalOnly(event, binding, adapter);
    }
}

// ---------------------------------------------------------------------------
  // Mode: streaming (legacy behaviour — unchanged)
  // ---------------------------------------------------------------------------
export async function handleStreaming(transportOwner: Renderer, event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
    const state = transportOwner.getState(binding.id);
    switch (event.type) {
        case 'text_delta': {
            const delta = typeof event["delta"] === 'string' ? event["delta"] : '';
            if (!delta)
                break;
            state.textBuffer += delta;
            state.processing = true;
            if (adapter.capabilities.messageEditing) {
                await transportOwner.handleStreamingDelta(state, binding, adapter);
            }
            break;
        }
        case 'text_complete': {
            const text = typeof event["text"] === 'string' ? event["text"] : state.textBuffer;
            transportOwner.cancelEditTimer(state);
            if (state.streamingMessageId && adapter.capabilities.messageEditing) {
                if (text.trim()) {
                    await transportOwner.tryEditMessage(adapter, binding, state.streamingMessageId, text.trim(), state);
                }
            }
            else if (text.trim()) {
                await transportOwner.sendText(adapter, binding, text.trim());
            }
            state.textBuffer = '';
            state.streamingMessageId = null;
            state.lastEditedLength = 0;
            break;
        }
        case 'complete': {
            transportOwner.cancelEditTimer(state);
            if (state.textBuffer.trim() && !state.streamingMessageId) {
                await transportOwner.sendText(adapter, binding, state.textBuffer.trim());
            }
            transportOwner.resetRun(state);
            break;
        }
        case 'tool_start': {
            if (binding.config.showToolActivity) {
                const toolName = typeof event["toolName"] === 'string' ? event["toolName"] : 'tool';
                const displayName = typeof event["toolDisplayName"] === 'string' ? event["toolDisplayName"] : toolName;
                if (state.streamingMessageId && state.textBuffer.trim()) {
                    transportOwner.cancelEditTimer(state);
                    await transportOwner.tryEditMessage(adapter, binding, state.streamingMessageId, state.textBuffer.trim(), state);
                    state.streamingMessageId = null;
                    state.textBuffer = '';
                    state.lastEditedLength = 0;
                }
                await adapter.sendText(binding.channelId, `🔧 ${displayName}...`, bindingOpts(binding));
            }
            else {
                await adapter.sendTyping(binding.channelId, bindingOpts(binding)).catch(() => { });
            }
            break;
        }
    }
}

export async function handleStreamingDelta(transportOwner: Renderer, state: RenderState, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
    if (!state.streamingMessageId && state.textBuffer.length > 0) {
        try {
            const sent = await adapter.sendText(binding.channelId, state.textBuffer, bindingOpts(binding));
            state.streamingMessageId = sent.messageId;
            state.lastEditedLength = state.textBuffer.length;
            transportOwner.scheduleEdit(state, binding, adapter);
        }
        catch {
            // If posting fails, accumulate and try on complete
        }
        return;
    }
    // Subsequent chunks: edit timer handles batched updates
}

export function scheduleEdit(transportOwner: Renderer, state: RenderState, binding: ChannelBinding, adapter: PlatformAdapter): void {
    if (state.editTimer)
        return;
    const intervalMs = Math.max(binding.config.editIntervalMs, state.currentEditIntervalMs);
    state.editTimer = setTimeout(async () => {
        state.editTimer = null;
        if (!state.streamingMessageId)
            return;
        if (state.textBuffer.length <= state.lastEditedLength)
            return;
        const text = state.textBuffer.trim();
        if (!text)
            return;
        await transportOwner.tryEditMessage(adapter, binding, state.streamingMessageId, text, state);
        state.lastEditedLength = state.textBuffer.length;
        if (state.processing) {
            transportOwner.scheduleEdit(state, binding, adapter);
        }
    }, intervalMs);
}

// ---------------------------------------------------------------------------
  // Adapter helpers
  // ---------------------------------------------------------------------------
export async function tryEditMessage(_transportOwner: Renderer, adapter: PlatformAdapter, binding: ChannelBinding, messageId: string, text: string, state: RenderState): Promise<void> {
    const truncated = truncateForAdapter(text, adapter);
    try {
        // editMessage on Telegram is keyed by (chat_id, message_id) and ignores
        // message_thread_id, but we pass it for caller uniformity.
        await adapter.editMessage(binding.channelId, messageId, truncated, bindingOpts(binding));
        state.currentEditIntervalMs = DEFAULT_EDIT_INTERVAL_MS;
    }
    catch (err: unknown) {
        const is429 = err instanceof Error &&
            (err.message.includes('429') || err.message.includes('Too Many Requests'));
        if (is429) {
            state.currentEditIntervalMs = Math.min(state.currentEditIntervalMs * 2, 15000);
            setTimeout(() => {
                state.currentEditIntervalMs = DEFAULT_EDIT_INTERVAL_MS;
            }, BACKOFF_RESET_MS);
        }
        // Other errors: silently skip — text_complete / complete will retry.
    }
}

export function cancelEditTimer(_transportOwner: Renderer, state: RenderState): void {
    if (state.editTimer) {
        clearTimeout(state.editTimer);
        state.editTimer = null;
    }
}
