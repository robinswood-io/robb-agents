import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { TelegramConfigPatch } from './shared.ts';
import type { MessagingBindingInfo, MessagingConfigInfo } from "@craft-agent/server-core/handlers";
import type { MessagingConfig, PlatformType } from "../types";
import type { MessagingGatewayRegistry } from '../registry.ts';
import { toBindingInfo, isPlatformConfigured, cloneRuntime } from './shared.ts';

export function getConfig(transportOwner: MessagingGatewayRegistry, workspaceId: string): MessagingConfigInfo | null {
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    const cfg = state.configStore.get();
    return {
        enabled: cfg.enabled,
        platforms: cfg.platforms as MessagingConfigInfo['platforms'],
        runtime: {
            telegram: cloneRuntime(state.runtime.telegram),
            whatsapp: cloneRuntime(state.runtime.whatsapp),
            lark: cloneRuntime(state.runtime.lark),
        },
    };
}

export async function updateConfig(transportOwner: MessagingGatewayRegistry, workspaceId: string, partial: Partial<MessagingConfigInfo>): Promise<void> {
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    state.configStore.update({
        enabled: partial.enabled,
        platforms: partial.platforms,
    } as never);
    const cfg = state.configStore.get();
    if (!cfg.enabled) {
        await state.gateway.unregisterAdapter('telegram').catch(() => { });
        await state.gateway.unregisterAdapter('whatsapp').catch(() => { });
        await state.gateway.unregisterAdapter('lark').catch(() => { });
        state.whatsappOffEvent?.();
        delete state.whatsappOffEvent;
        state.whatsapp = null;
        transportOwner["setPlatformRuntime"](workspaceId, state, 'telegram', {
            configured: false,
            connected: false,
            state: 'disconnected',
            identity: undefined,
            lastError: undefined,
        });
        transportOwner["setPlatformRuntime"](workspaceId, state, 'whatsapp', {
            configured: false,
            connected: false,
            state: 'disconnected',
            identity: undefined,
            lastError: undefined,
        });
        transportOwner["setPlatformRuntime"](workspaceId, state, 'lark', {
            configured: false,
            connected: false,
            state: 'disconnected',
            identity: undefined,
            lastError: undefined,
        });
        return;
    }
    for (const platform of ['telegram', 'whatsapp', 'lark'] as const) {
        const configured = isPlatformConfigured(cfg, platform);
        if (!configured && state.gateway.getAdapter(platform)) {
            await state.gateway.unregisterAdapter(platform).catch(() => { });
        }
        if (!configured && platform === 'whatsapp') {
            state.whatsappOffEvent?.();
            delete state.whatsappOffEvent;
            state.whatsapp = null;
        }
        if (!configured) {
            transportOwner["setPlatformRuntime"](workspaceId, state, platform, {
                configured: false,
                connected: false,
                state: 'disconnected',
                identity: undefined,
                lastError: undefined,
            });
        }
    }
}

export function getBindings(transportOwner: MessagingGatewayRegistry, workspaceId: string): MessagingBindingInfo[] {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return [];
    return state.gateway.getBindingStore().getAll().map(toBindingInfo);
}

export function unbindSession(transportOwner: MessagingGatewayRegistry, workspaceId: string, sessionId: string, platform?: string): void {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return;
    const removed = state.gateway
        .getBindingStore()
        .unbindSession(sessionId, platform as PlatformType | undefined);
    if (removed > 0)
        transportOwner.emitBindingChanged(workspaceId);
}

export function unbindBinding(transportOwner: MessagingGatewayRegistry, workspaceId: string, bindingId: string): boolean {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return false;
    const removed = state.gateway.getBindingStore().unbindById(bindingId);
    if (removed)
        transportOwner.emitBindingChanged(workspaceId);
    return removed;
}

// -------------------------------------------------------------------------
  // Access control — workspace owners + per-binding allow lists
  // -------------------------------------------------------------------------

  /**
   * Patch the Telegram platform config preserving any fields the caller
   * doesn't touch. Critical: every Telegram config write MUST go through
   * this helper — direct `configStore.update({ platforms: { telegram: {...} } })`
   * silently drops `owners` / `accessMode` / `supergroup` / `enabled` from
   * the persisted state because `ConfigStore.update` shallow-merges
   * `platforms` but replaces the per-platform value wholesale.
   *
   * `ensureMessagingEnabled` flips the top-level `enabled` flag to true
   * (used by save-token / connect flows). When false, `enabled` is
   * preserved as-is.
   */
export function patchTelegramConfig(transportOwner: MessagingGatewayRegistry, workspaceId: string, patch: TelegramConfigPatch, options: {
    ensureMessagingEnabled?: boolean;
}): MessagingConfig {
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    const cfg = state.configStore.get();
    const tg = cfg.platforms.telegram ?? { enabled: true };
    return state.configStore.update({
        enabled: options.ensureMessagingEnabled ? true : cfg.enabled,
        platforms: {
            ...cfg.platforms,
            telegram: omitUndefined<NonNullable<MessagingConfig['platforms']['telegram']>>({ ...tg, ...patch }),
        },
    });
}
