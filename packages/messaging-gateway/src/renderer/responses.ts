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
import type { PlatformAdapter, ChannelBinding, SentMessage, InlineButton } from "../types";
import type { Renderer } from '../renderer.ts';
import { bindingOpts, PLAN_INLINE_LIMIT, appendFinal, splitText, extractErrorMessage, formatPermissionText, firstLines } from './shared.ts';
import type { SessionEvent, PermissionRequest, RenderState } from './shared.ts';

// ---------------------------------------------------------------------------
  // Mode: final_only (silent → single send on complete)
  // ---------------------------------------------------------------------------
export async function handleFinalOnly(transportOwner: Renderer, event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
    const state = transportOwner["getState"](binding.id);
    switch (event.type) {
        case 'text_complete': {
            // Only keep non-intermediate text. `isIntermediate` is a hint; when
            // absent (older events or non-Claude backends), we include the text
            // because it's the only thing we might ever see.
            const isIntermediate = Boolean(event.isIntermediate);
            const text = typeof event.text === 'string' ? event.text : '';
            if (text.trim()) {
                if (!isIntermediate) {
                    state.finalBuffer = appendFinal(state.finalBuffer, text);
                }
                // Fallback for runs that never emit a non-intermediate final turn.
                state.lastAssistantText = text;
            }
            return;
        }
        case 'complete': {
            // Prefer the clean non-intermediate final; fall back to the last
            // assistant text so final_only still delivers something rather than
            // staying silent when the run ends on a tool call.
            const finalText = (state.finalBuffer.trim() || state.lastAssistantText.trim());
            if (finalText) {
                await transportOwner["sendText"](adapter, binding, finalText);
            }
            transportOwner["resetRun"](state);
            return;
        }
    }
    // text_delta, tool_start, tool_result — all deliberately ignored.
}

// ---------------------------------------------------------------------------
  // Permissions / errors (shared across modes)
  // ---------------------------------------------------------------------------
export async function handlePermissionRequest(transportOwner: Renderer, event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter, state: RenderState): Promise<void> {
    const request = event.request as PermissionRequest | undefined;
    if (!request?.requestId)
        return;
    // Flush any streaming state first so the prompt lands as a distinct
    // message (progress-mode bubble stays in place as a separate message).
    if (state.streamingMessageId && state.textBuffer.trim()) {
        transportOwner["cancelEditTimer"](state);
        await transportOwner["tryEditMessage"](adapter, binding, state.streamingMessageId, state.textBuffer.trim(), state);
        state.streamingMessageId = null;
        state.textBuffer = '';
        state.lastEditedLength = 0;
    }
    if (binding.platform === 'whatsapp') {
        await adapter.sendText(binding.channelId, `⏸ Permission required: ${request.description}
Approve it in the desktop app to continue.`, bindingOpts(binding));
        return;
    }
    if (binding.config.approvalChannel === 'chat' && adapter.capabilities.inlineButtons) {
        const text = formatPermissionText(request);
        const buttons: InlineButton[] = [
            { id: `perm:allow:${request.requestId}`, label: '✅ Allow' },
            { id: `perm:deny:${request.requestId}`, label: '❌ Deny' },
        ];
        const sent = await adapter.sendButtons(binding.channelId, text, buttons, bindingOpts(binding));
        transportOwner["recordPermissionMessage"]?.(binding, request.requestId, sent.messageId);
    }
    else {
        await adapter.sendText(binding.channelId, `⏸ Permission required: ${request.description}
Approve in the desktop app to continue.`, bindingOpts(binding));
    }
}

export async function handleCredentialRequest(transportOwner: Renderer, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
    if (binding.platform !== 'whatsapp')
        return;
    await adapter.sendText(binding.channelId, '🔐 Credentials are required to continue. Open the desktop app to review and submit them securely.', bindingOpts(binding));
}

