import type { SentMessage, InlineButton, SendOptions } from "../../../types";
import { formatForLarkPost, wrapAsTrivialPost, type LarkPost } from "../format";
import { buildLarkCard, buildClearedCard, isLarkEditExpiredError, LARK_MAX_BUTTONS } from "../card";
import type { LarkAdapter } from '../index.ts';

export async function sendText(transportOwner: LarkAdapter, channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    if (!transportOwner["client"])
        throw new Error('Lark adapter is not connected');
    const formatted = formatForLarkPost(text);
    const { msgType, content } = formatted.kind === 'text'
        ? { msgType: 'text' as const, content: JSON.stringify({ text: formatted.text }) }
        : { msgType: 'post' as const, content: JSON.stringify(formatted.post) };
    const result = await transportOwner["client"].im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: channelId, msg_type: msgType, content },
    });
    const messageId = result?.data?.message_id ?? '';
    if (messageId)
        transportOwner["sentMsgTypes"].set(messageId, msgType);
    return { platform: 'lark', channelId, messageId };
}

export async function editMessage(transportOwner: LarkAdapter, _channelId: string, messageId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!transportOwner["client"])
        throw new Error('Lark adapter is not connected');
    const originalType = transportOwner["sentMsgTypes"].get(messageId) ?? 'text';
    // Cards are patched, not updated — different API.
    if (originalType === 'interactive') {
        // Editing an active card replaces its text body but keeps the buttons.
        // For the text-only edit path the renderer takes, we fall back to a
        // cleared-card patch (text without buttons), matching the Telegram
        // behaviour where a final-text edit removes the button row.
        try {
            await transportOwner["client"].im.message.patch({
                path: { message_id: messageId },
                data: { content: JSON.stringify(buildClearedCard(text)) },
            });
        }
        catch (err: unknown) {
            if (isLarkEditExpiredError(err))
                return;
            throw err;
        }
        return;
    }
    // text or post — match the original type so Lark accepts the update.
    let content: string;
    let msgType: 'text' | 'post';
    if (originalType === 'post') {
        // If the new content has formatting, format it; otherwise wrap as
        // a trivial post so the msg_type still matches the original.
        const formatted = formatForLarkPost(text);
        const post: LarkPost = formatted.kind === 'post' ? formatted.post : wrapAsTrivialPost(text);
        content = JSON.stringify(post);
        msgType = 'post';
    }
    else {
        content = JSON.stringify({ text });
        msgType = 'text';
    }
    try {
        await transportOwner["client"].im.message.update({
            path: { message_id: messageId },
            data: { msg_type: msgType, content },
        });
    }
    catch (err: unknown) {
        if (isLarkEditExpiredError(err))
            return;
        throw err;
    }
}

