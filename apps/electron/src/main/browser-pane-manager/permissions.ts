import { omitUndefined } from '@craft-agent/shared/utils/json';
import { type Session as ElectronSession } from "electron";
import { isBrowserPanePermissionAllowed, type BrowserPanePermissionContext } from "../browser-pane-permissions";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserInstance } from './shared.ts';
import type { BrowserPaneGetPermissionInstanceWebContentsPayload } from './protocol.ts';
import * as browserPaneManagerSessionRecords from './session-records.ts';

export function getPermissionInstance(transportOwner: BrowserPaneManager, webContents: BrowserPaneGetPermissionInstanceWebContentsPayload | null): BrowserInstance | undefined {
    if (!webContents)
        return undefined;
    const directInstance = transportOwner["getInstanceByWebContentsId"](webContents.id);
    if (directInstance)
        return directInstance;
    const parentInstanceId = transportOwner.popupParentByWebContentsId.get(webContents.id);
    return parentInstanceId ? transportOwner["instances"].get(parentInstanceId) : undefined;
}

export function getPermissionContext(transportOwner: BrowserPaneManager, webContents: BrowserPaneGetPermissionInstanceWebContentsPayload | null, requestingOrigin: string): BrowserPanePermissionContext | undefined {
    const instance = transportOwner.getPermissionInstance(webContents);
    const agentControl = instance?.agentControl;
    const workspaceId = instance?.workspaceId;
    if (!instance
        || !agentControl?.active
        || instance.boundSessionId !== agentControl.sessionId
        || !workspaceId
        || !transportOwner.permissionAutonomyResolver) {
        return undefined;
    }
    const autonomy = transportOwner.permissionAutonomyResolver({
        sessionId: agentControl.sessionId,
        workspaceId,
    });
    if (!autonomy)
        return undefined;
    return omitUndefined<BrowserPanePermissionContext>({
        agentControlled: true,
        permissionMode: autonomy.permissionMode,
        externalActionPolicy: autonomy.externalActionPolicy,
        requestingOrigin,
        topLevelUrl: instance.currentUrl,
    });
}

export function isPermissionAllowed(transportOwner: BrowserPaneManager, webContents: BrowserPaneGetPermissionInstanceWebContentsPayload | null, permission: string, requestingOrigin: string): boolean {
    return isBrowserPanePermissionAllowed(permission, transportOwner.getPermissionContext(webContents, requestingOrigin));
}

export function setupSessionPermissions(transportOwner: BrowserPaneManager, ses: ElectronSession): void {
    if (transportOwner.partitionPermissionsInitialized)
        return;
    transportOwner.partitionPermissionsInitialized = true;
    if (typeof ses.setPermissionCheckHandler === 'function') {
        ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
            const allowed = transportOwner.isPermissionAllowed(webContents, permission, requestingOrigin);
            if (!allowed) {
                browserPaneManagerSessionRecords.logPermissionDecision(transportOwner, 'check', permission, requestingOrigin);
            }
            return allowed;
        });
    }
    if (typeof ses.setPermissionRequestHandler === 'function') {
        ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
            const requestingOrigin = details.requestingUrl || 'unknown';
            const allowed = transportOwner.isPermissionAllowed(webContents, permission, requestingOrigin);
            if (!allowed) {
                browserPaneManagerSessionRecords.logPermissionDecision(transportOwner, 'request', permission, requestingOrigin);
            }
            callback(allowed);
        });
    }
}
