import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { OfflineVault } from '../offline-vault.ts';
import { OFFLINE_VAULT_MAX_DRAFT_CHARS, OFFLINE_VAULT_MAX_OUTBOX_ITEMS, OfflineVaultCapacityError, boundedText, userText } from './shared.ts';
import type { OfflineVaultScopeToken, OfflineSessionAnchor, OfflineOutboxStatus, OfflineOutboxItem } from './shared.ts';

export async function enqueueMessage(transportOwner: OfflineVault, input: {
    sessionId: string;
    sessionName: string;
    text: string;
    anchor: OfflineSessionAnchor;
}, expectedScope: OfflineVaultScopeToken): Promise<OfflineOutboxItem> {
    const item: OfflineOutboxItem = {
        id: crypto.randomUUID(),
        sessionId: input.sessionId,
        sessionName: boundedText(input.sessionName, 240),
        text: userText(input.text, OFFLINE_VAULT_MAX_DRAFT_CHARS, 'Outbox message'),
        createdAt: Date.now(),
        anchor: input.anchor,
        status: 'pending',
    };
    if (!item.text.trim())
        throw new Error('Cannot queue an empty message');
    const committed = await transportOwner.mutate((state) => {
        if (state.outbox.length >= OFFLINE_VAULT_MAX_OUTBOX_ITEMS) {
            throw new OfflineVaultCapacityError(`The offline outbox is full (${OFFLINE_VAULT_MAX_OUTBOX_ITEMS} items)`);
        }
        state.outbox = [...state.outbox, item];
        delete state.drafts[item.sessionId];
    }, expectedScope);
    transportOwner.assertUserMutationCommitted(committed);
    return item;
}

export async function beginOutboxSend(transportOwner: OfflineVault, id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await transportOwner.mutate((state) => {
        const index = state.outbox.findIndex((item) => item.id === id);
        const item = state.outbox[index];
        if (!item || item.status !== 'pending') {
            throw new Error('Outbox item is no longer eligible for sending');
        }
        state.outbox[index] = {
            ...item,
            status: 'uncertain',
            failureKind: 'unknown',
        };
    }, expectedScope);
    transportOwner.assertUserMutationCommitted(committed);
}

export async function restoreOutboxAfterContextRejection(transportOwner: OfflineVault, id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await transportOwner.mutate((state) => {
        const index = state.outbox.findIndex((item) => item.id === id);
        if (index < 0)
            return;
        const item = state.outbox[index];
        if (!item || item.status !== 'uncertain' || item.failureKind !== 'unknown')
            return;
        state.outbox[index] = {
            ...item,
            status: 'pending',
            failureKind: 'context-changed',
        };
    }, expectedScope);
    transportOwner.assertUserMutationCommitted(committed);
}

export async function markOutboxFailure(transportOwner: OfflineVault, id: string, failureKind: OfflineOutboxItem['failureKind'], expectedScope: OfflineVaultScopeToken, status: OfflineOutboxStatus): Promise<void> {
    const committed = await transportOwner.mutate((state) => {
        state.outbox = state.outbox.map((item) => item.id === id
            // Once a network send may have reached the host, no concurrent review
            // or stale failure callback may make the item retryable again.
            ? item.status === 'uncertain'
                ? item
                : omitUndefined<OfflineOutboxItem>({ ...item, status, failureKind })
            : item);
    }, expectedScope);
    transportOwner.assertUserMutationCommitted(committed);
}

export async function removeOutbox(transportOwner: OfflineVault, id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await transportOwner.mutate((state) => {
        state.outbox = state.outbox.filter((item) => item.id !== id);
    }, expectedScope);
    transportOwner.assertUserMutationCommitted(committed);
}
