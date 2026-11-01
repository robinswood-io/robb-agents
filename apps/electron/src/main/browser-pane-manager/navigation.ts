import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserPaneNavigateResult } from './protocol.ts';
import * as browserPaneManagerNavigationRules from './navigation-rules.ts';
import * as browserPaneManagerToolbarState from './toolbar-state.ts';

export async function navigate(transportOwner: BrowserPaneManager, id: string, url: string): Promise<BrowserPaneNavigateResult> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner["navigateAtCurrentInstance"](id, url));
}

export async function navigateAtCurrentInstance(transportOwner: BrowserPaneManager, id: string, url: string): Promise<BrowserPaneNavigateResult> {
    const instance = transportOwner["requireAliveInstance"](id);
    let normalizedUrl = url.trim();
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedUrl);
    const isAbout = normalizedUrl.startsWith('about:');
    if (!hasScheme && !isAbout) {
        const looksLikeHost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(normalizedUrl);
        if (looksLikeHost) {
            normalizedUrl = `https://${normalizedUrl}`;
        }
        else {
            normalizedUrl = `https://duckduckgo.com/?q=${encodeURIComponent(normalizedUrl)}`;
        }
    }
    if (normalizedUrl !== 'about:blank' && !browserPaneManagerNavigationRules.isBrowserEmptyStateUrl(transportOwner, normalizedUrl)) {
        let parsed: URL;
        try {
            parsed = new URL(normalizedUrl);
        }
        catch {
            throw new Error(`Invalid navigation URL: "${normalizedUrl}"`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Blocked navigation to unsupported protocol "${parsed.protocol}"`);
        }
    }
    const timeoutMs = 30000;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
        const loaded = instance.pageView.webContents.loadURL(normalizedUrl);
        const timeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(`Navigation to "${normalizedUrl}" timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        });
        await Promise.race([loaded, timeout]);
        browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
        return { url: instance.currentUrl, title: instance.title };
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

export async function goBack(transportOwner: BrowserPaneManager, id: string): Promise<void> {
    await transportOwner["runSerializedBrowserOperation"](id, () => transportOwner["navigateHistoryAtCurrentInstance"](id, 'back'));
}

export async function goForward(transportOwner: BrowserPaneManager, id: string): Promise<void> {
    await transportOwner["runSerializedBrowserOperation"](id, () => transportOwner["navigateHistoryAtCurrentInstance"](id, 'forward'));
}

export async function navigateHistoryAtCurrentInstance(transportOwner: BrowserPaneManager, id: string, direction: 'back' | 'forward'): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    const webContents = instance.pageView.webContents;
    const canNavigate = direction === 'back'
        ? webContents.canGoBack()
        : webContents.canGoForward();
    if (!canNavigate)
        return;
    // Electron's goBack/goForward calls return before the history navigation
    // commits. Keep the per-instance operation queue held until the new live
    // URL is observable, otherwise a queued mutation can validate the previous
    // CMS URL and execute while the window is already moving to Gmail.
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeoutMs = 30000;
        const cleanup = () => {
            clearTimeout(timer);
            webContents.removeListener('did-navigate', onMainFrameNavigate);
            webContents.removeListener('did-navigate-in-page', onInPageNavigate);
            webContents.removeListener('did-fail-load', onFail);
            webContents.removeListener('destroyed', onDestroyed);
        };
        const finish = (error?: Error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (error)
                reject(error);
            else
                resolve();
        };
        const onMainFrameNavigate = () => finish();
        const onInPageNavigate = (_event: unknown, _url: string, isMainFrame: boolean) => {
            if (isMainFrame === false)
                return;
            finish();
        };
        const onFail = (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
            if (isMainFrame === false)
                return;
            finish(new Error(`Browser history ${direction} navigation failed (${errorCode}) for "${validatedURL}": ${errorDescription}`));
        };
        const onDestroyed = () => finish(new Error(`Browser instance was destroyed during history ${direction}: ${id}`));
        const timer = setTimeout(() => finish(new Error(`Browser history ${direction} navigation timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        // Use persistent listeners plus explicit cleanup: a sub-frame in-page
        // event or failure must not consume the main-frame completion guard.
        webContents.on('did-navigate', onMainFrameNavigate);
        webContents.on('did-navigate-in-page', onInPageNavigate);
        webContents.on('did-fail-load', onFail);
        webContents.on('destroyed', onDestroyed);
        try {
            if (direction === 'back')
                webContents.goBack();
            else
                webContents.goForward();
        }
        catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export function reload(transportOwner: BrowserPaneManager, id: string): void {
    const instance = transportOwner["instances"].get(id);
    if (!instance || instance.window.isDestroyed())
        return;
    instance.pageView.webContents.reload();
}

export function stop(transportOwner: BrowserPaneManager, id: string): void {
    const instance = transportOwner["instances"].get(id);
    if (!instance || instance.window.isDestroyed())
        return;
    instance.pageView.webContents.stop();
}

export function normalizePageState(transportOwner: BrowserPaneManager, url: string, title: string): BrowserPaneNavigateResult {
    if (browserPaneManagerNavigationRules.isBrowserEmptyStateUrl(transportOwner, url)) {
        return { url: 'about:blank', title: 'New Tab' };
    }
    return { url, title };
}
