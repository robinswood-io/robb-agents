import { parseJsonObject } from '@craft-agent/shared/utils/json';
/**
 * LarkAdapter — Lark / Feishu in-process adapter.
 *
 * Transport: long-polling via `@larksuiteoapi/node-sdk`'s `WSClient`. No public
 * webhook URL needed (correct fit for desktop / electron). Same lifecycle
 * shape as the Telegram adapter, just a different SDK underneath.
 *
 * Phase 1 scope (text only): receive text in DMs and group @mentions, send
 * text replies, support `/pair`-style commands. Phase 2 layers on edits,
 * interactive cards, attachments, and Markdown→post rich-text formatting.
 */
import { statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingAttachment, IncomingMessage, ButtonPress } from "../../../types";
import type { LarkAdapter } from '../index.ts';
import { MAX_ATTACHMENT_BYTES, stripMentionPrefix } from './shared.ts';
import type { LarkMessageEvent, LarkCardActionEvent } from './shared.ts';

// -------------------------------------------------------------------------
  // Inbound — message + card events
  // -------------------------------------------------------------------------
export async function handleIncomingMessage(transportOwner: LarkAdapter, data: LarkMessageEvent): Promise<void> {
    if (!transportOwner.messageHandler)
        return;
    const { sender, message } = data;
    // Visibility log: if this never fires, the bot isn't getting the event
    // from Lark. Most common causes: missing `im:message` scope, missing
    // event subscription, or app not published.
    transportOwner["log"].info('[lark] event received', {
        event: 'lark_event_received',
        messageType: message.message_type,
        chatType: message.chat_type,
        chatId: message.chat_id,
        messageId: message.message_id,
    });
    const senderId = sender.sender_id?.user_id ?? sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? '';
    // Phase 2: support text + image + file. Other types (audio/video/sticker/etc.)
    // are dropped with an info log so users can see the bot received the event
    // but can't process it.
    if (message.message_type === 'text') {
        let text: string;
        try {
            const parsed = JSON.parse(message.content) as {
                text?: string;
            };
            text = parsed.text ?? '';
        }
        catch {
            text = '';
        }
        const cleaned = stripMentionPrefix(text);
        const msg: IncomingMessage = {
            platform: 'lark',
            channelId: message.chat_id,
            messageId: message.message_id,
            senderId,
            text: cleaned,
            timestamp: parseInt(message.create_time, 10) || Date.now(),
            raw: message,
        };
        await transportOwner.messageHandler(msg);
        return;
    }
    if (message.message_type === 'image' || message.message_type === 'file') {
        await transportOwner.handleAttachmentMessage(data);
        return;
    }
    // Unhandled type — log and drop.
    transportOwner["log"].info('[lark] dropped unsupported message type', {
        event: 'lark_unsupported_msg_type',
        messageType: message.message_type,
        messageId: message.message_id,
        chatId: message.chat_id,
    });
}

