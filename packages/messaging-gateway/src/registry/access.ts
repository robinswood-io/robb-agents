import type { BindingAccessMode, PendingSender, PlatformAccessMode, PlatformOwner, PlatformType } from "../types";
import type { MessagingGatewayRegistry } from '../registry.ts';
import { dedupeOwners } from './shared.ts';

/**
   * Append `candidate` to the platform's owners list iff the list is
   * currently empty. Returns the (possibly unchanged) list. Used by the
   * gateway's `/pair` flow to bootstrap the first owner.
   */
export async function seedFirstOwner(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType, candidate: PlatformOwner): Promise<PlatformOwner[]> {
    if (platform !== 'telegram')
        return [];
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    const cfg = state.configStore.get();
    const currentOwners = cfg.platforms.telegram?.owners ?? [];
    if (currentOwners.length > 0)
        return currentOwners;
    const nextOwners: PlatformOwner[] = [candidate];
    // Workspaces that haven't picked an explicit access mode default
    // to `owner-only` once an owner exists. Existing 'open' workspaces
    // are respected (the operator chose to stay public).
    transportOwner["patchTelegramConfig"](workspaceId, {
        accessMode: cfg.platforms.telegram?.accessMode ?? 'owner-only',
        owners: nextOwners,
    });
    transportOwner["log"].info('seeded first owner', {
        event: 'first_owner_seeded',
        workspaceId,
        platform,
        ownerId: candidate.userId,
    });
    return nextOwners;
}

export function getPlatformOwners(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType): PlatformOwner[] {
    if (platform !== 'telegram')
        return [];
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    return state.configStore.get().platforms.telegram?.owners ?? [];
}

export function setPlatformOwners(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType, owners: PlatformOwner[]): PlatformOwner[] {
    if (platform !== 'telegram') {
        throw new Error('Owner lists are only supported on Telegram in this build.');
    }
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    transportOwner["patchTelegramConfig"](workspaceId, { owners: dedupeOwners(owners) });
    transportOwner["emitBindingChanged"](workspaceId);
    return state.configStore.get().platforms.telegram?.owners ?? [];
}

export function getPlatformAccessMode(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType): PlatformAccessMode {
    if (platform !== 'telegram')
        return 'open';
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    return state.configStore.get().platforms.telegram?.accessMode ?? 'open';
}

export function setPlatformAccessMode(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType, mode: PlatformAccessMode): void {
    if (platform !== 'telegram') {
        throw new Error('Access mode is only supported on Telegram in this build.');
    }
    transportOwner["patchTelegramConfig"](workspaceId, { accessMode: mode });
    // Lock-down semantics: switching the workspace to `owner-only` must
    // also close any binding that's still in `open` mode, otherwise the
    // operator clicks "Lock down", the banner disappears, but legacy
    // bindings remain public — exactly the false-sense-of-security UX
    // the feature is supposed to prevent.
    if (mode === 'owner-only') {
        transportOwner["migrateOpenBindingsToInherit"](workspaceId);
    }
    transportOwner["emitBindingChanged"](workspaceId);
}

/**
   * Walk all Telegram bindings and flip any with `accessMode === 'open'`
   * to `inherit` (the safe default). Used when locking down the workspace.
   * Telegram-only — other platforms don't yet have per-binding access.
   */
export function migrateOpenBindingsToInherit(transportOwner: MessagingGatewayRegistry, workspaceId: string): void {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return;
    const store = state.gateway.getBindingStore();
    for (const b of store.getAll()) {
        if (b.platform !== 'telegram')
            continue;
        if (b.config.accessMode !== 'open')
            continue;
        store.updateBindingConfig(b.id, { accessMode: 'inherit', allowedSenderIds: [] });
    }
}

export function getPendingSenders(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform?: PlatformType): PendingSender[] {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return [];
    return state.gateway.getPendingStore().list(platform);
}

export function dismissPendingSender(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType, userId: string): boolean {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return false;
    return state.gateway.getPendingStore().dismiss(platform, userId);
}

