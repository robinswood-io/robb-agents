import { type AppEvent } from "../types.ts";
import type { SessionMetadataSnapshot } from "../types.ts";
import type { AutomationSystem } from '../automation-system.ts';
import { log } from './shared.ts';

export async function updateSessionMetadata(transportOwner: AutomationSystem, sessionId: string, next: SessionMetadataSnapshot): Promise<AppEvent[]> {
    if (transportOwner["disposed"])
        return [];
    const sessionToken = transportOwner.getOrCreateSessionMetadataToken(sessionId);
    const lifecycleToken = transportOwner.metadataLifecycleToken;
    const previous = transportOwner.sessionMetadataUpdateTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => (transportOwner.updateSessionMetadataNow(sessionId, next, sessionToken, lifecycleToken)));
    const tail = operation.then(() => undefined, () => undefined);
    transportOwner.sessionMetadataUpdateTails.set(sessionId, tail);
    try {
        return await operation;
    }
    finally {
        if (transportOwner.sessionMetadataUpdateTails.get(sessionId) === tail) {
            transportOwner.sessionMetadataUpdateTails.delete(sessionId);
        }
    }
}

export async function updateSessionMetadataNow(transportOwner: AutomationSystem, sessionId: string, next: SessionMetadataSnapshot, sessionToken: object, lifecycleToken: object): Promise<AppEvent[]> {
    const isCurrent = (): boolean => (!transportOwner["disposed"]
        && transportOwner.metadataLifecycleToken === lifecycleToken
        && transportOwner.sessionMetadataTokens.get(sessionId) === sessionToken);
    if (!isCurrent())
        return [];
    const prev = transportOwner["lastKnownMetadata"].get(sessionId) ?? {};
    const emittedEvents: AppEvent[] = [];
    const timestamp = Date.now();
    // Common fields for all events
    const sessionName = next.sessionName;
    const labels = next.labels ?? [];
    // Permission mode change
    if (prev.permissionMode !== next.permissionMode) {
        if (!isCurrent())
            return emittedEvents;
        await transportOwner["eventBus"].emit('PermissionModeChange', {
            sessionId,
            ...(sessionName !== undefined ? { sessionName } : {}),
            workspaceId: transportOwner["options"].workspaceId,
            timestamp,
            labels,
            oldMode: prev.permissionMode ?? '',
            newMode: next.permissionMode ?? '',
        });
        emittedEvents.push('PermissionModeChange');
        if (!isCurrent())
            return emittedEvents;
    }
    // Labels (array diff)
    const prevLabels = new Set(prev.labels ?? []);
    const nextLabels = new Set(next.labels ?? []);
    for (const label of nextLabels) {
        if (!prevLabels.has(label)) {
            if (!isCurrent())
                return emittedEvents;
            await transportOwner["eventBus"].emit('LabelAdd', {
                sessionId,
                ...(sessionName !== undefined ? { sessionName } : {}),
                workspaceId: transportOwner["options"].workspaceId,
                timestamp,
                labels: [...nextLabels],
                label,
            });
            emittedEvents.push('LabelAdd');
            if (!isCurrent())
                return emittedEvents;
        }
    }
    for (const label of prevLabels) {
        if (!nextLabels.has(label)) {
            if (!isCurrent())
                return emittedEvents;
            await transportOwner["eventBus"].emit('LabelRemove', {
                sessionId,
                ...(sessionName !== undefined ? { sessionName } : {}),
                workspaceId: transportOwner["options"].workspaceId,
                timestamp,
                labels: [...nextLabels],
                label,
            });
            emittedEvents.push('LabelRemove');
            if (!isCurrent())
                return emittedEvents;
        }
    }
    // Flag change
    const wasFlagged = prev.isFlagged ?? false;
    const isFlagged = next.isFlagged ?? false;
    if (wasFlagged !== isFlagged) {
        if (!isCurrent())
            return emittedEvents;
        await transportOwner["eventBus"].emit('FlagChange', {
            sessionId,
            ...(sessionName !== undefined ? { sessionName } : {}),
            workspaceId: transportOwner["options"].workspaceId,
            timestamp,
            labels,
            isFlagged,
        });
        emittedEvents.push('FlagChange');
        if (!isCurrent())
            return emittedEvents;
    }
    // Session status change
    if (prev.sessionStatus !== next.sessionStatus) {
        if (!isCurrent())
            return emittedEvents;
        await transportOwner["eventBus"].emit('SessionStatusChange', {
            sessionId,
            ...(sessionName !== undefined ? { sessionName } : {}),
            workspaceId: transportOwner["options"].workspaceId,
            timestamp,
            labels,
            oldState: prev.sessionStatus ?? '',
            newState: next.sessionStatus ?? '',
        });
        emittedEvents.push('SessionStatusChange');
        if (!isCurrent())
            return emittedEvents;
    }
    // Update stored metadata
    if (!isCurrent())
        return emittedEvents;
    transportOwner["lastKnownMetadata"].set(sessionId, { ...next });
    if (emittedEvents.length > 0) {
        log.debug(`[AutomationSystem] Emitted ${emittedEvents.length} events for session ${sessionId}: ${emittedEvents.join(', ')}`);
    }
    return emittedEvents;
}

export function removeSessionMetadata(transportOwner: AutomationSystem, sessionId: string): void {
    // Deleting the opaque token invalidates all older work without retaining a
    // tombstone for every session ever removed.
    transportOwner.sessionMetadataTokens.delete(sessionId);
    transportOwner["lastKnownMetadata"].delete(sessionId);
    log.debug(`[AutomationSystem] Removed metadata for session ${sessionId}`);
}

export function setInitialSessionMetadata(transportOwner: AutomationSystem, sessionId: string, metadata: SessionMetadataSnapshot): void {
    if (transportOwner["disposed"])
        return;
    transportOwner.sessionMetadataTokens.set(sessionId, {});
    transportOwner["lastKnownMetadata"].set(sessionId, { ...metadata });
}

export function getOrCreateSessionMetadataToken(transportOwner: AutomationSystem, sessionId: string): object {
    const current = transportOwner.sessionMetadataTokens.get(sessionId);
    if (current)
        return current;
    const token = {};
    transportOwner.sessionMetadataTokens.set(sessionId, token);
    return token;
}

export async function emitLabelConfigChange(transportOwner: AutomationSystem): Promise<void> {
    await transportOwner["eventBus"].emit('LabelConfigChange', {
        workspaceId: transportOwner["options"].workspaceId,
        timestamp: Date.now(),
    });
}
