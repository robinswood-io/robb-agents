/**
 * MessagingGatewayRegistry — owns per-workspace MessagingGateway instances.
 *
 * Responsibilities:
 *   - Satisfies IMessagingGatewayRegistry for the RPC handlers in server-core.
 *   - Acts as a single EventSink consumer fanning session events to the right gateway.
 *   - Owns the in-memory pairing code manager (shared across workspaces; codes are workspace-scoped).
 *   - Owns per-workspace MessagingConfig (messaging/config.json).
 *   - Owns platform adapter lifecycle (initialize/swap/destroy) via CredentialManager.
 *
 * The registry is constructed once, wired into HandlerDeps, then populated with
 * gateways via initializeWorkspace() for every workspace that has messaging enabled.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RPC_CHANNELS } from "@craft-agent/shared/protocol";
import { TelegramAdapter } from "../adapters/telegram/index";
import { WhatsAppAdapter, type WhatsAppEvent } from "../adapters/whatsapp/index";
import { LarkAdapter, parseLarkCredentials, type LarkCredentials } from "../adapters/lark/index";
import type { MessagingGatewayRegistry } from '../registry.ts';
import type { WorkspaceState } from './shared.ts';

export async function startWhatsAppConnect(transportOwner: MessagingGatewayRegistry, workspaceId: string): Promise<void> {
    const waConfig = transportOwner["opts"].whatsapp;
    if (!waConfig) {
        throw new Error('WhatsApp support is not configured on this server');
    }
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
        configured: true,
        connected: false,
        state: 'connecting',
        lastError: undefined,
    });
    await transportOwner["startWhatsAppAdapter"](workspaceId, state, { persistConfig: true, reason: 'user_connect' });
}

export async function submitWhatsAppPhone(transportOwner: MessagingGatewayRegistry, workspaceId: string, phoneNumber: string): Promise<void> {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state?.whatsapp) {
        throw new Error('WhatsApp not started — call startWhatsAppConnect first');
    }
    const cleaned = phoneNumber.replace(/[^\d]/g, '');
    if (cleaned.length < 8)
        throw new Error('Phone number looks too short');
    await state.whatsapp.requestPairingCode(cleaned);
}

export async function startWhatsAppAdapter(transportOwner: MessagingGatewayRegistry, workspaceId: string, state: WorkspaceState, options: {
    persistConfig: boolean;
    reason: 'restore' | 'user_connect';
}): Promise<void> {
    const waConfig = transportOwner["opts"].whatsapp;
    if (!waConfig) {
        throw new Error('WhatsApp support is not configured on this server');
    }
    state.whatsappOffEvent?.();
    state.whatsappOffEvent = undefined;
    if (state.whatsapp) {
        await state.whatsapp.destroy().catch(() => { });
        state.whatsapp = null;
    }
    const adapter = new WhatsAppAdapter();
    state.whatsapp = adapter;
    state.whatsappOffEvent = adapter.onEvent((ev) => transportOwner["onWhatsAppEvent"](workspaceId, ev));
    // selfChatMode: default ON. Persisted to workspace config so it
    // survives restart and can be toggled later if the user wants pure
    // contact-only routing.
    const persistedCfg = state.configStore.get();
    const selfChatMode = persistedCfg.platforms.whatsapp?.selfChatMode ?? true;
    await adapter.initialize({
        workerEntry: waConfig.workerEntry,
        nodeBin: waConfig.nodeBin,
        authStateDir: transportOwner["getWhatsAppAuthStateDir"](workspaceId),
        pairingMode: waConfig.pairingMode ?? 'code',
        selfChatMode,
        logger: transportOwner["log"].child({
            component: 'whatsapp-adapter',
            workspaceId,
            platform: 'whatsapp',
        }),
    });
    state.gateway.registerAdapter(adapter);
    if (options.persistConfig) {
        state.configStore.update({
            enabled: true,
            platforms: { whatsapp: { enabled: true, selfChatMode } },
        });
    }
    await state.gateway.start();
    transportOwner["log"].info('WhatsApp adapter started', {
        event: 'whatsapp_adapter_started',
        workspaceId,
        reason: options.reason,
    });
}

export function onWhatsAppEvent(transportOwner: MessagingGatewayRegistry, workspaceId: string, event: WhatsAppEvent): void {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return;
    transportOwner["opts"].publishEvent?.(RPC_CHANNELS.messaging.WA_UI_EVENT, { to: 'workspace', workspaceId }, { workspaceId, event });
    switch (event.type) {
        case 'qr':
            transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
                configured: true,
                connected: false,
                state: 'reconnect_required',
                lastError: 'QR scan required',
            });
            return;
        case 'connected':
            transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
                configured: true,
                connected: true,
                state: 'connected',
                identity: event.name ?? event.jid,
                lastError: undefined,
            });
            return;
        case 'disconnected':
            transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
                configured: true,
                connected: false,
                state: event.loggedOut ? 'reconnect_required' : 'disconnected',
                lastError: event.reason,
                identity: undefined,
            });
            return;
        case 'unavailable':
            transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
                configured: true,
                connected: false,
                state: 'error',
                lastError: event.message,
                identity: undefined,
            });
            return;
        case 'error':
            if (!state.runtime.whatsapp.connected) {
                transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
                    configured: true,
                    connected: false,
                    state: 'error',
                    lastError: event.message,
                });
            }
            return;
        case 'pairing_code':
            return;
    }
}

export async function tryConnectLark(transportOwner: MessagingGatewayRegistry, workspaceId: string, state: WorkspaceState): Promise<void> {
    const cred = await transportOwner["opts"].credentialManager
        .get({ type: 'messaging_bearer', workspaceId, name: 'lark' })
        .catch(() => null);
    if (!cred?.value) {
        transportOwner["setPlatformRuntime"](workspaceId, state, 'lark', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: 'Lark credentials are missing.',
        });
        return;
    }
    let creds: LarkCredentials;
    try {
        creds = parseLarkCredentials(cred.value);
    }
    catch (err) {
        transportOwner["setPlatformRuntime"](workspaceId, state, 'lark', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: err instanceof Error ? err.message : 'Lark credentials are malformed',
        });
        return;
    }
    await state.gateway.unregisterAdapter('lark').catch((err) => {
        transportOwner["log"].warn('unregisterAdapter(lark) failed (non-fatal)', {
            event: 'lark_unregister_failed',
            workspaceId,
            error: err,
        });
    });
    try {
        const adapter = new LarkAdapter();
        await adapter.initialize({
            token: cred.value,
            logger: transportOwner["log"].child({
                component: 'lark-adapter',
                workspaceId,
                platform: 'lark',
            }),
        });
        try {
            const info = await adapter.getBotInfo();
            state.botUsernames.lark = info?.name;
        }
        catch {
            // non-fatal
        }
        state.gateway.registerAdapter(adapter);
        transportOwner["setPlatformRuntime"](workspaceId, state, 'lark', {
            configured: true,
            connected: true,
            state: 'connected',
            identity: state.botUsernames.lark ?? creds.domain,
            lastError: undefined,
        });
    }
    catch (err) {
        transportOwner["log"].error('failed to connect Lark', {
            event: 'lark_connect_failed',
            workspaceId,
            error: err,
        });
        transportOwner["setPlatformRuntime"](workspaceId, state, 'lark', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}

export async function tryConnectTelegram(transportOwner: MessagingGatewayRegistry, workspaceId: string, state: WorkspaceState): Promise<void> {
    const cred = await transportOwner["opts"].credentialManager
        .get({ type: 'messaging_bearer', workspaceId, name: 'telegram' })
        .catch(() => null);
    if (!cred?.value) {
        transportOwner["setPlatformRuntime"](workspaceId, state, 'telegram', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: 'Telegram token is missing.',
        });
        return;
    }
    await state.gateway.unregisterAdapter('telegram').catch((err) => {
        transportOwner["log"].warn('unregisterAdapter(telegram) failed (non-fatal)', {
            event: 'telegram_unregister_failed',
            workspaceId,
            error: err,
        });
    });
    try {
        const adapter = new TelegramAdapter();
        const supergroupChatId = state.configStore.get().platforms.telegram?.supergroup?.chatId;
        await adapter.initialize({
            token: cred.value,
            ...(supergroupChatId ? { acceptedSupergroupChatId: supergroupChatId } : {}),
            logger: transportOwner["log"].child({
                component: 'telegram-adapter',
                workspaceId,
                platform: 'telegram',
            }),
        });
        try {
            const info = await adapter.getBotInfo();
            state.botUsernames.telegram = info?.username;
        }
        catch {
            // non-fatal
        }
        state.gateway.registerAdapter(adapter);
        transportOwner["setPlatformRuntime"](workspaceId, state, 'telegram', {
            configured: true,
            connected: true,
            state: 'connected',
            identity: state.botUsernames.telegram,
            lastError: undefined,
        });
    }
    catch (err) {
        transportOwner["log"].error('failed to connect Telegram', {
            event: 'telegram_connect_failed',
            workspaceId,
            error: err,
        });
        transportOwner["setPlatformRuntime"](workspaceId, state, 'telegram', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}

export function hasWhatsAppAuthState(transportOwner: MessagingGatewayRegistry, workspaceId: string): boolean {
    const dir = transportOwner["getWhatsAppAuthStateDir"](workspaceId);
    if (!existsSync(dir))
        return false;
    try {
        return readdirSync(dir).some((entry) => !entry.startsWith('.'));
    }
    catch {
        return false;
    }
}

export function getWhatsAppAuthStateDir(transportOwner: MessagingGatewayRegistry, workspaceId: string): string {
    return join(transportOwner["opts"].getMessagingDir(workspaceId), 'whatsapp-auth');
}
