import type { SessionDraft } from "@craft-agent/shared/config";
import type { OfflineVault } from '../offline-vault.ts';
import { OFFLINE_VAULT_MAX_DRAFT_CHARS, OFFLINE_VAULT_MAX_DRAFTS, OfflineVaultCapacityError, userText } from './shared.ts';
import type { OfflineVaultScopeToken } from './shared.ts';

export async function storeDraft(transportOwner: OfflineVault, sessionId: string, draft: SessionDraft | string, dirty: boolean, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const text = userText(typeof draft === 'string' ? draft : draft.text, OFFLINE_VAULT_MAX_DRAFT_CHARS, 'Draft');
    const committed = await transportOwner["mutate"]((state, now) => {
        if (!text)
            delete state.drafts[sessionId];
        else {
            const existing = state.drafts[sessionId];
            if (!existing && Object.keys(state.drafts).length >= OFFLINE_VAULT_MAX_DRAFTS) {
                const oldestCached = Object.values(state.drafts)
                    .filter((entry) => !entry.dirty)
                    .sort((left, right) => left.updatedAt - right.updatedAt)[0];
                if (!oldestCached) {
                    throw new OfflineVaultCapacityError(`Only ${OFFLINE_VAULT_MAX_DRAFTS} offline drafts can be kept`);
                }
                delete state.drafts[oldestCached.sessionId];
            }
            state.drafts[sessionId] = { sessionId, text, updatedAt: now, dirty };
        }
    }, expectedScope);
    transportOwner["assertUserMutationCommitted"](committed);
}

export async function deleteDraft(transportOwner: OfflineVault, sessionId: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await transportOwner["mutate"]((state) => { delete state.drafts[sessionId]; }, expectedScope);
    transportOwner["assertUserMutationCommitted"](committed);
}

export async function mergeRemoteDrafts(transportOwner: OfflineVault, drafts: Record<string, SessionDraft>, expectedScope?: OfflineVaultScopeToken): Promise<void> {
    await transportOwner["mutate"]((state, now) => {
        const allowedSessionIds = new Set(state.sessions.map((snapshot) => snapshot.id));
        const dirtyEntries = Object.values(state.drafts)
            // Never discard local edits just because their snapshot aged out or
            // was not among the ten most recent sessions.
            .filter((draft) => draft.dirty)
            .sort((left, right) => right.updatedAt - left.updatedAt);
        const nextDrafts = Object.fromEntries(dirtyEntries.map((draft) => [draft.sessionId, draft]));
        let remaining = OFFLINE_VAULT_MAX_DRAFTS - dirtyEntries.length;
        for (const [sessionId, draft] of Object.entries(drafts)) {
            if (remaining <= 0 || nextDrafts[sessionId] || !allowedSessionIds.has(sessionId))
                continue;
            if (typeof draft.text !== 'string' || draft.text.length === 0 || draft.text.length > OFFLINE_VAULT_MAX_DRAFT_CHARS)
                continue;
            nextDrafts[sessionId] = { sessionId, text: draft.text, updatedAt: now, dirty: false };
            remaining -= 1;
        }
        state.drafts = nextDrafts;
        state.lastSyncAt = now;
    }, expectedScope);
}
