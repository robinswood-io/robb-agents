import { ipcMain } from "electron";
import { mainLog } from "../logger";
import type { BrowserCapabilityRequest } from "@craft-agent/server-core/transport";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { TOOLBAR_CHANNELS } from './shared.ts';
import type { BrowserInstance } from './shared.ts';

/** Register IPC handlers for toolbar actions. Call once at app startup. */
export function registerToolbarIpc(transportOwner: BrowserPaneManager): void {
    const findInstance = (instanceId: string): BrowserInstance | undefined => {
        return transportOwner["instances"].get(instanceId);
    };
    ipcMain.handle(TOOLBAR_CHANNELS.NAVIGATE, async (_event, instanceId: string, url: string) => {
        const inst = findInstance(instanceId);
        if (inst)
            await transportOwner["navigate"](inst.id, url);
    });
    ipcMain.handle(TOOLBAR_CHANNELS.GO_BACK, async (_event, instanceId: string) => {
        const inst = findInstance(instanceId);
        if (inst)
            await transportOwner["goBack"](inst.id);
    });
    ipcMain.handle(TOOLBAR_CHANNELS.GO_FORWARD, async (_event, instanceId: string) => {
        const inst = findInstance(instanceId);
        if (inst)
            await transportOwner["goForward"](inst.id);
    });
    ipcMain.handle(TOOLBAR_CHANNELS.RELOAD, async (_event, instanceId: string) => {
        const inst = findInstance(instanceId);
        if (inst)
            transportOwner["reload"](inst.id);
    });
    ipcMain.handle(TOOLBAR_CHANNELS.STOP, async (_event, instanceId: string) => {
        const inst = findInstance(instanceId);
        if (inst)
            transportOwner["stop"](inst.id);
    });
    ipcMain.handle(TOOLBAR_CHANNELS.MENU_GEOMETRY, async (_event, instanceId: string, open: boolean, height?: number) => {
        const inst = findInstance(instanceId);
        if (!inst)
            return;
        const normalizedOpen = !!open;
        const normalizedHeight = Math.max(0, Math.ceil(Number(height ?? 0)));
        if (!normalizedOpen) {
            transportOwner["forceCloseToolbarMenu"](inst, 'renderer-close');
            return;
        }
        const changed = !inst.toolbarMenuOpen
            || inst.toolbarMenuHeight !== normalizedHeight
            || !inst.toolbarMenuOverlayActive;
        if (!changed)
            return;
        inst.toolbarMenuOpen = true;
        inst.toolbarMenuHeight = normalizedHeight;
        inst.toolbarMenuOverlayActive = true;
        transportOwner["layoutAllViews"](inst);
    });
    ipcMain.handle(TOOLBAR_CHANNELS.HIDE, async (_event, instanceId: string) => {
        const inst = findInstance(instanceId);
        mainLog.info(`[browser-pane] toolbar ipc hide requested instanceId=${instanceId} resolved=${inst?.id ?? 'none'}`);
        if (inst)
            transportOwner["hide"](inst.id);
    });
    ipcMain.handle(TOOLBAR_CHANNELS.DESTROY, async (_event, instanceId: string) => {
        const inst = findInstance(instanceId);
        mainLog.info(`[browser-pane] toolbar ipc destroy requested instanceId=${instanceId} resolved=${inst?.id ?? 'none'}`);
        if (inst)
            transportOwner["destroyInstance"](inst.id);
    });
    mainLog.info('[browser-pane] Toolbar IPC handlers registered');
}

// ---------------------------------------------------------------------------
  // Capability IPC — dispatcher for the `client:browser:invoke` WS capability.
  //
  // Sits between the preload bridge (which receives the WS request from the
  // remote server) and the real BrowserPaneManager. It rewrites session IDs to
  // an owner-key namespace, refuses any instance ID not owned by the calling
  // (workspaceId, sessionId), and blocks unsafe methods like `uploadFile` or
  // (optionally) `evaluate`.
  // ---------------------------------------------------------------------------

  /** Register the `__browser:invoke` IPC handler. Call once at app startup. */
export function registerCapabilityIpc(transportOwner: BrowserPaneManager): void {
    ipcMain.handle('__browser:invoke', async (_event, req: BrowserCapabilityRequest) => {
        return await transportOwner["dispatchCapability"](req);
    });
    mainLog.info('[browser-pane] Capability IPC handler registered');
}
