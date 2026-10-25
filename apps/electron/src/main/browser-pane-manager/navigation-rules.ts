import { shell } from "electron";
import { mainLog } from "../logger";
import type { BrowserMutationUrlPolicy } from "@craft-agent/server-core/handlers";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { BROWSER_EMPTY_STATE_PAGE, CRAFT_DEEPLINK_SCHEME_PREFIX } from './shared.ts';
import type { BrowserInstance } from './shared.ts';

export function mutationUrlAllowed(transportOwner: BrowserPaneManager, instance: BrowserInstance, policy?: BrowserMutationUrlPolicy): boolean {
    if (!policy)
        return true;
    if (policy.reason !== 'contextual-gmail-reply'
        || !Array.isArray(policy.blockedHosts)
        || policy.blockedHosts.length === 0
        || policy.blockedHosts.length > 16
        || policy.blockedHosts.some(host => typeof host !== 'string'
            || host !== host.trim().toLowerCase()
            || !/^[a-z0-9.-]+$/u.test(host))) {
        throw new Error('Invalid browser mutation URL policy received by the desktop host.');
    }
    let target: URL;
    try {
        const liveUrl = instance.pageView.webContents.getURL() || instance.currentUrl;
        target = new URL(liveUrl);
    }
    catch {
        // Under a host-issued mutation policy, an unknown transition target is
        // not evidence that the page is outside the blocked origin. Fail closed
        // until Electron exposes one parseable live URL.
        return false;
    }
    const targetHostname = target.hostname.toLowerCase().replace(/\.+$/u, '');
    return !policy.blockedHosts.some(host => targetHostname === host
        || policy.matchSubdomains === true && targetHostname.endsWith(`.${host}`));
}

export function resolveLaunchWorkspaceId(transportOwner: BrowserPaneManager): string | null {
    if (!transportOwner["windowManager"])
        return null;
    const focusedWindow = transportOwner["windowManager"].getFocusedWindow();
    if (focusedWindow) {
        const focusedWorkspaceId = transportOwner["windowManager"].getWorkspaceForWindow(focusedWindow.webContents.id);
        if (focusedWorkspaceId) {
            return focusedWorkspaceId;
        }
    }
    const managedWindows = transportOwner["windowManager"].getAllWindows();
    return managedWindows[0]?.workspaceId ?? null;
}

export function isBrowserEmptyStateUrl(transportOwner: BrowserPaneManager, url: string): boolean {
    if (!url)
        return false;
    return url.includes(`/${BROWSER_EMPTY_STATE_PAGE}`) || url.includes(`\\${BROWSER_EMPTY_STATE_PAGE}`);
}

export function isAbortedNavigationError(transportOwner: BrowserPaneManager, error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
        const candidate = error as {
            code?: unknown;
            errno?: unknown;
        };
        if (candidate.code === 'ERR_ABORTED' || candidate.errno === -3)
            return true;
    }
    return error instanceof Error && error.message.includes('ERR_ABORTED');
}

export async function handleDeepLinkUrl(transportOwner: BrowserPaneManager, url: string): Promise<void> {
    if (!url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX))
        return;
    try {
        if (!transportOwner["windowManager"]) {
            mainLog.warn('[browser-pane] window manager unavailable for deep-link handling, falling back to shell.openExternal');
            await shell.openExternal(url);
            return;
        }
        const { handleDeepLink } = await import("../deep-link");
        const sink = transportOwner["windowManager"].getRpcEventSink() ?? undefined;
        const resolver = (wcId: number) => transportOwner["windowManager"]?.getClientIdForWindow(wcId);
        const result = await handleDeepLink(url, transportOwner["windowManager"], sink, resolver);
        if (!result.success) {
            mainLog.warn(`[browser-pane] deep-link handling failed: ${result.error ?? 'unknown error'} url=${url}`);
        }
    }
    catch (error) {
        mainLog.warn(`[browser-pane] deep-link handling threw, falling back to shell.openExternal: ${error instanceof Error ? error.message : String(error)}`);
        await shell.openExternal(url);
    }
}

export function isToolbarUiDocumentUrl(transportOwner: BrowserPaneManager, url: string): boolean {
    if (!url)
        return false;
    if (url.startsWith('data:text/html'))
        return true;
    try {
        const parsed = new URL(url);
        return parsed.pathname.toLowerCase().endsWith('/browser-toolbar.html');
    }
    catch {
        return /browser-toolbar\.html(?:$|[?#])/i.test(url);
    }
}
