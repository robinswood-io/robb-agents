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
import { bindingOpts, THINKING_LABEL, appendFinal, truncateForAdapter } from './shared.ts';
import type { SessionEvent, RenderState } from './shared.ts';

// ---------------------------------------------------------------------------
  // Mode: progress (new default — single evolving message per run)
  // ---------------------------------------------------------------------------
export async function handleProgress(transportOwner: Renderer, event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
    const state = transportOwner["getState"](binding.id);
    switch (event.type) {
        case 'text_delta':
            // Tokens are not shown in progress mode — we wait for text_complete.
            return;
        case 'text_complete': {
            const isIntermediate = Boolean(event.isIntermediate);
            const text = typeof event.text === 'string' ? event.text : '';
            if (text.trim()) {
                if (!isIntermediate) {
                    // Last assistant text of the run — keep it for the final edit.
                    state.finalBuffer = appendFinal(state.finalBuffer, text);
                }
                // Always remember the latest assistant text so `complete` can fall
                // back to it if the run never produces a non-intermediate final.
                state.lastAssistantText = text;
            }
            // Intermediate text is dropped from the bubble. Make sure it exists and shows
            // thinking status so the user knows the run is alive.
            await transportOwner["ensureProgressBubble"](state, binding, adapter, THINKING_LABEL);
            return;
        }
        case 'tool_start': {
            const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
            const displayName = typeof event.toolDisplayName === 'string' && event.toolDisplayName.length > 0
                ? event.toolDisplayName
                : toolName;
            await transportOwner["ensureProgressBubble"](state, binding, adapter, `🔧 ${displayName}…`);
            return;
        }
        case 'tool_result': {
            // Tool finished — revert the indicator to thinking until the next
            // tool_start or text_complete. Skip if we haven't posted yet (unlikely).
            if (state.progressMessageId) {
                await transportOwner["ensureProgressBubble"](state, binding, adapter, THINKING_LABEL);
            }
            return;
        }
        case 'complete': {
            // Prefer the clean non-intermediate final; fall back to the last
            // assistant text so a tool-terminated run still delivers a message
            // instead of freezing the bubble on "thinking…".
            const finalText = (state.finalBuffer.trim() || state.lastAssistantText.trim());
            if (state.progressMessageId && adapter.capabilities.messageEditing) {
                if (finalText) {
                    await transportOwner["tryEditMessage"](adapter, binding, state.progressMessageId, truncateForAdapter(finalText, adapter), state);
                }
                // If the run produced no assistant text at all, leave the last
                // status in place rather than editing to an empty string — avoids
                // Telegram "message is not modified" errors and keeps a trace.
            }
            else if (finalText) {
                // Adapter can't edit (WhatsApp) — send one message at the end.
                await transportOwner["sendText"](adapter, binding, finalText);
            }
            transportOwner["resetRun"](state);
            return;
        }
    }
}

/**
   * Post the progress bubble if needed, and edit it to `status` if the
   * status has changed since the last write. Collapses redundant edits so
   * we stay under Telegram's per-chat edit budget.
   */
export async function ensureProgressBubble(transportOwner: Renderer, state: RenderState, binding: ChannelBinding, adapter: PlatformAdapter, status: string): Promise<void> {
    if (!state.progressMessageId) {
        try {
            const sent = await adapter.sendText(binding.channelId, status, bindingOpts(binding));
            state.progressMessageId = sent.messageId;
            state.progressStatus = status;
        }
        catch {
            // If posting fails, we'll try again on the next event.
        }
        return;
    }
    if (!adapter.capabilities.messageEditing)
        return;
    if (state.progressStatus === status)
        return;
    await transportOwner["tryEditMessage"](adapter, binding, state.progressMessageId, status, state);
    state.progressStatus = status;
}
