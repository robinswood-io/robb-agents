import * as lark from "@larksuiteoapi/node-sdk";
import type { PlatformAdapter, PlatformConfig, AdapterCapabilities, IncomingMessage, SentMessage, InlineButton, ButtonPress, MessagingLogger, SendOptions } from "../../types";
import { LARK_MAX_BUTTONS } from "./card";
import { NOOP_LOGGER } from './lark-adapter/shared.ts';
import type { LarkClient, LarkMessageEvent, LarkCardActionEvent } from './lark-adapter/shared.ts';
import * as larkAdapterConnection from './lark-adapter/connection.ts';
import * as larkAdapterMessages from './lark-adapter/messages.ts';
import * as larkAdapterIncoming from './lark-adapter/incoming.ts';
export type { LarkCredentials } from './lark-adapter/shared.ts';
export { parseLarkCredentials } from './lark-adapter/shared.ts';

export class LarkAdapter implements PlatformAdapter {
    readonly platform = 'lark' as const;
    readonly capabilities: AdapterCapabilities = {
        messageEditing: true,
        inlineButtons: true,
        maxButtons: LARK_MAX_BUTTONS,
        maxMessageLength: 30000,
        markdown: 'lark-post',
        webhookSupport: false,
    };
    private client: LarkClient | null = null;
    private wsClient: lark.WSClient | null = null;
    /** @internal */ public messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
    /** @internal */ public buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null;
    private connected = false;
    private log: MessagingLogger = NOOP_LOGGER;
    /**
     * Track each outbound message's wire `msg_type` so `editMessage` can dispatch
     * to `update` (text/post) vs `patch` (interactive card) correctly. Lark
     * requires the new `msg_type` to match the original.
     */
    private sentMsgTypes = new Map<string, 'text' | 'post' | 'interactive'>();
    /** Fetch bot profile for UI hints. */
    async getBotInfo(): Promise<{
        name?: string;
    } | null> {
        if (!this.client)
            return null;
        try {
            const result = await this.client.request<unknown>({
                url: '/open-apis/bot/v3/info', method: 'GET',
            });
            if (!result || typeof result !== 'object' || !('bot' in result)) return null;
            const bot = result.bot;
            if (!bot || typeof bot !== 'object' || !('app_name' in bot)) return null;
            const name = typeof bot.app_name === 'string' ? bot.app_name : undefined;
            return name ? { name } : null;
        }
        catch {
            return null;
        }
    }
    async initialize(config: PlatformConfig): Promise<void> {
        return larkAdapterConnection.initialize(this, config);
    }
    async destroy(): Promise<void> {
        return larkAdapterConnection.destroy(this);
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
    // -------------------------------------------------------------------------
    // Outbound — sends, edits, files, cards
    // -------------------------------------------------------------------------
    async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
        return larkAdapterMessages.sendText(this, channelId, text, _opts);
    }
    async editMessage(channelId: string, messageId: string, text: string, _opts?: SendOptions): Promise<void> {
        return larkAdapterMessages.editMessage(this, channelId, messageId, text, _opts);
    }
    async sendButtons(channelId: string, text: string, buttons: InlineButton[], _opts?: SendOptions): Promise<SentMessage> {
        return larkAdapterMessages.sendButtons(this, channelId, text, buttons, _opts);
    }
    async clearButtons(channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
        return larkAdapterMessages.clearButtons(this, channelId, messageId, _opts);
    }
    async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
        // Lark has no typing-indicator API. No-op.
    }
    async sendFile(channelId: string, file: Buffer, filename: string, caption?: string, _opts?: SendOptions): Promise<SentMessage> {
        return larkAdapterMessages.sendFile(this, channelId, file, filename, caption, _opts);
    }
    private async handleIncomingMessage(data: LarkMessageEvent): Promise<void> {
        return larkAdapterIncoming.handleIncomingMessage(this, data);
    }
    /** @internal */ public async handleAttachmentMessage(data: LarkMessageEvent): Promise<void> {
        return larkAdapterIncoming.handleAttachmentMessage(this, data);
    }
    /** @internal */ public async downloadResource(args: {
        messageId: string;
        fileKey: string;
        filename: string;
        isImage: boolean;
    }): Promise<string | null> {
        return larkAdapterIncoming.downloadResource(this, args);
    }
    private async handleCardAction(data: LarkCardActionEvent): Promise<void> {
        return larkAdapterIncoming.handleCardAction(this, data);
    }
}