export async function handlePlanSubmitted(transportOwner: Renderer, event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
    // WhatsApp: no interactive buttons yet — keep the generic pointer.
    if (binding.platform === 'whatsapp') {
        await adapter.sendText(binding.channelId, '📝 A plan is ready for review. Open the desktop app to inspect and approve it.', bindingOpts(binding));
        return;
    }
    // Telegram + Lark both support inline buttons through the same
    // `sendButtons` contract; either gets the rich plan card. Anything else
    // is treated like WhatsApp above and gated out earlier.
    if (binding.platform !== 'telegram' && binding.platform !== 'lark')
        return;
    // Token registry is optional for backwards compatibility; without it we
    // degrade to the generic pointer so the bot still sees *something*.
    if (!transportOwner["planTokens"]) {
        await adapter.sendText(binding.channelId, '📝 A plan is ready for review. Open the desktop app to inspect and approve it.', bindingOpts(binding));
        return;
    }
    const planMessage = event.message as {
        planPath?: string;
        content?: string;
    } | undefined;
    const planPath = planMessage?.planPath ?? '';
    const planContent = planMessage?.content ?? '';
    const token = transportOwner["planTokens"].issue(binding.id, binding.sessionId, planPath);
    const buttons: InlineButton[] = [
        { id: `plan:accept:${token}`, label: '✅ Accept plan' },
        { id: `plan:compact:${token}`, label: '♻️ Accept & compact' },
    ];
    const header = '📝 *Plan ready for review*';
    const fitsInline = planContent.length > 0 && planContent.length <= PLAN_INLINE_LIMIT;
    const bodyText = fitsInline
        ? `${header}\n\n${planContent}`
        : planContent.length === 0
            ? `${header}\n\nOpen the desktop app to see the plan, or use the buttons below to accept.`
            : `${header}\n\n${firstLines(planContent, 15)}\n\n…full plan attached below.`;
    try {
        const sent = await adapter.sendButtons(binding.channelId, bodyText, buttons, bindingOpts(binding));
        transportOwner["recordPlanMessage"]?.(binding, token, sent.messageId);
        if (!fitsInline && planContent.length > 0) {
            await adapter.sendFile(binding.channelId, Buffer.from(planContent, 'utf-8'), 'plan.md', 'Full plan', bindingOpts(binding));
        }
    }
    catch (err) {
        // Fall back to a plain text notice so the user at least knows.
        await adapter.sendText(binding.channelId, `📝 A plan is ready for review (couldn't render inline: ${err instanceof Error ? err.message : 'unknown error'}). Open the desktop app to approve it.`, bindingOpts(binding));
    }
}

export async function handleError(transportOwner: Renderer, event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter, state: RenderState): Promise<void> {
    const errorMsg = extractErrorMessage(event.error);
    transportOwner["cancelEditTimer"](state);
    await adapter.sendText(binding.channelId, `❌ ${errorMsg}`, bindingOpts(binding));
    transportOwner["resetRun"](state);
}

/** Send text, splitting if it exceeds platform limits. */
export async function sendText(transportOwner: Renderer, adapter: PlatformAdapter, binding: ChannelBinding, text: string): Promise<SentMessage | undefined> {
    const maxLen = adapter.capabilities.maxMessageLength;
    const opts = bindingOpts(binding);
    if (text.length <= maxLen) {
        return adapter.sendText(binding.channelId, text, opts);
    }
    const chunks = splitText(text, maxLen);
    let last: SentMessage | undefined;
    for (const chunk of chunks) {
        last = await adapter.sendText(binding.channelId, chunk, opts);
    }
    return last;
}

/** Reset per-run state (called on `complete`, `error`, etc.). */
export function resetRun(transportOwner: Renderer, state: RenderState): void {
    transportOwner["cancelEditTimer"](state);
    state.textBuffer = '';
    state.streamingMessageId = null;
    state.lastEditedLength = 0;
    state.processing = false;
    state.finalBuffer = '';
    state.lastAssistantText = '';
    state.progressMessageId = null;
    state.progressStatus = null;
}

export function removeBinding(transportOwner: Renderer, bindingId: string): void {
    const state = transportOwner["states"].get(bindingId);
    if (state) {
        transportOwner["cancelEditTimer"](state);
        transportOwner["states"].delete(bindingId);
    }
}
