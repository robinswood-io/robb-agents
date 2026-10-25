import { Bot, type Context } from "grammy";
import type { PlatformConfig, IncomingMessage, ButtonPress } from "../../../types";
import type { TelegramAdapter } from '../index.ts';
import { NOOP_LOGGER, withTimeout, describeError, isAcceptedChat } from './shared.ts';

export async function initialize(transportOwner: TelegramAdapter, config: PlatformConfig): Promise<void> {
    if (!config.token) {
        throw new Error('Telegram bot token is required');
    }
    transportOwner["log"] = config.logger ?? NOOP_LOGGER;
    transportOwner["bot"] = new Bot(config.token);
    if (config.acceptedSupergroupChatId) {
        transportOwner["supergroupChatId"] = config.acceptedSupergroupChatId;
    }
    // Handle incoming text messages.
    //
    // Narrow exception to `isAcceptedChat`: `/pair <code>` is allowed from
    // *any* chat, even if the workspace hasn't paired this chat yet. This is
    // the bootstrap mechanism that registers a supergroup — without this
    // exception, `/pair` typed in a fresh supergroup is silently dropped
    // (chicken-and-egg). Codes are workspace-scoped, single-use, 5-min TTL,
    // and rate-limited per-sender, so the exception is bounded.
    transportOwner["bot"].on('message:text', async (ctx: Context) => {
        if (!transportOwner["messageHandler"] || !ctx.message || !ctx.chat)
            return;
        const text = ctx.message.text ?? '';
        const isPairAttempt = /^\/pair(\s|$|@)/i.test(text);
        if (!isAcceptedChat(ctx, transportOwner["supergroupChatId"]) && !isPairAttempt) {
            transportOwner["logRejectedChat"]('message:text', ctx);
            return;
        }
        const threadId = transportOwner["extractThreadId"](ctx);
        const msg: IncomingMessage = {
            platform: 'telegram',
            channelId: String(ctx.chat.id),
            ...(threadId !== undefined ? { threadId } : {}),
            messageId: String(ctx.message.message_id),
            senderId: String(ctx.from?.id ?? ''),
            senderName: ctx.from?.first_name ?? undefined,
            ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
            ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
            text: ctx.message.text ?? '',
            timestamp: ctx.message.date * 1000,
            raw: ctx.message,
        };
        await transportOwner["messageHandler"](msg);
    });
    // Attachment handlers — photos, documents, voice, video, audio.
    // Each maps Telegram's source field onto a single helper that
    // downloads the blob to a temp file, then emits one IncomingMessage
    // with `attachments[0].localPath` set. The router resolves the path
    // via readFileAttachment() and forwards a FileAttachment to the session.
    transportOwner["bot"].on('message:photo', async (ctx: Context) => {
        if (!isAcceptedChat(ctx, transportOwner["supergroupChatId"])) {
            transportOwner["logRejectedChat"]('message:photo', ctx);
            return;
        }
        const photos = ctx.message?.photo;
        // Telegram returns multiple sizes; last one is the largest original.
        const largest = photos?.[photos.length - 1];
        if (!largest)
            return;
        await transportOwner["emitAttachmentMessage"](ctx, {
            type: 'photo',
            fileId: largest.file_id,
            fileSize: largest.file_size,
            mimeType: 'image/jpeg', // Telegram re-encodes photos to JPEG
        });
    });
    transportOwner["bot"].on('message:document', async (ctx: Context) => {
        if (!isAcceptedChat(ctx, transportOwner["supergroupChatId"])) {
            transportOwner["logRejectedChat"]('message:document', ctx);
            return;
        }
        const doc = ctx.message?.document;
        if (!doc)
            return;
        await transportOwner["emitAttachmentMessage"](ctx, {
            type: 'document',
            fileId: doc.file_id,
            fileName: doc.file_name,
            fileSize: doc.file_size,
            mimeType: doc.mime_type,
        });
    });
    transportOwner["bot"].on('message:voice', async (ctx: Context) => {
        if (!isAcceptedChat(ctx, transportOwner["supergroupChatId"])) {
            transportOwner["logRejectedChat"]('message:voice', ctx);
            return;
        }
        const voice = ctx.message?.voice;
        if (!voice)
            return;
        await transportOwner["emitAttachmentMessage"](ctx, {
            type: 'voice',
            fileId: voice.file_id,
            fileSize: voice.file_size,
            mimeType: voice.mime_type ?? 'audio/ogg',
        });
    });
    transportOwner["bot"].on('message:video', async (ctx: Context) => {
        if (!isAcceptedChat(ctx, transportOwner["supergroupChatId"])) {
            transportOwner["logRejectedChat"]('message:video', ctx);
            return;
        }
        const video = ctx.message?.video;
        if (!video)
            return;
        await transportOwner["emitAttachmentMessage"](ctx, {
            type: 'video',
            fileId: video.file_id,
            fileName: video.file_name,
            fileSize: video.file_size,
            mimeType: video.mime_type ?? 'video/mp4',
        });
    });
    transportOwner["bot"].on('message:audio', async (ctx: Context) => {
        if (!isAcceptedChat(ctx, transportOwner["supergroupChatId"])) {
            transportOwner["logRejectedChat"]('message:audio', ctx);
            return;
        }
        const audio = ctx.message?.audio;
        if (!audio)
            return;
        await transportOwner["emitAttachmentMessage"](ctx, {
            type: 'audio',
            fileId: audio.file_id,
            fileName: audio.file_name,
            fileSize: audio.file_size,
            mimeType: audio.mime_type ?? 'audio/mpeg',
        });
    });
    // Handle callback queries (button presses)
    transportOwner["bot"].on('callback_query:data', async (ctx: Context) => {
        if (!transportOwner["buttonHandler"] || !ctx.callbackQuery)
            return;
        if (!isAcceptedChat(ctx, transportOwner["supergroupChatId"])) {
            transportOwner["logRejectedChat"]('callback_query:data', ctx);
            // Answer the callback so Telegram stops showing the spinner, but
            // don't route it — same rationale as message handlers.
            await ctx.answerCallbackQuery().catch(() => { });
            return;
        }
        await ctx.answerCallbackQuery().catch(() => { });
        // The button is attached to a message; reading the message's thread id
        // ensures responses (allow/deny acks, plan accept confirmations) post
        // back into the same topic the prompt came from.
        const threadId = typeof ctx.callbackQuery.message?.message_thread_id === 'number'
            ? ctx.callbackQuery.message.message_thread_id
            : undefined;
        const press: ButtonPress = {
            platform: 'telegram',
            channelId: String(ctx.chat?.id ?? ''),
            ...(threadId !== undefined ? { threadId } : {}),
            messageId: String(ctx.callbackQuery.message?.message_id ?? ''),
            senderId: String(ctx.from?.id ?? ''),
            ...(ctx.from?.first_name ? { senderName: ctx.from.first_name } : {}),
            ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
            ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
            buttonId: ctx.callbackQuery.data ?? '',
            data: ctx.callbackQuery.data ?? undefined,
        };
        // Diagnostic for #726: timestamp callback receipt vs. handler return so
        // we can tell from logs whether the gateway is slow or grammY's
        // sequential polling is stalling on a previous update.
        const receivedAt = Date.now();
        transportOwner["log"].info('[telegram] callback_query received', {
            event: 'telegram_callback_received',
            buttonId: press.buttonId,
            senderId: press.senderId,
        });
        try {
            await transportOwner["buttonHandler"](press);
        }
        finally {
            transportOwner["log"].info('[telegram] callback_query handler returned', {
                event: 'telegram_callback_handled',
                buttonId: press.buttonId,
                senderId: press.senderId,
                elapsedMs: Date.now() - receivedAt,
            });
        }
    });
    transportOwner["log"].info('[telegram] initializing');
    // Clear any pre-existing webhook BEFORE bot.init(). grammY's Api client
    // works without init() (which only caches getMe), and if a webhook is set
    // (by a previous app run, another app, or BotFather), getUpdates returns
    // nothing and polling silently receives no messages. Doing this first
    // means even a slow/stuck init() can't prevent webhook cleanup.
    // drop_pending_updates=false preserves messages queued before the user
    // saved the token.
    try {
        await withTimeout(transportOwner["bot"].api.deleteWebhook({ drop_pending_updates: false }), 10000, 'deleteWebhook');
        transportOwner["log"].info('[telegram] deleteWebhook ok');
    }
    catch (err) {
        transportOwner["log"].warn('[telegram] deleteWebhook failed (non-fatal):', describeError(err));
    }
    // Surface token/network errors up-front (getMe). Without the timeout,
    // grammY retries transient errors indefinitely with no logs, which looks
    // identical to a deadlock from the outside.
    try {
        await withTimeout(transportOwner["bot"].init(), 10000, 'bot.init');
        transportOwner["log"].info('[telegram] bot.init ok', {
            username: transportOwner["bot"].botInfo?.username,
        });
    }
    catch (err) {
        transportOwner["log"].error('[telegram] bot.init failed:', describeError(err));
        throw err;
    }
    transportOwner["destroyed"] = false;
    transportOwner["reconnectAttempts"] = 0;
    transportOwner["startPolling"]();
    // Do NOT set this.connected = true here — wait for onStart.
}

