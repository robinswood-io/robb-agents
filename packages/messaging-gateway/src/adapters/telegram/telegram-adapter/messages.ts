import { InputFile } from "grammy";
import type { SendOptions, SentMessage, InlineButton } from "../../../types";
import { formatForTelegram } from "../format";
import type { TelegramAdapter } from '../index.ts';
import { threadParams } from './shared.ts';
import type { TelegramChatInfo } from './shared.ts';

export async function getChatInfo(transportOwner: TelegramAdapter, chatId: string): Promise<TelegramChatInfo | null> {
    if (!transportOwner["bot"])
        return null;
    try {
        const chat = await transportOwner["bot"].api.getChat(Number(chatId));
        if (chat.type === 'supergroup') {
            return {
                type: 'supergroup',
                isForum: Boolean((chat as {
                    is_forum?: boolean;
                }).is_forum),
                title: chat.title ?? `Group ${chatId}`,
            };
        }
        return {
            type: chat.type,
            title: 'title' in chat && typeof chat.title === 'string' ? chat.title : undefined,
        };
    }
    catch {
        return null;
    }
}

export async function sendText(transportOwner: TelegramAdapter, channelId: string, text: string, opts?: SendOptions): Promise<SentMessage> {
    if (!transportOwner["bot"])
        throw new Error('Telegram adapter not initialized');
    const formatted = formatForTelegram(text);
    const sent = await transportOwner["bot"].api.sendMessage(Number(channelId), formatted, threadParams(opts));
    return {
        platform: 'telegram',
        channelId,
        messageId: String(sent.message_id),
    };
}

export async function editMessage(transportOwner: TelegramAdapter, channelId: string, messageId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!transportOwner["bot"])
        throw new Error('Telegram adapter not initialized');
    const formatted = formatForTelegram(text);
    // editMessageText is keyed by (chat_id, message_id) — Telegram does not
    // accept message_thread_id here. We accept the option for caller
    // uniformity but ignore it.
    await transportOwner["bot"].api.editMessageText(Number(channelId), Number(messageId), formatted);
}

export async function sendButtons(transportOwner: TelegramAdapter, channelId: string, text: string, buttons: InlineButton[], opts?: SendOptions): Promise<SentMessage> {
    if (!transportOwner["bot"])
        throw new Error('Telegram adapter not initialized');
    const keyboard = {
        inline_keyboard: buttons.map((b) => [{
                text: b.label,
                callback_data: b.id,
            }]),
    };
    const sent = await transportOwner["bot"].api.sendMessage(Number(channelId), text, {
        reply_markup: keyboard,
        ...threadParams(opts),
    });
    return {
        platform: 'telegram',
        channelId,
        messageId: String(sent.message_id),
    };
}

export async function sendTyping(transportOwner: TelegramAdapter, channelId: string, opts?: SendOptions): Promise<void> {
    if (!transportOwner["bot"])
        return;
    await transportOwner["bot"].api
        .sendChatAction(Number(channelId), 'typing', threadParams(opts))
        .catch(() => { });
}

export async function sendFile(transportOwner: TelegramAdapter, channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage> {
    if (!transportOwner["bot"])
        throw new Error('Telegram adapter not initialized');
    const inputFile = new InputFile(file, filename);
    const sent = await transportOwner["bot"].api.sendDocument(Number(channelId), inputFile, { caption, ...threadParams(opts) });
    return {
        platform: 'telegram',
        channelId,
        messageId: String(sent.message_id),
    };
}

export async function clearButtons(transportOwner: TelegramAdapter, channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
    if (!transportOwner["bot"])
        return;
    try {
        // editMessageReplyMarkup is also keyed by (chat_id, message_id) only.
        await transportOwner["bot"].api.editMessageReplyMarkup(Number(channelId), Number(messageId), {
            reply_markup: { inline_keyboard: [] },
        });
    }
    catch {
        // Non-fatal: message may have been deleted by the user or already cleared.
    }
}

export async function createForumTopic(transportOwner: TelegramAdapter, chatId: string, name: string): Promise<{
    threadId: number;
    name: string;
}> {
    if (!transportOwner["bot"])
        throw new Error('Telegram adapter not initialized');
    const result = await transportOwner["bot"].api.createForumTopic(Number(chatId), name);
    return { threadId: result.message_thread_id, name: result.name };
}
