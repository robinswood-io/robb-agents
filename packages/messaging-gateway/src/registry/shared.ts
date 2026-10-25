import type { PushTarget } from "@craft-agent/shared/protocol";
import type { CredentialManager } from "@craft-agent/shared/credentials";
import type { ISessionManager, MessagingBindingInfo } from "@craft-agent/server-core/handlers";
import { MessagingGateway } from "../gateway";
import { ConfigStore } from "../config-store";
import { WhatsAppAdapter } from "../adapters/whatsapp/index";
import { TopicRegistry } from "../topic-registry";
import type { ChannelBinding, MessagingLogger, MessagingPlatformRuntimeInfo, PlatformOwner, PlatformType } from "../types";

export const consoleLogger: MessagingLogger = {
    info: (message, meta) => console.log('[MessagingRegistry]', message, meta ?? ''),
    warn: (message, meta) => console.warn('[MessagingRegistry]', message, meta ?? ''),
    error: (message, meta) => console.error('[MessagingRegistry]', message, meta ?? ''),
    child(context) {
        return {
            info: (message, meta) => console.log('[MessagingRegistry]', context, message, meta ?? ''),
            warn: (message, meta) => console.warn('[MessagingRegistry]', context, message, meta ?? ''),
            error: (message, meta) => console.error('[MessagingRegistry]', context, message, meta ?? ''),
            child: (next) => consoleLogger.child({ ...context, ...next }),
        };
    },
};

export interface MessagingGatewayRegistryOptions {
    sessionManager: ISessionManager;
    credentialManager: CredentialManager;
    /** Absolute path to the messaging storage directory for the given workspace. */
    getMessagingDir: (workspaceId: string) => string;
    /** Optional legacy messaging dir (pre-relocation) for one-shot migration. */
    getLegacyMessagingDir?: (workspaceId: string) => string | undefined;
    /** Broadcasts an RPC push event to UI clients. No-op if undefined. */
    publishEvent?: (channel: string, target: PushTarget, ...args: unknown[]) => void;
    /** Optional WhatsApp worker config — required to enable the WhatsApp adapter. */
    whatsapp?: {
        /** Absolute path to the worker entry (packaged/unpacked from @craft-agent/messaging-whatsapp-worker). */
        workerEntry: string;
        /** Node binary override (defaults to process.execPath with ELECTRON_RUN_AS_NODE). */
        nodeBin?: string;
        /** Pairing flow: 'qr' or 'code'. Defaults to 'code' (phone-number based). */
        pairingMode?: 'qr' | 'code';
    };
    /** Optional logger — shared with the gateway and adapters. */
    logger?: MessagingLogger;
}

export interface WorkspaceState {
    gateway: MessagingGateway;
    configStore: ConfigStore;
    topicRegistry: TopicRegistry;
    botUsernames: Partial<Record<PlatformType, string>>;
    whatsapp: WhatsAppAdapter | null;
    whatsappOffEvent?: () => void;
    runtime: Record<PlatformType, MessagingPlatformRuntimeInfo>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function toBindingInfo(b: ChannelBinding): MessagingBindingInfo {
    return {
        id: b.id,
        workspaceId: b.workspaceId,
        sessionId: b.sessionId,
        platform: b.platform,
        channelId: b.channelId,
        ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
        channelName: b.channelName,
        enabled: b.enabled,
        createdAt: b.createdAt,
        accessMode: b.config.accessMode,
        allowedSenderIds: [...b.config.allowedSenderIds],
    };
}

export function isKnownPlatform(p: string): p is PlatformType {
    return p === 'telegram' || p === 'whatsapp' || p === 'lark';
}

export function capitalize(value: string): string {
    return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

export function isPlatformConfigured(config: {
    enabled: boolean;
    platforms: Record<string, {
        enabled: boolean;
    } | undefined>;
}, platform: PlatformType): boolean {
    return Boolean(config.enabled && config.platforms[platform]?.enabled);
}

export function dedupeOwners(owners: PlatformOwner[]): PlatformOwner[] {
    const map = new Map<string, PlatformOwner>();
    for (const o of owners) {
        if (!o?.userId)
            continue;
        map.set(o.userId, { ...o });
    }
    return Array.from(map.values());
}

export function createRuntime(platform: PlatformType, configured: boolean): MessagingPlatformRuntimeInfo {
    return {
        platform,
        configured,
        connected: false,
        state: configured ? 'disconnected' : 'disconnected',
        updatedAt: Date.now(),
    };
}

export function cloneRuntime(runtime: MessagingPlatformRuntimeInfo): MessagingPlatformRuntimeInfo {
    return { ...runtime };
}

export async function fetchTelegramBotInfo(token: string): Promise<{
    ok: boolean;
    result: {
        username?: string;
        first_name?: string;
    };
    description?: string;
}> {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    return (await res.json()) as {
        ok: boolean;
        result: {
            username?: string;
            first_name?: string;
        };
        description?: string;
    };
}
