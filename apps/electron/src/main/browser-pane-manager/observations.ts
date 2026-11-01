/**
 * BrowserPaneManager
 *
 * Owns browser instances as dedicated BrowserWindow objects.
 * Each instance maps 1:1 to a full native window while preserving
 * shared session/cookie partition and CDP automation support.
 */
import { join } from "path";
import { type Session as ElectronSession } from "electron";
import { mainLog } from "../logger";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserDownloadEntry } from './shared.ts';
import * as browserPaneManagerSessionRecords from './session-records.ts';

export function setupSessionObservers(transportOwner: BrowserPaneManager, ses: ElectronSession): void {
    if (transportOwner["partitionObserversInitialized"])
        return;
    transportOwner["partitionObserversInitialized"] = true;
    ses.on('select-webauthn-account', (_event, details, callback) => {
        void (async () => {
            let credentialId: string | undefined;
            try {
                credentialId = await browserPaneManagerSessionRecords.selectWebAuthnAccount(transportOwner, details);
            }
            catch (error) {
                mainLog.warn(`[browser-pane] WebAuthn account selection failed rp=${details.relyingPartyId} error=${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                callback(credentialId);
            }
            catch (error) {
                mainLog.warn(`[browser-pane] WebAuthn account callback failed rp=${details.relyingPartyId} error=${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
        const wcId = details.webContentsId;
        if (typeof wcId === 'number' && wcId > 0) {
            const current = transportOwner["inFlightRequestsByWebContentsId"].get(wcId) ?? 0;
            transportOwner["inFlightRequestsByWebContentsId"].set(wcId, current + 1);
            transportOwner["lastNetworkActivityByWebContentsId"].set(wcId, Date.now());
        }
        callback({});
    });
    ses.webRequest.onCompleted((details) => {
        const wcId = details.webContentsId;
        if (typeof wcId !== 'number' || wcId <= 0)
            return;
        const current = transportOwner["inFlightRequestsByWebContentsId"].get(wcId) ?? 0;
        transportOwner["inFlightRequestsByWebContentsId"].set(wcId, Math.max(0, current - 1));
        transportOwner["lastNetworkActivityByWebContentsId"].set(wcId, Date.now());
        const instance = transportOwner["getInstanceByWebContentsId"](wcId);
        if (!instance)
            return;
        browserPaneManagerSessionRecords.pushNetworkLog(transportOwner, instance, {
            timestamp: Date.now(),
            method: details.method ?? 'GET',
            url: details.url ?? '',
            status: details.statusCode ?? 0,
            resourceType: String(details.resourceType ?? 'unknown'),
            ok: (details.statusCode ?? 0) >= 200 && (details.statusCode ?? 0) < 400,
        });
    });
    ses.webRequest.onErrorOccurred((details) => {
        const wcId = details.webContentsId;
        if (typeof wcId !== 'number' || wcId <= 0)
            return;
        const current = transportOwner["inFlightRequestsByWebContentsId"].get(wcId) ?? 0;
        transportOwner["inFlightRequestsByWebContentsId"].set(wcId, Math.max(0, current - 1));
        transportOwner["lastNetworkActivityByWebContentsId"].set(wcId, Date.now());
        const instance = transportOwner["getInstanceByWebContentsId"](wcId);
        if (!instance)
            return;
        browserPaneManagerSessionRecords.pushNetworkLog(transportOwner, instance, {
            timestamp: Date.now(),
            method: details.method ?? 'GET',
            url: details.url ?? '',
            status: 0,
            resourceType: String(details.resourceType ?? 'unknown'),
            ok: false,
        });
    });
    ses.on('will-download', (_event, item, webContents) => {
        const wcId = webContents?.id;
        if (typeof wcId !== 'number')
            return;
        const instance = transportOwner["getInstanceByWebContentsId"](wcId);
        if (!instance)
            return;
        // Auto-save: set a deterministic path so Electron doesn't show a native dialog
        const downloadsDir = browserPaneManagerSessionRecords.resolveDownloadsDir(transportOwner, instance);
        const filename = browserPaneManagerSessionRecords.uniqueFilename(transportOwner, downloadsDir, item.getFilename());
        const savePath = join(downloadsDir, filename);
        item.setSavePath(savePath);
        const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const started: BrowserDownloadEntry = {
            id: downloadId,
            timestamp: Date.now(),
            url: item.getURL(),
            filename,
            state: 'started',
            bytesReceived: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
            mimeType: item.getMimeType() || 'application/octet-stream',
            savePath,
        };
        browserPaneManagerSessionRecords.pushDownloadLog(transportOwner, instance, started);
        const onUpdated = (_e: Electron.Event, state: string) => {
            const latest = instance.downloads.find((d) => d.id === downloadId);
            if (!latest)
                return;
            latest.bytesReceived = item.getReceivedBytes();
            latest.totalBytes = item.getTotalBytes();
            if (state === 'interrupted')
                latest.state = 'interrupted';
        };
        item.on('updated', onUpdated);
        item.once('done', (_e, state) => {
            item.removeListener('updated', onUpdated);
            const latest = instance.downloads.find((d) => d.id === downloadId);
            if (!latest)
                return;
            latest.bytesReceived = item.getReceivedBytes();
            latest.totalBytes = item.getTotalBytes();
            latest.savePath = item.getSavePath();
            latest.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
        });
    });
}
