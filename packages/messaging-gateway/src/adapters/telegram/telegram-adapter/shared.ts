import { type Context } from "grammy";
import type { SendOptions, MessagingLogger } from "../../../types";

/**
 * Discriminated chat metadata returned by `getChatInfo`. Phase A's supergroup
 * pairing flow uses this to validate that the user typed `/pair` in an
 * actual forum supergroup before binding it as the workspace's supergroup.
 */
export type TelegramChatInfo = {
    type: 'supergroup';
    isForum: boolean;
    title: string;
} | {
    type: 'group' | 'channel' | 'private';
    title?: string;
};

/**
 * Hard cap for downloaded attachment size. Matches `MAX_FILE_SIZE` in
 * `@craft-agent/shared/utils/files` — files larger than this would be
 * rejected by `readFileAttachment` anyway, so we fail fast in the adapter
 * with a user-visible reply instead of silently dropping.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Minimal mime → extension fallback used when Telegram's `file_path` is
 * missing or extension-less. Kept intentionally small — anything unknown
 * becomes `.bin` and `readFileAttachment` will classify it as 'unknown'.
 */
export const MIME_EXT_FALLBACK: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'application/pdf': '.pdf',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
};

export const NOOP_LOGGER: MessagingLogger = {
    info: () => { },
    warn: () => { },
    error: () => { },
    child: () => NOOP_LOGGER,
};

/**
 * Race a promise against a timeout. If `ms` elapses before `p` settles, reject
 * with a labelled error. Used to surface grammY's silent-retry hangs on
 * `bot.init()` / `deleteWebhook()` as real, actionable errors.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`[telegram] ${label} timed out after ${ms}ms`)), ms);
        p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
    });
}

/**
 * Unwrap an error for structured logging. grammY's HttpError wraps the real
 * fetch/undici cause in an `.error` field; electron-log's JSON serializer
 * otherwise sees an empty object because Error's own fields are non-enumerable.
 * Walks up to 3 levels of wrapping (HttpError -> cause -> cause).
 */
export function describeError(err: unknown, depth = 0): Record<string, unknown> {
    if (depth > 3)
        return { truncated: true };
    if (err instanceof Error) {
        const out: Record<string, unknown> = {
            name: err.name,
            message: err.message,
        };
        const code = (err as {
            code?: unknown;
        }).code;
        if (code !== undefined)
            out["code"] = code;
        const grammyInner = (err as {
            error?: unknown;
        }).error;
        if (grammyInner !== undefined)
            out["error"] = describeError(grammyInner, depth + 1);
        const cause = (err as {
            cause?: unknown;
        }).cause;
        if (cause !== undefined)
            out["cause"] = describeError(cause, depth + 1);
        if (err.stack)
            out["stack"] = err.stack.split('\n').slice(0, 4).join('\n');
        return out;
    }
    if (err && typeof err === 'object')
        return { value: String(err), raw: err as object };
    return { value: String(err) };
}

/**
 * DM-only guard. Retained because tests use it directly; new code paths
 * should call `isAcceptedChat()` which also accepts the workspace's
 * configured supergroup chat (forum).
 */
export function isPrivateChat(ctx: Context): boolean {
    return ctx.chat?.type === 'private';
}

/**
 * Decide whether an inbound update should be processed.
 *
 * - DMs (`private` chats) are always accepted — same as Phase 1.
 * - When the workspace has a paired supergroup, that exact `chat.id` is
 *   also accepted (forum topics live inside it).
 * - Everything else (other groups, channels, basic groups the bot was
 *   added to without explicit configuration) is dropped.
 *
 * Sender-level authorization for groups/topics is intentionally NOT enforced
 * here — pairing the supergroup in Settings is the per-workspace consent
 * boundary, and topic-scoped bindings determine which session each topic
 * routes to.
 */
export function isAcceptedChat(ctx: Context, supergroupChatId?: string): boolean {
    const chat = ctx.chat;
    if (!chat)
        return false;
    if (chat.type === 'private')
        return true;
    if (!supergroupChatId)
        return false;
    return String(chat.id) === supergroupChatId;
}

/**
 * Build the `{ message_thread_id }` fragment passed to grammY API calls.
 * Returns an empty object when no thread is requested so the spread is a
 * no-op and Telegram receives no `message_thread_id` (which is what the
 * General topic / DM shapes expect).
 */
export function threadParams(opts?: SendOptions): {
    message_thread_id?: number;
} {
    if (opts?.threadId === undefined)
        return {};
    return { message_thread_id: opts.threadId };
}
