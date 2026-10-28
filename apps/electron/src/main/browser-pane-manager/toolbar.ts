/**
 * BrowserPaneManager
 *
 * Owns browser instances as dedicated BrowserWindow objects.
 * Each instance maps 1:1 to a full native window while preserving
 * shared session/cookie partition and CDP automation support.
 */
import { join } from "path";
import { mainLog } from "../logger";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { VITE_DEV_SERVER_URL, TOOLBAR_LOAD_MAX_RETRIES, TOOLBAR_LOAD_RETRY_DELAY_MS, BROWSER_EMPTY_STATE_PAGE } from './shared.ts';
import type { BrowserInstance } from './shared.ts';
import * as browserPaneManagerToolbarState from './toolbar-state.ts';

export async function loadEmptyStatePage(_transportOwner: BrowserPaneManager, moduleDirectory: string, instance: BrowserInstance): Promise<void> {
    if (VITE_DEV_SERVER_URL) {
        await instance.pageView.webContents.loadURL(`${VITE_DEV_SERVER_URL}/${BROWSER_EMPTY_STATE_PAGE}`);
        return;
    }
    await instance.pageView.webContents.loadFile(join(moduleDirectory, `renderer/${BROWSER_EMPTY_STATE_PAGE}`));
}

export async function loadToolbarPage(transportOwner: BrowserPaneManager, moduleDirectory: string, instance: BrowserInstance): Promise<void> {
    const query = `instanceId=${encodeURIComponent(instance.id)}`;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= TOOLBAR_LOAD_MAX_RETRIES; attempt++) {
        if (!transportOwner["isLiveToolbarInstance"](instance))
            return;
        try {
            if (VITE_DEV_SERVER_URL) {
                await instance.toolbarView.webContents.loadURL(`${VITE_DEV_SERVER_URL}/browser-toolbar.html?${query}`);
            }
            else {
                await instance.toolbarView.webContents.loadFile(join(moduleDirectory, 'renderer/browser-toolbar.html'), { query: { instanceId: instance.id } });
            }
            if (attempt > 0) {
                mainLog.info(`[browser-pane] toolbar load recovered id=${instance.id} attempt=${attempt + 1}`);
            }
            return;
        }
        catch (error) {
            if (!transportOwner["isLiveToolbarInstance"](instance))
                return;
            lastError = error;
            const retrying = attempt < TOOLBAR_LOAD_MAX_RETRIES;
            mainLog.warn(`[browser-pane] toolbar load failed id=${instance.id} attempt=${attempt + 1}/${TOOLBAR_LOAD_MAX_RETRIES + 1}: ${error instanceof Error ? error.message : String(error)}${retrying ? ' (retrying)' : ''}`);
            if (retrying) {
                await transportOwner.sleep(TOOLBAR_LOAD_RETRY_DELAY_MS);
            }
        }
    }
    if (!transportOwner["isLiveToolbarInstance"](instance))
        return;
    const errorText = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
    await browserPaneManagerToolbarState.loadToolbarFallback(transportOwner, instance, errorText);
}

export function isLiveToolbarInstance(transportOwner: BrowserPaneManager, instance: BrowserInstance): boolean {
    if (!transportOwner.isLiveInstance(instance))
        return false;
    try {
        return !instance.toolbarView.webContents.isDestroyed();
    }
    catch {
        return false;
    }
}

export function sleep(_transportOwner: BrowserPaneManager, ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function markToolbarReady(transportOwner: BrowserPaneManager, instance: BrowserInstance, reason: string): void {
    if (instance.toolbarReady || instance.window.isDestroyed())
        return;
    instance.toolbarReady = true;
    mainLog.info(`[browser-pane] toolbar ready id=${instance.id} reason=${reason}`);
    const shouldShowNow = instance.showOnCreate || instance.pendingShowOnReady;
    if (!shouldShowNow)
        return;
    const tokenAtReady = instance.pendingShowToken;
    instance.pendingShowOnReady = false;
    if (instance.window.isDestroyed())
        return;
    if (instance.pendingShowToken !== tokenAtReady)
        return;
    instance.window.show();
    instance.window.focus();
    instance.isVisible = true;
    transportOwner["emitStateChange"](instance);
}
