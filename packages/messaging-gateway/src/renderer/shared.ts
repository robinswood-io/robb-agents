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
import type { PlatformAdapter, ChannelBinding, SendOptions, ResponseMode } from "../types";

/**
 * Build the per-call options bag from a binding. Currently only `threadId`
 * (Telegram supergroup forum topic) flows through. WhatsApp and DMs leave
 * `threadId` undefined, which the adapters' `threadParams()` helper turns
 * into a no-op spread.
 */
export function bindingOpts(binding: ChannelBinding): SendOptions {
    return binding.threadId !== undefined ? { threadId: binding.threadId } : {};
}

/** Session event shape (subset of the full SessionEvent from server-core). */
export interface SessionEvent {
    type: string;
    sessionId: string;
    [key: string]: unknown;
}

/** PermissionRequest shape from @craft-agent/core. */
export interface PermissionRequest {
    requestId: string;
    toolName: string;
    command?: string;
    description: string;
    type?: string;
}

export interface RenderState {
    // --- streaming mode ---------------------------------------------------
    /** Accumulated text for the current response (streaming mode). */
    textBuffer: string;
    /** Whether the agent is currently processing. */
    processing: boolean;
    /** Streaming: the message ID being edited (Telegram only). */
    streamingMessageId: string | null;
    /** Streaming: timer for next edit. */
    editTimer: ReturnType<typeof setTimeout> | null;
    /** Streaming: length of text at last edit (to detect new content). */
    lastEditedLength: number;
    /** Current effective edit interval (may increase on 429). */
    currentEditIntervalMs: number;
    // --- progress / final_only modes -------------------------------------
    /** Progress/final_only: non-intermediate assistant text accumulated this run. */
    finalBuffer: string;
    /**
     * Progress/final_only: the most recent non-empty assistant text seen this
     * run, regardless of `isIntermediate`. Used as a fallback on `complete`
     * when the run never produced a clean non-intermediate final turn (common
     * for automations whose last action is a tool call) so we still deliver
     * the agent's message instead of stranding the user on "thinking…".
     */
    lastAssistantText: string;
    /** Progress: id of the single evolving message for this run (null before first activity). */
    progressMessageId: string | null;
    /** Progress: last status label written to the bubble, to avoid redundant edits. */
    progressStatus: string | null;
}

export const DEFAULT_EDIT_INTERVAL_MS = 3500;

export const BACKOFF_RESET_MS = 30000;

export const THINKING_LABEL = '💭 thinking…';

/**
 * Max characters rendered inline with the buttons before we spill the full
 * plan into an attached file. Telegram's hard cap is 4096 — leaving margin
 * for the header, buttons, and formatting.
 */
export const PLAN_INLINE_LIMIT = 3500;

/**
 * Hook the renderer calls when it wants to remember a plan message id.
 * Passes the full `ChannelBinding` so callers can attribute the message
 * to the exact chat that rendered it — not just the session, which may
 * have multiple Telegram bindings.
 */
export type PlanMessageRecorder = (binding: ChannelBinding, token: string, messageId: string) => void;

/**
 * Hook the renderer calls when a permission prompt with inline buttons has
 * just been posted. Mirrors {@link PlanMessageRecorder}; the gateway uses
 * this to track live prompts so it can (a) idempotently claim the prompt on
 * tap, and (b) clear the inline keyboard when the agent moves on (resolved
 * from any channel — desktop, MCP, etc.).
 */
export type PermissionMessageRecorder = (binding: ChannelBinding, requestId: string, messageId: string) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function resolveResponseMode(responseMode: ResponseMode | undefined, streamResponses: boolean | undefined): ResponseMode {
    if (responseMode)
        return responseMode;
    // Legacy configs (pre-responseMode field): honour explicit streamResponses.
    return streamResponses === false ? 'final_only' : 'streaming';
}

export function appendFinal(existing: string, next: string): string {
    if (!existing)
        return next;
    return existing.endsWith('\n') ? existing + next : existing + '\n\n' + next;
}

export function truncateForAdapter(text: string, adapter: PlatformAdapter): string {
    const maxLen = adapter.capabilities.maxMessageLength;
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen - 4) + ' ...';
}

export function splitText(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let splitAt = remaining.lastIndexOf('\n\n', maxLen);
        if (splitAt <= 0)
            splitAt = remaining.lastIndexOf('\n', maxLen);
        if (splitAt <= 0)
            splitAt = remaining.lastIndexOf(' ', maxLen);
        if (splitAt <= 0)
            splitAt = maxLen;
        chunks.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.trim()) {
        chunks.push(remaining.trim());
    }
    return chunks;
}

export function extractErrorMessage(err: unknown): string {
    if (typeof err === 'string')
        return err;
    if (err && typeof err === 'object' && 'message' in err) {
        const msg = (err as {
            message?: unknown;
        }).message;
        if (typeof msg === 'string')
            return msg;
    }
    return 'An error occurred';
}

export function formatPermissionText(request: PermissionRequest): string {
    const lines = ['⚡ Permission required'];
    lines.push(`Tool: ${request.toolName}`);
    if (request.command)
        lines.push(`Command: ${request.command}`);
    if (request.description)
        lines.push(request.description);
    return lines.join('\n');
}

export function firstLines(text: string, n: number): string {
    const lines = text.split('\n');
    if (lines.length <= n)
        return text;
    return lines.slice(0, n).join('\n');
}
