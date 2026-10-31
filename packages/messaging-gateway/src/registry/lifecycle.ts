import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { PlatformRuntimePatch } from './shared.ts';
import { RPC_CHANNELS } from "@craft-agent/shared/protocol";
import { MessagingGateway } from "../gateway";
import { ConfigStore } from "../config-store";
import { TopicRegistry } from "../topic-registry";
import type { MessagingPlatformRuntimeInfo, PlatformType } from "../types";
import type { MessagingGatewayRegistry } from '../registry.ts';
import { isKnownPlatform, isPlatformConfigured, createRuntime, cloneRuntime } from './shared.ts';
import type { WorkspaceState } from './shared.ts';

export async function initializeWorkspace(transportOwner: MessagingGatewayRegistry, workspaceId: string): Promise<void> {
    if (transportOwner["workspaces"].has(workspaceId))
        return;
    const state = transportOwner["bootstrapWorkspace"](workspaceId);
    const config = state.configStore.get();
    if (!config.enabled)
        return;
    await state.gateway.start();
    transportOwner["log"].info('gateway started for workspace', {
        event: 'gateway_started',
        workspaceId,
    });
    if (isPlatformConfigured(config, 'telegram')) {
        transportOwner["setPlatformRuntime"](workspaceId, state, 'telegram', {
            configured: true,
            connected: false,
            state: 'connecting',
            lastError: undefined,
        });
        void transportOwner["tryConnectTelegram"](workspaceId, state).catch((err: unknown) => {
            transportOwner["log"].error('background Telegram connect failed', {
                event: 'telegram_connect_failed',
                workspaceId,
                error: err,
            });
        });
    }
    if (isPlatformConfigured(config, 'lark')) {
        transportOwner["setPlatformRuntime"](workspaceId, state, 'lark', {
            configured: true,
            connected: false,
            state: 'connecting',
            lastError: undefined,
        });
        void transportOwner["tryConnectLark"](workspaceId, state).catch((err: unknown) => {
            transportOwner["log"].error('background Lark connect failed', {
                event: 'lark_connect_failed',
                workspaceId,
                error: err,
            });
        });
    }
    if (isPlatformConfigured(config, 'whatsapp')) {
        if (transportOwner.hasWhatsAppAuthState(workspaceId)) {
            transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
                configured: true,
                connected: false,
                state: 'connecting',
                lastError: undefined,
            });
            void transportOwner.startWhatsAppAdapter(workspaceId, state, { persistConfig: false, reason: 'restore' }).catch((err: unknown) => {
                transportOwner["log"].error('background WhatsApp restore failed', {
                    event: 'whatsapp_restore_failed',
                    workspaceId,
                    error: err,
                });
                transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
                    configured: true,
                    connected: false,
                    state: 'error',
                    lastError: err instanceof Error ? err.message : String(err),
                });
            });
        }
        else {
            transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
                configured: true,
                connected: false,
                state: 'reconnect_required',
                lastError: 'WhatsApp needs to be linked again.',
            });
        }
    }
}

export async function removeWorkspace(transportOwner: MessagingGatewayRegistry, workspaceId: string): Promise<void> {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return;
    await state.gateway.stop();
    transportOwner["pairing"].clearWorkspace(workspaceId);
    transportOwner["workspaces"].delete(workspaceId);
}

export async function stopAll(transportOwner: MessagingGatewayRegistry): Promise<void> {
    const stops = Array.from(transportOwner["workspaces"].values()).map((s) => s.gateway.stop().catch(() => { }));
    await Promise.all(stops);
    transportOwner["workspaces"].clear();
}

// -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------
export function bootstrapWorkspace(transportOwner: MessagingGatewayRegistry, workspaceId: string): WorkspaceState {
    const existing = transportOwner["workspaces"].get(workspaceId);
    if (existing)
        return existing;
    const storageDir = transportOwner["opts"].getMessagingDir(workspaceId);
    const legacyStorageDir = transportOwner["opts"].getLegacyMessagingDir?.(workspaceId);
    const baseLog = transportOwner["log"].child({ workspaceId });
    const configStore = new ConfigStore(storageDir, legacyStorageDir, baseLog.child({ component: 'config-store' }));
    const cfg = configStore.get();
    const gateway = new MessagingGateway({
        sessionManager: transportOwner["opts"].sessionManager,
        workspaceId,
        storageDir,
        ...(legacyStorageDir !== undefined ? { legacyStorageDir: legacyStorageDir } : {}),
        logger: baseLog,
        pairingConsumer: {
            canConsume: (platform, senderId) => transportOwner["pairing"].canConsume(workspaceId, platform, senderId),
            consume: (platform, code) => {
                const entry = transportOwner["pairing"].consume(workspaceId, platform, code);
                if (!entry)
                    return null;
                if (entry.kind === 'workspace-supergroup') {
                    return { kind: 'workspace-supergroup', workspaceId: entry.workspaceId };
                }
                // entry.kind === 'session'
                if (!entry.sessionId)
                    return null;
                return { kind: 'session', workspaceId: entry.workspaceId, sessionId: entry.sessionId };
            },
            bindWorkspaceSupergroup: async ({ platform, chatId, fallbackTitle }) => {
                if (!isKnownPlatform(platform)) {
                    throw new Error(`Unknown platform for supergroup pairing: ${platform}`);
                }
                return transportOwner["bindWorkspaceSupergroup"](workspaceId, platform, chatId, fallbackTitle);
            },
        },
        // Read live config so accessMode/owner toggles take effect immediately.
        getWorkspaceConfig: () => configStore.get(),
        seedOwnerOnFirstPair: async (platform, candidate) => transportOwner.seedFirstOwner(workspaceId, platform, candidate),
        onBindingChanged: () => transportOwner.emitBindingChanged(workspaceId),
        onPendingChanged: () => transportOwner.emitPendingChanged(workspaceId),
    });
    const topicRegistry = new TopicRegistry(storageDir, baseLog.child({ component: 'topic-registry' }));
    const state: WorkspaceState = {
        gateway,
        configStore,
        topicRegistry,
        botUsernames: {},
        whatsapp: null,
        runtime: {
            telegram: createRuntime('telegram', isPlatformConfigured(cfg, 'telegram')),
            whatsapp: createRuntime('whatsapp', isPlatformConfigured(cfg, 'whatsapp')),
            lark: createRuntime('lark', isPlatformConfigured(cfg, 'lark')),
        },
    };
    transportOwner["workspaces"].set(workspaceId, state);
    return state;
}

export function setPlatformRuntime(transportOwner: MessagingGatewayRegistry, workspaceId: string, state: WorkspaceState, platform: PlatformType, patch: PlatformRuntimePatch): void {
    const previous = state.runtime[platform] ?? createRuntime(platform, false);
    const next = omitUndefined<MessagingPlatformRuntimeInfo>({
        ...previous,
        ...patch,
        platform,
        updatedAt: Date.now(),
    });
    state.runtime[platform] = next;
    transportOwner.emitPlatformStatus(workspaceId, platform, next);
}

export function emitPlatformStatus(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType, status: MessagingPlatformRuntimeInfo): void {
    transportOwner["opts"].publishEvent?.(RPC_CHANNELS.messaging.PLATFORM_STATUS, { to: 'workspace', workspaceId }, workspaceId, platform, cloneRuntime(status));
}
