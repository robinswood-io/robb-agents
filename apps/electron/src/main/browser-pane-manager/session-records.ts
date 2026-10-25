/**
 * BrowserPaneManager
 *
 * Owns browser instances as dedicated BrowserWindow objects.
 * Each instance maps 1:1 to a full native window while preserving
 * shared session/cookie partition and CDP automation support.
 */
import { basename, join, parse as parsePath } from "path";
import { existsSync, mkdirSync } from "fs";
import { BrowserWindow, app, dialog } from "electron";
import { mainLog } from "../logger";
import { i18n } from "@craft-agent/shared/i18n";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { MAX_NETWORK_LOG_ENTRIES, MAX_DOWNLOAD_LOG_ENTRIES } from './shared.ts';
import type { BrowserInstance, BrowserNetworkEntry, BrowserDownloadEntry } from './shared.ts';
import type { BrowserPaneSelectWebAuthnAccountDetailsPayload } from './protocol.ts';

export function unregisterPopupWindow(transportOwner: BrowserPaneManager, popupWindow: BrowserWindow, reason: 'closed' | 'parent_destroy' | 'reparented'): void {
    const popupWcId = transportOwner["popupWebContentsIdByWindow"].get(popupWindow);
    if (popupWcId === undefined)
        return;
    transportOwner["popupWebContentsIdByWindow"].delete(popupWindow);
    const parentId = transportOwner["popupParentByWebContentsId"].get(popupWcId);
    if (!parentId)
        return;
    transportOwner["popupParentByWebContentsId"].delete(popupWcId);
    const popups = transportOwner["popupWindowsByParentInstanceId"].get(parentId);
    if (popups) {
        popups.delete(popupWindow);
        if (popups.size === 0) {
            transportOwner["popupWindowsByParentInstanceId"].delete(parentId);
        }
    }
    mainLog.info(`[browser-pane] popup closed parent=${parentId} popupWebContentsId=${popupWcId} reason=${reason}`);
}

export function pushNetworkLog(transportOwner: BrowserPaneManager, instance: BrowserInstance, entry: BrowserNetworkEntry): void {
    instance.networkLogs.push(entry);
    if (instance.networkLogs.length > MAX_NETWORK_LOG_ENTRIES) {
        instance.networkLogs.splice(0, instance.networkLogs.length - MAX_NETWORK_LOG_ENTRIES);
    }
}

export function pushDownloadLog(transportOwner: BrowserPaneManager, instance: BrowserInstance, entry: BrowserDownloadEntry): void {
    instance.downloads.push(entry);
    if (instance.downloads.length > MAX_DOWNLOAD_LOG_ENTRIES) {
        instance.downloads.splice(0, instance.downloads.length - MAX_DOWNLOAD_LOG_ENTRIES);
    }
}

export function resolveDownloadsDir(transportOwner: BrowserPaneManager, instance: BrowserInstance): string {
    const sessionId = instance.boundSessionId ?? instance.ownerSessionId;
    if (sessionId && transportOwner["sessionPathResolver"]) {
        const sessionPath = transportOwner["sessionPathResolver"](sessionId);
        if (sessionPath) {
            const dir = join(sessionPath, 'downloads');
            mkdirSync(dir, { recursive: true });
            return dir;
        }
    }
    // Fallback: OS downloads folder for manual/unbound windows
    return app.getPath('downloads');
}

export function uniqueFilename(transportOwner: BrowserPaneManager, dir: string, filename: string): string {
    const rawBase = basename(String(filename || '').replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').trim();
    const safeFilename = !rawBase || rawBase === '.' || rawBase === '..' ? 'download' : rawBase;
    if (!existsSync(join(dir, safeFilename)))
        return safeFilename;
    const { name, ext } = parsePath(safeFilename);
    let counter = 1;
    while (existsSync(join(dir, `${name}_${counter}${ext}`))) {
        counter++;
    }
    return `${name}_${counter}${ext}`;
}

export async function selectWebAuthnAccount(transportOwner: BrowserPaneManager, details: BrowserPaneSelectWebAuthnAccountDetailsPayload): Promise<string | undefined> {
    if (details.accounts.length === 0)
        return undefined;
    if (details.accounts.length === 1)
        return details.accounts[0]?.credentialId;
    const accountButtons = details.accounts.map((account, index) => (account.displayName
        || account.name
        || i18n.t('browser.passkeyAccountFallback', { number: index + 1 })));
    const cancelLabel = i18n.t('common.cancel');
    const parentWindow = Array.from(transportOwner["instances"].values()).find((instance) => (!instance.window.isDestroyed()
        && instance.pageView.webContents.mainFrame === details.frame?.top))?.window;
    const options: Electron.MessageBoxOptions = {
        type: 'question',
        title: app.getName(),
        message: i18n.t('browser.passkeyAccountPrompt', {
            relyingPartyId: details.relyingPartyId,
        }),
        buttons: [...accountButtons, cancelLabel],
        defaultId: 0,
        cancelId: accountButtons.length,
        noLink: true,
    };
    const result = parentWindow
        ? await dialog.showMessageBox(parentWindow, options)
        : await dialog.showMessageBox(options);
    return details.accounts[result.response]?.credentialId;
}

export function logPermissionDecision(transportOwner: BrowserPaneManager, kind: 'check' | 'request', permission: string, origin: string): void {
    const isNonBlockingNoise = permission === 'background-sync';
    const suffix = isNonBlockingNoise ? ' (non-blocking)' : '';
    const message = `[browser-pane] permission denied (${kind}): ${permission} origin=${origin}${suffix}`;
    if (isNonBlockingNoise) {
        mainLog.info(message);
        return;
    }
    mainLog.warn(message);
}
