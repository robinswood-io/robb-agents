import { TelegramAdapter } from "../adapters/telegram/index";
import type { PlatformType } from "../types";
import type { MessagingGatewayRegistry } from '../registry.ts';
import { isKnownPlatform, capitalize } from './shared.ts';

export function generatePairingCode(transportOwner: MessagingGatewayRegistry, workspaceId: string, sessionId: string, platform: string): {
    code: string;
    expiresAt: number;
    botUsername?: string;
} {
    if (!isKnownPlatform(platform)) {
        throw new Error(`Unknown messaging platform: ${platform}`);
    }
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    if (!state.gateway.hasConnectedAdapter(platform)) {
        throw new Error(`${capitalize(platform)} is not connected`);
    }
    const gen = transportOwner["pairing"].generate(workspaceId, sessionId, platform);
    transportOwner["log"].info('pairing code generated', {
        event: 'pairing_generated',
        workspaceId,
        sessionId,
        platform,
        expiresAt: gen.expiresAt,
    });
    return {
        code: gen.code,
        expiresAt: gen.expiresAt,
        botUsername: state.botUsernames[platform],
    };
}

export function generateSupergroupPairingCode(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: string): {
    code: string;
    expiresAt: number;
    botUsername?: string;
} {
    if (!isKnownPlatform(platform)) {
        throw new Error(`Unknown messaging platform: ${platform}`);
    }
    if (platform !== 'telegram') {
        throw new Error('Workspace-supergroup pairing is only supported on Telegram.');
    }
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    if (!state.gateway.hasConnectedAdapter(platform)) {
        throw new Error(`${capitalize(platform)} is not connected`);
    }
    const gen = transportOwner["pairing"].generateForSupergroup(workspaceId, platform);
    transportOwner["log"].info('supergroup pairing code generated', {
        event: 'pairing_generated',
        kind: 'workspace-supergroup',
        workspaceId,
        platform,
        expiresAt: gen.expiresAt,
    });
    return {
        code: gen.code,
        expiresAt: gen.expiresAt,
        botUsername: state.botUsernames[platform],
    };
}

export async function bindWorkspaceSupergroup(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType, chatId: string, fallbackTitle?: string): Promise<{
    title: string;
}> {
    if (platform !== 'telegram') {
        throw new Error('Workspace-supergroup pairing is only supported on Telegram.');
    }
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined;
    if (!adapter) {
        throw new Error('Telegram adapter is not running. Connect the bot first.');
    }
    // Validate the chat is actually a forum supergroup before binding.
    // Without this, `/pair` typed in a DM (or a basic group, or a regular
    // supergroup without topics) "succeeds" at command level but breaks
    // downstream when `createForumTopic` runs — Telegram returns
    // `400: Bad Request: the chat is not a forum`.
    const info = await adapter.getChatInfo(chatId);
    if (!info) {
        throw new Error('Cannot pair as supergroup: unable to read chat metadata. ' +
            'The bot may have been removed from the chat or lost permission to read it.');
    }
    if (info.type !== 'supergroup') {
        throw new Error(`Cannot pair as supergroup: chat type is "${info.type}" — must be a supergroup. ` +
            'DMs and basic groups cannot host topics.');
    }
    if (!info.isForum) {
        throw new Error('Cannot pair as supergroup: the supergroup does not have topics enabled. ' +
            'In Telegram, open the group → Edit → enable "Topics", then try /pair again.');
    }
    const title = info.title || fallbackTitle || `Group ${chatId}`;
    transportOwner["patchTelegramConfig"](workspaceId, {
        enabled: true,
        supergroup: { chatId, title, capturedAt: Date.now() },
    }, { ensureMessagingEnabled: true });
    adapter.setAcceptedSupergroupChatId(chatId);
    transportOwner["log"].info('workspace supergroup bound', {
        event: 'workspace_supergroup_bound',
        workspaceId,
        platform,
        chatId,
        title,
    });
    return { title };
}

export async function unbindWorkspaceSupergroup(transportOwner: MessagingGatewayRegistry, workspaceId: string): Promise<void> {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return;
    const cfg = state.configStore.get();
    const tg = cfg.platforms.telegram;
    if (!tg?.supergroup)
        return;
    // Drop the supergroup field but keep owners / accessMode / enabled
    // intact. JSON.stringify drops `undefined` values, so this is
    // effectively a key-deletion.
    transportOwner["patchTelegramConfig"](workspaceId, { supergroup: undefined });
    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined;
    adapter?.setAcceptedSupergroupChatId(undefined);
    transportOwner["log"].info('workspace supergroup unbound', {
        event: 'workspace_supergroup_unbound',
        workspaceId,
    });
}

export function getWorkspaceSupergroup(transportOwner: MessagingGatewayRegistry, workspaceId: string): {
    chatId: string;
    title: string;
    capturedAt: number;
} | null {
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    const sg = state.configStore.get().platforms.telegram?.supergroup;
    return sg ? { ...sg } : null;
}

export async function bindAutomationSession(transportOwner: MessagingGatewayRegistry, args: {
    workspaceId: string;
    sessionId: string;
    topicName: string;
}): Promise<{
    ok: true;
    chatId: string;
    threadId: number;
    reused: boolean;
} | {
    ok: false;
    reason: 'invalid-name' | 'no-supergroup' | 'no-adapter' | 'topic-create-failed';
    error?: string;
}> {
    const trimmed = args.topicName?.trim() ?? '';
    if (trimmed.length === 0 || trimmed.length > 128) {
        return { ok: false, reason: 'invalid-name' };
    }
    const state = transportOwner["workspaces"].get(args.workspaceId) ?? transportOwner["bootstrapWorkspace"](args.workspaceId);
    const supergroup = state.configStore.get().platforms.telegram?.supergroup;
    if (!supergroup?.chatId)
        return { ok: false, reason: 'no-supergroup' };
    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined;
    if (!adapter)
        return { ok: false, reason: 'no-adapter' };
    const beforeCacheHit = state.topicRegistry.get(trimmed);
    try {
        const entry = await state.topicRegistry.findOrCreate({
            topicName: trimmed,
            chatId: supergroup.chatId,
            createTopic: (name) => adapter.createForumTopic(supergroup.chatId, name),
        });
        state.gateway.getBindingStore().bind(args.workspaceId, args.sessionId, 'telegram', entry.chatId, trimmed, undefined, entry.threadId);
        transportOwner["emitBindingChanged"](args.workspaceId);
        return {
            ok: true,
            chatId: entry.chatId,
            threadId: entry.threadId,
            reused: Boolean(beforeCacheHit),
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        transportOwner["log"].warn('automation topic bind failed', {
            event: 'automation_topic_bind_failed',
            workspaceId: args.workspaceId,
            sessionId: args.sessionId,
            topicName: trimmed,
            error: message,
        });
        return { ok: false, reason: 'topic-create-failed', error: message };
    }
}

export async function removeAutomationTopic(transportOwner: MessagingGatewayRegistry, workspaceId: string, topicName: string): Promise<void> {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return;
    await state.topicRegistry.remove(topicName.trim());
}