export async function handleAttachmentMessage(transportOwner: LarkAdapter, data: LarkMessageEvent): Promise<void> {
    if (!transportOwner["client"] || !transportOwner.messageHandler)
        return;
    const { sender, message } = data;
    const senderId = sender.sender_id?.user_id ?? sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? '';
    let parsedContent: Record<string, unknown>;
    try {
        parsedContent = parseJsonObject(message.content);
    }
    catch {
        transportOwner["log"].warn('[lark] could not parse attachment content', {
            event: 'lark_attachment_parse_failed',
            messageId: message.message_id,
        });
        return;
    }
    const isImage = message.message_type === 'image';
    const candidateKey = isImage ? parsedContent['image_key'] : parsedContent['file_key'];
    const fileKey = typeof candidateKey === 'string' ? candidateKey : undefined;
    if (!fileKey) {
        transportOwner["log"].warn('[lark] attachment missing key', {
            event: 'lark_attachment_no_key',
            messageId: message.message_id,
        });
        return;
    }
    const fallbackName = isImage
        ? `image-${randomBytes(4).toString('hex')}.jpg`
        : (typeof parsedContent['file_name'] === 'string' ? parsedContent['file_name'] : undefined) ?? `file-${randomBytes(4).toString('hex')}.bin`;
    const localPath = await transportOwner.downloadResource({
        messageId: message.message_id,
        fileKey,
        filename: fallbackName,
        isImage,
    });
    if (!localPath)
        return;
    const incomingAttachment: IncomingAttachment = {
        type: isImage ? 'photo' : 'document',
        fileId: fileKey,
        fileName: fallbackName,
        localPath,
    };
    const msg: IncomingMessage = {
        platform: 'lark',
        channelId: message.chat_id,
        messageId: message.message_id,
        senderId,
        text: '',
        attachments: [incomingAttachment],
        timestamp: parseInt(message.create_time, 10) || Date.now(),
        raw: message,
    };
    await transportOwner.messageHandler(msg);
}

/**
   * Download a Lark resource (image or file) to a local temp path.
   *
   * Lark resource URLs require bearer-token auth; we can't hand a URL to the
   * router. Instead we stream the binary to a temp file and emit `localPath`,
   * matching the Telegram pattern.
   */
export async function downloadResource(transportOwner: LarkAdapter, args: {
    messageId: string;
    fileKey: string;
    filename: string;
    isImage: boolean;
}): Promise<string | null> {
    if (!transportOwner["client"])
        return null;
    try {
        const sdkResource = await transportOwner["client"].im.messageResource.get({
            path: { message_id: args.messageId, file_key: args.fileKey },
            params: { type: args.isImage ? 'image' : 'file' },
        });
        const ext = extname(args.filename) || (args.isImage ? '.jpg' : '.bin');
        const localPath = join(tmpdir(), `lark-${randomBytes(8).toString('hex')}${ext}`);
        await sdkResource.writeFile(localPath);
        if (statSync(localPath).size > MAX_ATTACHMENT_BYTES) {
            unlinkSync(localPath);
            throw new Error('Lark attachment exceeds size limit');
        }
        return localPath;
    }
    catch (err: unknown) {
        transportOwner["log"].warn('[lark] resource download failed', {
            event: 'lark_resource_download_failed',
            messageId: args.messageId,
            fileKey: args.fileKey,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

export async function handleCardAction(transportOwner: LarkAdapter, data: LarkCardActionEvent): Promise<void> {
    // Visibility log: if this never fires when the user presses a button,
    // the missing piece is on the Lark Open Platform side — schema-2.0
    // cards only emit `card.action.trigger` events when the app has the
    // **Card Callback Communication** subscription enabled under
    // Events & Callbacks (separate from `im.message.receive_v1`).
    const channelId = data.context?.open_chat_id ?? data.open_chat_id ?? '';
    transportOwner["log"].info('[lark] card action received', {
        event: 'lark_card_action_received',
        chatId: channelId,
        tag: data.action?.tag,
        hasValue: data.action?.value !== undefined,
    });
    if (!transportOwner.buttonHandler)
        return;
    const value = data.action?.value as {
        buttonId?: string;
        messageId?: string;
        data?: string;
    } | undefined;
    if (!value?.buttonId || !value?.messageId) {
        transportOwner["log"].warn('[lark] card action missing correlation ids', {
            event: 'lark_card_action_no_ids',
            operator: data.operator,
        });
        return;
    }
    const operator = data.operator;
    const senderId = operator?.user_id ?? operator?.open_id ?? operator?.union_id ?? '';
    const press: ButtonPress = {
        platform: 'lark',
        channelId,
        messageId: value.messageId,
        buttonId: value.buttonId,
        senderId,
        ...(value.data !== undefined ? { data: value.data } : {}),
    };
    await transportOwner.buttonHandler(press);
}