/**
   * Launch polling. grammY's bot.start() runs until stop() is called or a
   * fatal error occurs. On unexpected failure we schedule a reconnect with
   * exponential backoff so transient issues (network blip, 409 from a
   * competing instance that quickly exits) self-heal without user action.
   *
   * 409 Conflict means another poller is active — we wait longer on the first
   * attempt to give the other instance time to exit before we retry.
   */
export function startPolling(transportOwner: TelegramAdapter): void {
    if (transportOwner["destroyed"] || !transportOwner["bot"])
        return;
    transportOwner["bot"].start({
        onStart: () => {
            transportOwner["connected"] = true;
            transportOwner["reconnectAttempts"] = 0;
            transportOwner["log"].info('[telegram] polling started');
            transportOwner["bot"]?.api.getWebhookInfo().then((info) => transportOwner["log"].info('[telegram] webhook state after start:', {
                url: info.url || null,
                pending_update_count: info.pending_update_count,
            }), () => { });
        },
    }).catch((err: unknown) => {
        transportOwner["connected"] = false;
        transportOwner["log"].error('[telegram] polling stopped with error:', describeError(err));
        if (!transportOwner["destroyed"]) {
            transportOwner["scheduleReconnect"](err);
        }
    });
}

export function scheduleReconnect(transportOwner: TelegramAdapter, err: unknown): void {
    if (transportOwner["destroyed"] || !transportOwner["bot"])
        return;
    transportOwner["reconnectAttempts"]++;
    // 409 = another poller is competing; wait 30 s before first retry so the
    // other process has a chance to exit. Other errors start at 5 s.
    const is409 = err instanceof Error && err.message.includes('409');
    const baseDelay = is409 ? 30000 : 5000;
    const delay = Math.min(baseDelay * Math.pow(2, transportOwner["reconnectAttempts"] - 1), 5 * 60000);
    transportOwner["log"].warn('[telegram] scheduling reconnect', {
        event: 'telegram_reconnect_scheduled',
        attempt: transportOwner["reconnectAttempts"],
        delayMs: delay,
        is409,
    });
    transportOwner["reconnectTimer"] = setTimeout(() => {
        transportOwner["reconnectTimer"] = null;
        if (transportOwner["destroyed"] || !transportOwner["bot"])
            return;
        transportOwner["log"].info('[telegram] attempting reconnect', {
            event: 'telegram_reconnect_attempt',
            attempt: transportOwner["reconnectAttempts"],
        });
        transportOwner["startPolling"]();
    }, delay);
}

export async function destroy(transportOwner: TelegramAdapter): Promise<void> {
    transportOwner["destroyed"] = true;
    transportOwner["connected"] = false;
    if (transportOwner["reconnectTimer"]) {
        clearTimeout(transportOwner["reconnectTimer"]);
        transportOwner["reconnectTimer"] = null;
    }
    if (transportOwner["bot"]) {
        await transportOwner["bot"].stop();
        transportOwner["bot"] = null;
    }
}
