import { BrowserWindow } from "electron";
import { mainLog } from "../logger";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserInstance } from './shared.ts';
import * as browserPaneManagerSessionRecords from './session-records.ts';

export function getInstanceByWebContentsId(transportOwner: BrowserPaneManager, webContentsId: number): BrowserInstance | undefined {
    for (const instance of transportOwner["instances"].values()) {
        if (instance.pageWebContentsId === webContentsId)
            return instance;
    }
    return undefined;
}

export function registerPopupWindow(transportOwner: BrowserPaneManager, parentInstance: BrowserInstance, popupWindow: BrowserWindow, sourceUrl?: string): void {
    const popupWcId = popupWindow.webContents.id;
    const existingParent = transportOwner["popupParentByWebContentsId"].get(popupWcId);
    if (existingParent && existingParent !== parentInstance.id) {
        browserPaneManagerSessionRecords.unregisterPopupWindow(transportOwner, popupWindow, 'reparented');
    }
    let popups = transportOwner["popupWindowsByParentInstanceId"].get(parentInstance.id);
    if (!popups) {
        popups = new Set<BrowserWindow>();
        transportOwner["popupWindowsByParentInstanceId"].set(parentInstance.id, popups);
    }
    popups.add(popupWindow);
    transportOwner["popupParentByWebContentsId"].set(popupWcId, parentInstance.id);
    transportOwner["popupWebContentsIdByWindow"].set(popupWindow, popupWcId);
    const initialUrl = sourceUrl || popupWindow.webContents.getURL?.() || 'about:blank';
    mainLog.info(`[browser-pane] popup created parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${initialUrl}`);
    popupWindow.webContents.on('did-navigate', (_event, urlFromEvent) => {
        const popupUrl = typeof popupWindow.webContents.getURL === 'function'
            ? popupWindow.webContents.getURL()
            : (urlFromEvent || initialUrl);
        mainLog.info(`[browser-pane] popup did-navigate parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${popupUrl}`);
    });
    popupWindow.webContents.on('did-redirect-navigation', (_event, popupUrl, isInPlace, isMainFrame) => {
        mainLog.info(`[browser-pane] popup redirect parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${popupUrl} inPlace=${isInPlace} mainFrame=${isMainFrame}`);
    });
    popupWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame)
            return;
        mainLog.warn(`[browser-pane] popup did-fail-load parent=${parentInstance.id} popupWebContentsId=${popupWcId} code=${errorCode} url=${validatedURL} error=${errorDescription}`);
    });
    popupWindow.on('closed', () => {
        browserPaneManagerSessionRecords.unregisterPopupWindow(transportOwner, popupWindow, 'closed');
    });
}

export function closePopupsForParent(transportOwner: BrowserPaneManager, parentId: string, reason: 'parent_destroy'): void {
    const popups = transportOwner["popupWindowsByParentInstanceId"].get(parentId);
    if (!popups || popups.size === 0)
        return;
    for (const popupWindow of Array.from(popups)) {
        const popupWcId = transportOwner["popupWebContentsIdByWindow"].get(popupWindow) ?? -1;
        browserPaneManagerSessionRecords.unregisterPopupWindow(transportOwner, popupWindow, reason);
        try {
            if (!popupWindow.isDestroyed()) {
                popupWindow.destroy();
            }
        }
        catch (error) {
            mainLog.warn(`[browser-pane] popup destroy failed parent=${parentId} popupWebContentsId=${popupWcId} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
