import * as lark from "@larksuiteoapi/node-sdk";
import type { MessagingLogger } from "../../../types";

/**
 * Hard cap for downloaded attachment size. Matches Telegram's MAX_ATTACHMENT_BYTES
 * — files larger than this would be rejected by `readFileAttachment` anyway, so
 * we fail fast in the adapter with a user-visible reply.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const NOOP_LOGGER: MessagingLogger = {
    info: () => { },
    warn: () => { },
    error: () => { },
    child: () => NOOP_LOGGER,
};

/**
 * Credential payload for a Lark/Feishu bot.
 *
 * Stored as a JSON string in the `messaging_bearer` credential row (one row
 * per workspace+platform). Single existing schema, no migrations.
 */
export interface LarkCredentials {
    appId: string;
    appSecret: string;
    /**
     * Which Open Platform domain to talk to. Lark and Feishu are separate
     * ecosystems — a Lark bot only works against open.larksuite.com,
     * a Feishu bot only against open.feishu.cn.
     */
    domain: 'lark' | 'feishu';
}

/**
 * Parse the JSON-encoded credentials from `PlatformConfig.token`.
 *
 * Throws with a clear message if the input is malformed — surfaces as
 * `state: 'error'` with a user-readable `lastError` in the registry.
 */
export function parseLarkCredentials(token: string | undefined): LarkCredentials {
    if (!token)
        throw new Error('Lark credentials are missing');
    let parsed: unknown;
    try {
        parsed = JSON.parse(token);
    }
    catch {
        throw new Error('Lark credentials are not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Lark credentials must be a JSON object');
    }
    const { appId, appSecret, domain } = parsed as Record<string, unknown>;
    if (typeof appId !== 'string' || appId.length === 0) {
        throw new Error('Lark credentials are missing `appId`');
    }
    if (typeof appSecret !== 'string' || appSecret.length === 0) {
        throw new Error('Lark credentials are missing `appSecret`');
    }
    if (domain !== 'lark' && domain !== 'feishu') {
        throw new Error('Lark credentials `domain` must be "lark" or "feishu"');
    }
    return { appId, appSecret, domain };
}

/**
 * Map our `'lark' | 'feishu'` selector to the SDK's `Domain` enum.
 */
export function resolveLarkDomain(domain: 'lark' | 'feishu'): lark.Domain {
    return domain === 'feishu' ? lark.Domain.Feishu : lark.Domain.Lark;
}

/**
 * Strip a leading `<at user_id="...">…</at> ` prefix from a Lark text message
 * content. Lark prepends the @mention as a literal in the content, but the
 * agent only cares about what comes after.
 */
export function stripMentionPrefix(text: string): string {
    return text.replace(/^<at[^>]*>[^<]*<\/at>\s*/, '').trim();
}

/**
 * Narrow projection over the SDK's `Client` for the methods we actually call.
 * The SDK's full type union is enormous (~250k lines) and changes shape between
 * minor versions; pinning a hand-rolled interface keeps our adapter loosely
 * coupled and the ts-checker happy.
 */
export interface LarkClient {
    im: {
        message: {
            create: (args: {
                params: {
                    receive_id_type: 'chat_id' | 'open_id' | 'union_id';
                };
                data: {
                    receive_id: string;
                    msg_type: string;
                    content: string;
                    uuid?: string;
                };
            }) => Promise<{
                data?: {
                    message_id?: string;
                };
            } | null>;
            update: (args: {
                path: {
                    message_id: string;
                };
                data: {
                    msg_type: string;
                    content: string;
                };
            }) => Promise<unknown>;
            patch: (args: {
                path: {
                    message_id: string;
                };
                data: {
                    content: string;
                };
            }) => Promise<unknown>;
        };
        file: {
            create: (args: {
                data: {
                    file_type: string;
                    file_name: string;
                    file: Buffer;
                };
            }) => Promise<{
                file_key?: string;
            } | null>;
        };
        image: {
            create: (args: {
                data: {
                    image_type: 'message' | 'avatar';
                    image: Buffer;
                };
            }) => Promise<{
                image_key?: string;
            } | null>;
        };
    };
}

/**
 * Flat shape after the SDK's `EventDispatcher.parse()` unwraps the v2 envelope.
 * The dispatcher merges `{schema, header, event}` into a single object before
 * invoking handlers, so payload fields land at the top level — there is no
 * outer `.event` accessor.
 */
export interface LarkMessageEvent {
    sender: {
        sender_id?: {
            user_id?: string;
            open_id?: string;
            union_id?: string;
        };
    };
    message: {
        message_id: string;
        chat_id: string;
        chat_type: string;
        message_type: string;
        content: string;
        create_time: string;
        mentions?: Array<{
            key: string;
            id: {
                user_id?: string;
            };
            name: string;
        }>;
    };
}

/**
 * Card-action press event after the SDK's `EventDispatcher.parse()` flattens
 * the v2 envelope. Schema 2.0 nests the chat id under `context` instead of
 * at the top level — handle both shapes so the same code path works for v1
 * and v2 cards.
 */
export interface LarkCardActionEvent {
    operator?: {
        user_id?: string;
        open_id?: string;
        union_id?: string;
    };
    /** Schema 1.0 location for the chat id. */
    open_chat_id?: string;
    /** Schema 2.0 location — `context.open_chat_id` and friends. */
    context?: {
        open_chat_id?: string;
        open_message_id?: string;
    };
    action?: {
        value?: unknown;
        tag?: string;
    };
}