export function allowPendingSender(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: PlatformType, userId: string, entryKey?: {
    reason?: PendingSender['reason'];
    bindingId?: string;
}): {
    owners: PlatformOwner[];
    bindingId?: string;
} {
    if (platform !== 'telegram') {
        throw new Error('Owner lists are only supported on Telegram in this build.');
    }
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    const pending = state.gateway.getPendingStore().list(platform);
    const match = pending.find((p) => p.userId === userId &&
        (entryKey?.reason === undefined ||
            (p.reason ?? 'not-owner') === entryKey.reason) &&
        (entryKey?.bindingId === undefined || p.bindingId === entryKey.bindingId));
    if (!match) {
        throw new Error('Pending sender not found — they may have been dismissed.');
    }
    const reason = match.reason ?? 'not-owner';
    if (reason === 'not-on-binding-allowlist') {
        // Append to that specific binding's allow-list. Don't touch owners.
        const bindingId = match.bindingId;
        if (!bindingId) {
            throw new Error('Pending entry is binding-scoped but has no bindingId.');
        }
        const store = state.gateway.getBindingStore();
        const binding = store.getAll().find((b) => b.id === bindingId);
        if (!binding) {
            // Binding was unbound between reject and Allow. Drop the stale
            // entry and surface a meaningful error so the operator knows to
            // re-pair if needed.
            store; // (intentional no-op; keep store reference alive for tooling)
            state.gateway.getPendingStore().dismiss(platform, userId, {
                reason: 'not-on-binding-allowlist',
                bindingId,
            });
            throw new Error('Binding no longer exists — pending entry dismissed.');
        }
        const next = Array.from(new Set([...binding.config.allowedSenderIds, userId]));
        store.updateBindingConfig(bindingId, {
            allowedSenderIds: next,
            // Defensive: ensure the binding is in allow-list mode after
            // promotion. Otherwise a binding that was 'inherit' would still
            // ignore the new allowedSenderIds entry.
            accessMode: binding.config.accessMode === 'allow-list' ? 'allow-list' : 'allow-list',
        });
        state.gateway.getPendingStore().dismiss(platform, userId, {
            reason: 'not-on-binding-allowlist',
            bindingId,
        });
        transportOwner["emitBindingChanged"](workspaceId);
        const owners = state.configStore.get().platforms.telegram?.owners ?? [];
        return { owners, bindingId };
    }
    // reason === 'not-owner': promote to workspace owner.
    const cfg = state.configStore.get();
    const existing = cfg.platforms.telegram?.owners ?? [];
    if (existing.some((o) => o.userId === userId)) {
        state.gateway.getPendingStore().dismiss(platform, userId);
        return { owners: existing };
    }
    const nextOwners: PlatformOwner[] = [
        ...existing,
        {
            userId: match.userId,
            ...(match.displayName ? { displayName: match.displayName } : {}),
            ...(match.username ? { username: match.username } : {}),
            addedAt: Date.now(),
        },
    ];
    const tg = cfg.platforms.telegram;
    transportOwner["patchTelegramConfig"](workspaceId, {
        owners: nextOwners,
        accessMode: tg?.accessMode ?? 'owner-only',
    });
    // Dismiss every pending row for this sender — they're now an owner,
    // so any binding-allow-list rejects pending against them have been
    // superseded by the inherit path.
    state.gateway.getPendingStore().dismiss(platform, userId);
    transportOwner["emitBindingChanged"](workspaceId);
    return { owners: nextOwners };
}

export function setBindingAccess(transportOwner: MessagingGatewayRegistry, workspaceId: string, bindingId: string, access: {
    mode: BindingAccessMode;
    allowedSenderIds?: string[];
}): void {
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        throw new Error('Workspace not initialised');
    const store = state.gateway.getBindingStore();
    const next = store.updateBindingConfig(bindingId, {
        accessMode: access.mode,
        allowedSenderIds: access.mode === 'allow-list' ? [...(access.allowedSenderIds ?? [])] : [],
    });
    if (!next)
        throw new Error('Binding not found');
    transportOwner["emitBindingChanged"](workspaceId);
}
