import type { OfflineVault } from '../offline-vault.ts';
import { OFFLINE_VAULT_MAX_MESSAGE_CHARS, OFFLINE_VAULT_MAX_PINS, OfflineVaultCapacityError, finiteTimestamp, userText, boundedSnapshots } from './shared.ts';
import type { OfflineVaultScopeToken, OfflineSessionSnapshot, OfflinePin } from './shared.ts';

export async function replaceSnapshots(transportOwner: OfflineVault, snapshots: readonly OfflineSessionSnapshot[], expectedScope?: OfflineVaultScopeToken): Promise<void> {
    await transportOwner.mutate((state, now) => {
        const scoped = snapshots
            .filter((snapshot) => snapshot.workspaceId === state.scope?.workspaceId)
            .map((snapshot) => ({ ...snapshot, capturedAt: finiteTimestamp(snapshot.capturedAt, now) }));
        state.sessions = boundedSnapshots(state, scoped);
        state.lastSyncAt = now;
    }, expectedScope);
}

export async function upsertSnapshot(transportOwner: OfflineVault, snapshot: OfflineSessionSnapshot, expectedScope?: OfflineVaultScopeToken): Promise<void> {
    await transportOwner.mutate((state, now) => {
        if (snapshot.workspaceId !== state.scope?.workspaceId)
            return;
        const next = { ...snapshot, capturedAt: now };
        state.sessions = boundedSnapshots(state, [next, ...state.sessions.filter((entry) => entry.id !== next.id)]);
        state.lastSyncAt = now;
    }, expectedScope);
}

export async function pruneExpired(transportOwner: OfflineVault): Promise<void> {
    // mutate() normalizes against the current clock before persisting.
    await transportOwner.mutate(() => { });
}

export function estimatePlaintextBytes(transportOwner: OfflineVault): number {
    return new TextEncoder().encode(JSON.stringify(transportOwner["state"])).byteLength;
}

export async function togglePin(transportOwner: OfflineVault, input: Omit<OfflinePin, 'id' | 'createdAt'>, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await transportOwner.mutate((state, now) => {
        const existing = state.pins.find((pin) => pin.sessionId === input.sessionId && pin.messageId === input.messageId);
        if (existing) {
            state.pins = state.pins.filter((pin) => pin.id !== existing.id);
        }
        else {
            if (state.pins.length >= OFFLINE_VAULT_MAX_PINS) {
                throw new OfflineVaultCapacityError(`Only ${OFFLINE_VAULT_MAX_PINS} offline pins can be kept`);
            }
            state.pins = [...state.pins, {
                    ...input,
                    id: crypto.randomUUID(),
                    text: userText(input.text, OFFLINE_VAULT_MAX_MESSAGE_CHARS, 'Pinned text'),
                    createdAt: now,
                }];
        }
    }, expectedScope);
    transportOwner.assertUserMutationCommitted(committed);
}
