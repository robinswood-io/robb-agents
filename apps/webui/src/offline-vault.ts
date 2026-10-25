import type { SessionDraft } from "@craft-agent/shared/config";
import { emptyState, cloneState } from './offline-vault/shared.ts';
import type { OfflineVaultScope, OfflineVaultScopeToken, OfflineSessionAnchor, OfflineSessionSnapshot, OfflineOutboxStatus, OfflineOutboxItem, OfflinePin, OfflineVaultState } from './offline-vault/shared.ts';
import { IndexedDbOfflineVaultPersistence } from './offline-vault/persistence.ts';
import type { OfflineVaultKey, OfflineVaultPersistence } from './offline-vault/persistence.ts';
import * as offlineVaultLoading from './offline-vault/loading.ts';
import * as offlineVaultScope from './offline-vault/scope.ts';
import * as offlineVaultMutation from './offline-vault/mutation.ts';
import * as offlineVaultConsent from './offline-vault/consent.ts';
import * as offlineVaultSnapshots from './offline-vault/snapshots.ts';
import * as offlineVaultDrafts from './offline-vault/drafts.ts';
import * as offlineVaultOutbox from './offline-vault/outbox.ts';
export type { OfflineMessageRole, OfflineVaultScope, OfflineVaultScopeToken, OfflineMessage, OfflineSessionAnchor, OfflineSessionSnapshot, OfflineDraft, OfflineOutboxStatus, OfflineOutboxItem, OfflinePin, OfflineVaultState } from './offline-vault/shared.ts';
export { OFFLINE_VAULT_RETENTION_MS, OFFLINE_VAULT_MAX_SESSIONS, OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION, OFFLINE_VAULT_MAX_MESSAGE_CHARS, OFFLINE_VAULT_MAX_DRAFT_CHARS, OFFLINE_VAULT_MAX_DRAFTS, OFFLINE_VAULT_MAX_OUTBOX_ITEMS, OFFLINE_VAULT_MAX_PINS, OfflineVaultUnavailableError, OfflineVaultCapacityError, OfflineVaultConflictError, sanitizeSessionSnapshot, selectRecentSessions, searchOfflineSessions, anchorsMatch, isScopeExpired, nextOfflineRetentionDeadline, isOfflineVaultEnabled } from './offline-vault/shared.ts';
export type { OfflineVaultKey, OfflineVaultPersistence } from './offline-vault/persistence.ts';
export { IndexedDbOfflineVaultPersistence } from './offline-vault/persistence.ts';

export class OfflineVault {
    private state = emptyState();
    private key: OfflineVaultKey | null = null;
    private loaded = false;
    private conflicted = false;
    private generation = 0;
    private recordRevision: string | null = null;
    private queue: Promise<void> = Promise.resolve();
    private listeners = new Set<(state: OfflineVaultState) => void>();
    constructor(private readonly persistence: OfflineVaultPersistence = new IndexedDbOfflineVaultPersistence()) { }
    subscribe(listener: (state: OfflineVaultState) => void): () => void {
        this.listeners.add(listener);
        listener(cloneState(this.state));
        return () => this.listeners.delete(listener);
    }
    private emit(): void {
        const snapshot = cloneState(this.state);
        for (const listener of this.listeners)
            listener(snapshot);
    }
    private async ensureKey(): Promise<OfflineVaultKey> {
        return offlineVaultLoading.ensureKey(this);
    }
    private async loadNow(): Promise<OfflineVaultState> {
        return offlineVaultLoading.loadNow(this);
    }
    load(): Promise<OfflineVaultState> {
        return offlineVaultLoading.load(this);
    }
    getSnapshot(): OfflineVaultState {
        return cloneState(this.state);
    }
    getScopeToken(): OfflineVaultScopeToken | null {
        return offlineVaultScope.getScopeToken(this);
    }
    private scopeTokenMatches(state: OfflineVaultState, token: OfflineVaultScopeToken | undefined): boolean {
        return offlineVaultScope.scopeTokenMatches(this, state, token);
    }
    private async persistState(state: OfflineVaultState): Promise<void> {
        return offlineVaultMutation.persistState(this, state);
    }
    private invalidateAfterConflict(): void {
        return offlineVaultMutation.invalidateAfterConflict(this);
    }
    private mutate(update: (state: OfflineVaultState, now: number) => void, expectedScope?: OfflineVaultScopeToken): Promise<boolean> {
        return offlineVaultMutation.mutate(this, update, expectedScope);
    }
    private assertUserMutationCommitted(committed: boolean): void {
        return offlineVaultMutation.assertUserMutationCommitted(this, committed);
    }
    enable(scope: OfflineVaultScope): Promise<void> {
        return offlineVaultConsent.enable(this, scope);
    }
    configureScope(scope: OfflineVaultScope): Promise<void> {
        return offlineVaultScope.configureScope(this, scope);
    }
    private async purgeNow(): Promise<void> {
        return offlineVaultConsent.purgeNow(this);
    }
    purge(): Promise<void> {
        return offlineVaultConsent.purge(this);
    }
    async replaceSnapshots(snapshots: readonly OfflineSessionSnapshot[], expectedScope?: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultSnapshots.replaceSnapshots(this, snapshots, expectedScope);
    }
    async upsertSnapshot(snapshot: OfflineSessionSnapshot, expectedScope?: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultSnapshots.upsertSnapshot(this, snapshot, expectedScope);
    }
    async storeDraft(sessionId: string, draft: SessionDraft | string, dirty: boolean, expectedScope: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultDrafts.storeDraft(this, sessionId, draft, dirty, expectedScope);
    }
    async deleteDraft(sessionId: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultDrafts.deleteDraft(this, sessionId, expectedScope);
    }
    async mergeRemoteDrafts(drafts: Record<string, SessionDraft>, expectedScope?: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultDrafts.mergeRemoteDrafts(this, drafts, expectedScope);
    }
    async enqueueMessage(input: {
        sessionId: string;
        sessionName: string;
        text: string;
        anchor: OfflineSessionAnchor;
    }, expectedScope: OfflineVaultScopeToken): Promise<OfflineOutboxItem> {
        return offlineVaultOutbox.enqueueMessage(this, input, expectedScope);
    }
    async beginOutboxSend(id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultOutbox.beginOutboxSend(this, id, expectedScope);
    }
    async restoreOutboxAfterContextRejection(id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultOutbox.restoreOutboxAfterContextRejection(this, id, expectedScope);
    }
    async markOutboxFailure(id: string, failureKind: OfflineOutboxItem['failureKind'], expectedScope: OfflineVaultScopeToken, status: OfflineOutboxStatus = 'pending'): Promise<void> {
        return offlineVaultOutbox.markOutboxFailure(this, id, failureKind, expectedScope, status);
    }
    async removeOutbox(id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultOutbox.removeOutbox(this, id, expectedScope);
    }
    async togglePin(input: Omit<OfflinePin, 'id' | 'createdAt'>, expectedScope: OfflineVaultScopeToken): Promise<void> {
        return offlineVaultSnapshots.togglePin(this, input, expectedScope);
    }
    async pruneExpired(): Promise<void> {
        return offlineVaultSnapshots.pruneExpired(this);
    }
    estimatePlaintextBytes(): number {
        return offlineVaultSnapshots.estimatePlaintextBytes(this);
    }
}
let singleton: OfflineVault | null = null;

export function getOfflineVault(): OfflineVault {
    singleton ??= new OfflineVault();
    return singleton;
}
