import { Bot, type Context } from "grammy";
import type { PlatformAdapter, PlatformConfig, AdapterCapabilities, IncomingAttachment, IncomingMessage, SendOptions, SentMessage, InlineButton, ButtonPress, MessagingLogger } from "../../types";
import { NOOP_LOGGER } from './telegram-adapter/shared.ts';
import type { TelegramChatInfo } from './telegram-adapter/shared.ts';
import * as telegramAdapterConnection from './telegram-adapter/connection.ts';
import * as telegramAdapterIncoming from './telegram-adapter/incoming.ts';
import * as telegramAdapterMessages from './telegram-adapter/messages.ts';
export type { TelegramChatInfo } from './telegram-adapter/shared.ts';
export { isPrivateChat, isAcceptedChat } from './telegram-adapter/shared.ts';

export class TelegramAdapter implements PlatformAdapter {
    readonly platform = 'telegram' as const;
    readonly capabilities: AdapterCapabilities = {
        messageEditing: true,
        inlineButtons: true,
        maxButtons: 10,
        maxMessageLength: 4096,
        markdown: 'v2',
        // This adapter uses polling (grammY Bot#start). A webhook path is not
        // wired through the Electron main process, so advertising webhookSupport
        // would mislead the headless server bootstrap. Keep false until a proper
        // webhook handler exists.
        webhookSupport: false,
    };
    /** Fetch bot profile (username, display name). Used for UI hints. */
    async getBotInfo(): Promise<{
        id: number;
        username?: string;
        firstName?: string;
    } | null> {
        if (!this.bot)
            return null;
        try {
            const me = await this.bot.api.getMe();
            return { id: me.id, username: me.username, firstName: me.first_name };
        }
        catch {
            return null;
        }
    }
    private bot: Bot | null = null;
    private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
    private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null;
    private connected = false;
    private destroyed = false;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private log: MessagingLogger = NOOP_LOGGER;
    /**
     * The supergroup chatId this adapter accepts non-DM messages from.
     * Updated at runtime via `setAcceptedSupergroupChatId()` after the user
     * pairs/unpairs a supergroup in Settings, so polling doesn't need to
     * restart on reconfigure.
     */
    private supergroupChatId: string | undefined;
    private logRejectedChat(handler: string, ctx: Context): void {
        return telegramAdapterIncoming.logRejectedChat(this, handler, ctx);
    }
    /** Idempotent runtime reconfigure for the accepted supergroup chatId. */
    setAcceptedSupergroupChatId(chatId: string | undefined): void {
        this.supergroupChatId = chatId;
        this.log.info('[telegram] accepted supergroup updated', {
            event: 'telegram_supergroup_set',
            supergroupChatId: chatId ?? null,
        });
    }
    /**
     * Resolve a chat's metadata via Bot API. Returns `null` on any failure
     * (network, "chat not found", missing permissions, etc.). The caller is
     * expected to handle the null case explicitly — for the supergroup-pairing
     * flow that means refusing to bind, rather than guessing defaults.
     *
     * Forum supergroups are the only chat type that can host topics. The
     * `isForum` flag distinguishes a regular supergroup from one with topics
     * enabled, which is required for Phase B's `createForumTopic` to work.
     */
    async getChatInfo(chatId: string): Promise<TelegramChatInfo | null> {
        return telegramAdapterMessages.getChatInfo(this, chatId);
    }
    private extractThreadId(ctx: Context): number | undefined {
        return telegramAdapterIncoming.extractThreadId(this, ctx);
    }
    async initialize(config: PlatformConfig): Promise<void> {
        return telegramAdapterConnection.initialize(this, config);
    }
    private async emitAttachmentMessage(ctx: Context, meta: {
        type: IncomingAttachment['type'];
        fileId: string;
        fileName?: string;
        fileSize?: number;
        mimeType?: string;
    }): Promise<void> {
        return telegramAdapterIncoming.emitAttachmentMessage(this, ctx, meta);
    }
    private async downloadToTemp(fileId: string, fallbackName: string, mimeType: string | undefined): Promise<{
        localPath: string;
        fileName: string;
        fileSize: number;
    }> {
        return telegramAdapterIncoming.downloadToTemp(this, fileId, fallbackName, mimeType);
    }
    private startPolling(): void {
        return telegramAdapterConnection.startPolling(this);
    }
    private scheduleReconnect(err: unknown): void {
        return telegramAdapterConnection.scheduleReconnect(this, err);
    }
    async destroy(): Promise<void> {
        return telegramAdapterConnection.destroy(this);
    }
    isConnected(): boolean {
        return this.connected;
    }
    onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
        this.messageHandler = handler;
    }
    onButtonPress(handler: (press: ButtonPress) => Promise<void>): void {
        this.buttonHandler = handler;
    }
    async sendText(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage> {
        return telegramAdapterMessages.sendText(this, channelId, text, opts);
    }
    async editMessage(channelId: string, messageId: string, text: string, _opts?: SendOptions): Promise<void> {
        return telegramAdapterMessages.editMessage(this, channelId, messageId, text, _opts);
    }
    async sendButtons(channelId: string, text: string, buttons: InlineButton[], opts?: SendOptions): Promise<SentMessage> {
        return telegramAdapterMessages.sendButtons(this, channelId, text, buttons, opts);
    }
    async sendTyping(channelId: string, opts?: SendOptions): Promise<void> {
        return telegramAdapterMessages.sendTyping(this, channelId, opts);
    }
    async sendFile(channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage> {
        return telegramAdapterMessages.sendFile(this, channelId, file, filename, caption, opts);
    }
    async clearButtons(channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
        return telegramAdapterMessages.clearButtons(this, channelId, messageId, _opts);
    }
    /**
     * Phase B prep: create a new forum topic in a supergroup. Telegram returns
     * `{ message_thread_id, name, ... }`; we surface a normalised shape.
     *
     * Requires the bot to have "Manage Topics" admin permission in the
     * supergroup. If the call fails (privilege missing, chat is not a forum,
     * etc.), the error propagates so the caller can surface it.
     *
     * `iconColor` is intentionally omitted from this stub — grammY's typing
     * accepts only the six Telegram-defined palette ints. We'll plumb it
     * properly in Phase B when the automation feature actually picks colours.
     */
    async createForumTopic(chatId: string, name: string): Promise<{
        threadId: number;
        name: string;
    }> {
        return telegramAdapterMessages.createForumTopic(this, chatId, name);
    }
}