export async function sendButtons(transportOwner: LarkAdapter, channelId: string, text: string, buttons: InlineButton[], _opts?: SendOptions): Promise<SentMessage> {
    if (!transportOwner["client"])
        throw new Error('Lark adapter is not connected');
    if (buttons.length > LARK_MAX_BUTTONS) {
        transportOwner["log"].warn('[lark] too many buttons; truncating to cap', {
            event: 'lark_button_cap',
            requested: buttons.length,
            cap: LARK_MAX_BUTTONS,
        });
    }
    // Send the card without the messageId in the buttons' value — we don't
    // know the messageId until after the create. Fix this up in two stages:
    // 1) post the card with a placeholder; 2) extract the returned message_id
    //    and patch the card with the real value. Phase 2 acceptance is good
    //    enough — the press handler can look up the binding from chat_id alone
    //    if needed, but storing the id keeps gated routing simple.
    const placeholderCard = buildLarkCard(text, buttons, { messageId: 'pending' });
    const cardJson = JSON.stringify(placeholderCard);
    // Wrap the API call so any payload-shape / scope / quota issues surface
    // in our logs with a structured `lark_send_card_failed` event instead of
    // bubbling up unannotated through the renderer's outer catch. We also
    // post a plain-text fallback so the user always sees *something* in the
    // chat when the rich card path breaks, then re-throw so the renderer
    // can record the failure.
    let messageId = '';
    try {
        const result = await transportOwner["client"].im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: channelId,
                msg_type: 'interactive',
                content: cardJson,
            },
        });
        messageId = result?.data?.message_id ?? '';
        transportOwner["log"].info('[lark] sent card', {
            event: 'lark_send_card_ok',
            chatId: channelId,
            messageId,
            buttonCount: Math.min(buttons.length, LARK_MAX_BUTTONS),
        });
    }
    catch (err: unknown) {
        // The SDK wraps every error in axios's `AxiosError`. The actual
        // Lark-side reason (code + msg) lives at `err.response.data`, NOT at
        // the top level — extract it so the log line is actually useful.
        const errObj = (err ?? {}) as {
            code?: unknown;
            msg?: unknown;
            message?: unknown;
            response?: {
                status?: unknown;
                data?: unknown;
            };
        };
        const responseData = (errObj.response?.data ?? null) as {
            code?: unknown;
            msg?: unknown;
            error?: unknown;
        } | null;
        transportOwner["log"].error('[lark] failed to send card', {
            event: 'lark_send_card_failed',
            chatId: channelId,
            httpStatus: typeof errObj.response?.status === 'number' ? errObj.response.status : undefined,
            larkCode: typeof responseData?.code === 'number'
                ? responseData.code
                : typeof errObj.code === 'number'
                    ? errObj.code
                    : undefined,
            larkMsg: typeof responseData?.msg === 'string'
                ? responseData.msg
                : typeof errObj.msg === 'string'
                    ? errObj.msg
                    : undefined,
            larkError: responseData?.error,
            error: err instanceof Error ? err.message : String(err),
            payloadSize: cardJson.length,
            payloadPreview: cardJson.slice(0, 500),
            buttonCount: buttons.length,
        });
        // Best-effort plain-text fallback so the user knows something happened.
        // Failures here are non-fatal — we still re-throw the original card error.
        try {
            await transportOwner["sendText"](channelId, `${text}\n\n(Open the desktop app to respond — the in-chat buttons couldn't be sent.)`, _opts);
        }
        catch {
            // Swallowed — the renderer's outer handler will see the original throw.
        }
        throw err;
    }
    if (messageId) {
        transportOwner["sentMsgTypes"].set(messageId, 'interactive');
        // Patch with the real message_id baked into each button's value so card
        // press events carry the correct correlation.
        try {
            const realCard = buildLarkCard(text, buttons, { messageId });
            await transportOwner["client"].im.message.patch({
                path: { message_id: messageId },
                data: { content: JSON.stringify(realCard) },
            });
        }
        catch (err: unknown) {
            // Non-fatal — the card already exists with placeholder ids; press
            // routing will fall back to looking up by chat_id.
            if (!isLarkEditExpiredError(err)) {
                transportOwner["log"].warn('[lark] failed to patch card with real messageId', {
                    event: 'lark_card_patch_failed',
                    messageId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    return { platform: 'lark', channelId, messageId };
}

export async function clearButtons(transportOwner: LarkAdapter, channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
    if (!transportOwner["client"])
        return;
    void channelId;
    try {
        await transportOwner["client"].im.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(buildClearedCard('')) },
        });
    }
    catch (err: unknown) {
        if (isLarkEditExpiredError(err))
            return;
        transportOwner["log"].warn('[lark] clearButtons failed', {
            event: 'lark_clear_buttons_failed',
            messageId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export async function sendFile(transportOwner: LarkAdapter, channelId: string, file: Buffer, filename: string, caption?: string, _opts?: SendOptions): Promise<SentMessage> {
    if (!transportOwner["client"])
        throw new Error('Lark adapter is not connected');
    const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(filename);
    let content: string;
    let msgType: 'image' | 'file';
    if (isImage) {
        const upload = await transportOwner["client"].im.image.create({
            data: { image_type: 'message', image: file },
        });
        const imageKey = upload?.image_key;
        if (!imageKey)
            throw new Error('Lark image upload returned no image_key');
        content = JSON.stringify({ image_key: imageKey });
        msgType = 'image';
    }
    else {
        const upload = await transportOwner["client"].im.file.create({
            data: { file_type: 'stream', file_name: filename, file: file },
        });
        const fileKey = upload?.file_key;
        if (!fileKey)
            throw new Error('Lark file upload returned no file_key');
        content = JSON.stringify({ file_key: fileKey, file_name: filename });
        msgType = 'file';
    }
    const result = await transportOwner["client"].im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: channelId, msg_type: msgType, content },
    });
    const messageId = result?.data?.message_id ?? '';
    // Lark can't combine caption + file in one message. If the caller wants a
    // caption, send it as a follow-up text message (best-effort).
    if (caption) {
        transportOwner["sendText"](channelId, caption).catch((err: unknown) => {
            transportOwner["log"].warn('[lark] caption follow-up failed', {
                event: 'lark_caption_failed',
                messageId,
                error: err instanceof Error ? err.message : String(err),
            });
        });
    }
    return { platform: 'lark', channelId, messageId };
}
