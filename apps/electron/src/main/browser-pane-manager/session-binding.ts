import { mainLog } from "../logger";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserPaneGetOrCreateForSessionAsyncOptionsPayload, BrowserPaneCreateForSessionOptionsPayload } from './protocol.ts';
import * as browserPaneManagerWindowState from './window-state.ts';

export function bindSession(transportOwner: BrowserPaneManager, id: string, sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): void {
    const instance = transportOwner["instances"].get(id);
    if (instance) {
        instance.boundSessionId = sessionId;
        instance.ownerType = 'session';
        instance.ownerSessionId = sessionId;
        // Adopt the new binder's workspace. Manual windows being reused for a
        // session start carrying that session's workspace so the receiving
        // workspace's UI sees them and others don't.
        if (options?.workspaceId !== undefined) {
            instance.workspaceId = options.workspaceId;
        }
        transportOwner["emitStateChange"](instance);
    }
}

export function unbindSession(transportOwner: BrowserPaneManager, id: string): void {
    const instance = transportOwner["instances"].get(id);
    if (instance) {
        instance.boundSessionId = null;
        instance.ownerType = 'manual';
        // Preserve ownerSessionId as last-known owner for lifecycle targeting.
        transportOwner["emitStateChange"](instance);
    }
}

/** Unbind all instances bound to the given session (non-destructive — window stays alive and reusable). */
export function unbindAllForSession(transportOwner: BrowserPaneManager, sessionId: string): void {
    for (const instance of transportOwner["instances"].values()) {
        if (instance.boundSessionId === sessionId) {
            instance.boundSessionId = null;
            instance.ownerType = 'manual';
            // Keep ownerSessionId for post-turn lifecycle commands like `close` and `hide`.
            instance.ownerSessionId = instance.ownerSessionId ?? sessionId;
            transportOwner["emitStateChange"](instance);
            mainLog.info(`[browser-pane] Unbound instance ${instance.id} from session ${sessionId} (owner retained: ${instance.ownerSessionId ?? 'none'})`);
        }
    }
}

export function getBoundForSession(transportOwner: BrowserPaneManager, sessionId: string): string | null {
    for (const instance of transportOwner["instances"].values()) {
        if (instance.ownerType === 'session' && instance.ownerSessionId === sessionId) {
            if (instance.window.isDestroyed()) {
                transportOwner["cleanupDestroyedInstance"](instance, `getBoundForSession(${sessionId})`);
                continue;
            }
            return instance.id;
        }
    }
    return null;
}

export function createForSession(transportOwner: BrowserPaneManager, sessionId: string, options?: BrowserPaneCreateForSessionOptionsPayload): string {
    const workspaceId = options?.workspaceId ?? null;
    const existing = transportOwner["getBoundForSession"](sessionId);
    if (existing) {
        // Already bound — adopt the workspace if the caller provided one and the
        // existing instance was bound before we knew about its workspace.
        if (options?.workspaceId !== undefined) {
            const instance = transportOwner["instances"].get(existing);
            if (instance)
                instance.workspaceId = options.workspaceId;
        }
        if (options?.show) {
            transportOwner["focus"](existing);
        }
        return existing;
    }
    // Reuse an unbound/manual window before creating a new one — local
    // sessions only. Remote agents must always get a fresh window so they
    // can never hijack a window the user opened manually.
    const allowReuseManual = options?.allowReuseManual ?? true;
    if (allowReuseManual) {
        const reusable = browserPaneManagerWindowState.findReusableUnboundInstance(transportOwner, workspaceId);
        if (reusable) {
            transportOwner["bindSession"](reusable.id, sessionId, { workspaceId });
            if (options?.show) {
                transportOwner["focus"](reusable.id);
            }
            mainLog.info(`[browser-pane] Reused unbound instance ${reusable.id} for session ${sessionId} (workspace=${workspaceId ?? 'none'})`);
            return reusable.id;
        }
    }
    return transportOwner["createInstance"](undefined, {
        show: options?.show ?? false,
        ownerType: 'session',
        ownerSessionId: sessionId,
        workspaceId,
    });
}

export function focusBoundForSession(transportOwner: BrowserPaneManager, sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): string {
    const id = transportOwner["createForSession"](sessionId, { show: true, workspaceId: options?.workspaceId });
    transportOwner["focus"](id);
    return id;
}

export function getOrCreateForSession(transportOwner: BrowserPaneManager, sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): string {
    return transportOwner["createForSession"](sessionId, { show: false, workspaceId: options?.workspaceId });
}

export function getBoundInstanceId(transportOwner: BrowserPaneManager, sessionId: string): string | null {
    for (const [id, instance] of transportOwner["instances"]) {
        if (instance.boundSessionId === sessionId) {
            if (instance.window.isDestroyed()) {
                transportOwner["cleanupDestroyedInstance"](instance, `getBoundInstanceId(${sessionId})`);
                continue;
            }
            return id;
        }
    }
    return null;
}

export function destroyForSession(transportOwner: BrowserPaneManager, sessionId: string): void {
    for (const [id, instance] of transportOwner["instances"]) {
        if (instance.boundSessionId === sessionId) {
            transportOwner["destroyInstance"](id);
        }
    }
}

export async function clearVisualsForSession(transportOwner: BrowserPaneManager, sessionId: string): Promise<void> {
    for (const instance of transportOwner["instances"].values()) {
        if (instance.boundSessionId === sessionId) {
            instance.agentControl = null;
            transportOwner["applyAgentControlLock"](instance, false);
            transportOwner["updateNativeOverlayState"](instance);
            transportOwner["emitStateChange"](instance);
        }
    }
}
