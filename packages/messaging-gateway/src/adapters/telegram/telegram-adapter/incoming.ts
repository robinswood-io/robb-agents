/**
 * TelegramAdapter — in-process adapter using grammY.
 *
 * Phase 1: polling mode, text-only, DM-only.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { type Context } from "grammy";
import type { IncomingAttachment, IncomingMessage } from "../../../types";
import type { TelegramAdapter } from '../index.ts';
import { MAX_ATTACHMENT_BYTES, MIME_EXT_FALLBACK, describeError } from './shared.ts';

/**
   * Download a Telegram file to a temp path and invoke the message handler
   * with the resulting IncomingMessage. Centralised here so the five
   * `bot.on(...)` handlers only need to pick the right source fields.
   *
   * Failures (oversize, 404, network) are reported back to the sender via
   * `ctx.reply()` and logged. The message is NOT forwarded in that case —
   * the session should not be woken for an attachment we couldn't deliver.
   */
export async function emitAttachmentMessage(transportOwner: TelegramAdapter, ctx: Context, meta: {
    type: IncomingAttachment['type'];
    fileId: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
}): Promise<void> {
    if (!transportOwner["messageHandler"] || !ctx.message || !ctx.chat || !transportOwner["bot"])
        return;
    // Size guard BEFORE hitting the file API — avoids the round-trip when
    // Telegram already told us the size up-front.
    if (meta.fileSize !== undefined && meta.fileSize > MAX_ATTACHMENT_BYTES) {
        transportOwner["log"].warn('[telegram] attachment too large, dropping', {
            type: meta.type,
            fileSize: meta.fileSize,
        });
        await ctx.reply(`Attachment too large (>${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB). Not forwarded.`).catch(() => { });
        return;
    }
    let downloaded: {
        localPath: string;
        fileName: string;
        fileSize: number;
    };
    try {
        downloaded = await transportOwner["downloadToTemp"](meta.fileId, meta.fileName ?? `${meta.type}-${Date.now()}`, meta.mimeType);
    }
    catch (err) {
        transportOwner["log"].error('[telegram] attachment download failed:', describeError(err));
        await ctx.reply('Failed to download your attachment. Please try again.').catch(() => { });
        return;
    }
    const attachment: IncomingAttachment = {
        type: meta.type,
        fileId: meta.fileId,
        fileName: downloaded.fileName,
        mimeType: meta.mimeType,
        fileSize: downloaded.fileSize,
        localPath: downloaded.localPath,
    };
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
        text: ctx.message.caption ?? '',
        attachments: [attachment],
        timestamp: ctx.message.date * 1000,
        raw: ctx.message,
    };
    await transportOwner["messageHandler"](msg);
}

/**
   * Resolve a Telegram `file_id` to a local path by calling `getFile()` to
   * obtain the remote path, then fetching the blob from the Bot API file
   * host and writing it to the OS temp dir. Enforces `MAX_ATTACHMENT_BYTES`
   * against the actual downloaded size in case `getFile` reported no size.
   */
export async function downloadToTemp(transportOwner: TelegramAdapter, fileId: string, fallbackName: string, mimeType: string | undefined): Promise<{
    localPath: string;
    fileName: string;
    fileSize: number;
}> {
    if (!transportOwner["bot"])
        throw new Error('Telegram adapter not initialized');
    const file = await transportOwner["bot"].api.getFile(fileId);
    if (!file.file_path) {
        throw new Error(`getFile returned no file_path for ${fileId}`);
    }
    if (file.file_size !== undefined && file.file_size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${file.file_size} bytes`);
    }
    // Extension: prefer whatever Telegram's file_path carries (it's normally
    // `photos/file_123.jpg` or similar), fall back to mime map, else `.bin`.
    let ext = extname(file.file_path);
    if (!ext && mimeType && MIME_EXT_FALLBACK[mimeType]) {
        ext = MIME_EXT_FALLBACK[mimeType];
    }
    if (!ext)
        ext = '.bin';
    // Normalise fileName — ensure it has the resolved extension so
    // readFileAttachment's extension-based type detection works.
    let fileName = fallbackName;
    if (!extname(fileName))
        fileName = `${fileName}${ext}`;
    const url = `https://api.telegram.org/file/bot${transportOwner["bot"].token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large after download: ${buf.byteLength} bytes`);
    }
    const localPath = join(tmpdir(), `craft-agent-messaging-${randomBytes(8).toString('hex')}${ext}`);
    writeFileSync(localPath, buf);
    return { localPath, fileName, fileSize: buf.byteLength };
}

/**
   * Emit one structured log line per dropped non-accepted update. Deliberately
   * `info` (not `debug`) so a user who notices "bot isn't responding in my
   * group" can confirm via logs without toggling levels.
   */
export function logRejectedChat(transportOwner: TelegramAdapter, handler: string, ctx: Context): void {
    transportOwner["log"].info('[telegram] ignored non-accepted chat update', {
        event: 'telegram_chat_rejected',
        handler,
        chatType: ctx.chat?.type,
        chatId: ctx.chat?.id,
    });
}

/**
   * Telegram-specific helper: extract the optional `message_thread_id` from
   * an inbound update. Returns undefined for DMs and for the General topic
   * (Telegram omits the field there).
   */
export function extractThreadId(transportOwner: TelegramAdapter, ctx: Context): number | undefined {
    const tid = ctx.message?.message_thread_id;
    return typeof tid === 'number' ? tid : undefined;
}
