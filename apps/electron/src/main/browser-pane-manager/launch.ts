import { omitUndefined } from '@craft-agent/shared/utils/json';
import { mainLog } from "../logger";
import { type BrowserEmptyStateLaunchPayload, type BrowserEmptyStateLaunchResult } from "../../shared/types";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { CRAFT_DEEPLINK_SCHEME_PREFIX } from './shared.ts';
import type { BrowserInstance } from './shared.ts';
import * as browserPaneManagerWindowState from './window-state.ts';
import * as browserPaneManagerNavigationRules from './navigation-rules.ts';

export async function handleEmptyStateLaunchFromRenderer(transportOwner: BrowserPaneManager, senderWebContentsId: number, payload: BrowserEmptyStateLaunchPayload): Promise<BrowserEmptyStateLaunchResult> {
    const instance = browserPaneManagerWindowState.findInstanceByPageWebContentsId(transportOwner, senderWebContentsId);
    if (!instance) {
        mainLog.warn(`[browser-pane] empty-state launch ignored: sender not mapped senderWebContentsId=${senderWebContentsId}`);
        return { ok: false, handled: false, reason: 'instance_not_found' };
    }
    const route = payload.route?.trim();
    if (!route) {
        mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`);
        return { ok: false, handled: false, reason: 'missing_route' };
    }
    const token = payload.token ?? null;
    const handled = await transportOwner.triggerEmptyStateRouteLaunch(instance, route, token, 'ipc');
    return omitUndefined<BrowserEmptyStateLaunchResult>({
        ok: true,
        handled,
        reason: handled ? undefined : 'duplicate',
    });
}

export function buildDeepLinkFromRoute(transportOwner: BrowserPaneManager, route: string): string {
    const queryStart = route.indexOf('?');
    const routePath = queryStart >= 0 ? route.slice(0, queryStart) : route;
    const routeQuery = queryStart >= 0 ? route.slice(queryStart + 1) : '';
    let normalizedPath = routePath.replace(/^\/+/, '');
    const workspaceId = browserPaneManagerNavigationRules.resolveLaunchWorkspaceId(transportOwner);
    if (workspaceId && !normalizedPath.startsWith('workspace/')) {
        normalizedPath = `workspace/${encodeURIComponent(workspaceId)}/${normalizedPath}`;
    }
    return `${CRAFT_DEEPLINK_SCHEME_PREFIX}${normalizedPath}${routeQuery ? `?${routeQuery}` : ''}`;
}

export async function triggerEmptyStateRouteLaunch(transportOwner: BrowserPaneManager, instance: BrowserInstance, route: string, token: string | null, source: 'hash' | 'ipc'): Promise<boolean> {
    const dedupeToken = token ?? route;
    if (dedupeToken && instance.lastLaunchToken === dedupeToken) {
        mainLog.info(`[browser-pane] ignoring duplicate empty-state launch id=${instance.id} source=${source} token=${dedupeToken}`);
        return false;
    }
    instance.lastLaunchToken = dedupeToken;
    const deepLink = transportOwner.buildDeepLinkFromRoute(route);
    mainLog.info(`[browser-pane] handling empty-state launch id=${instance.id} source=${source} route=${route} deepLink=${deepLink}`);
    await browserPaneManagerNavigationRules.handleDeepLinkUrl(transportOwner, deepLink);
    return true;
}

export async function maybeHandleEmptyStateLaunch(transportOwner: BrowserPaneManager, instance: BrowserInstance, url: string): Promise<boolean> {
    if (!browserPaneManagerNavigationRules.isBrowserEmptyStateUrl(transportOwner, url) || !url.includes('#launch=')) {
        return false;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    }
    catch {
        return false;
    }
    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    const launchPayload = hash.startsWith('launch=') ? hash.slice('launch='.length) : hash;
    if (!launchPayload)
        return false;
    const params = new URLSearchParams(launchPayload);
    const route = params.get('route');
    const token = params.get('ts') ?? route ?? null;
    if (!route) {
        mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`);
        return false;
    }
    const handled = await transportOwner.triggerEmptyStateRouteLaunch(instance, route, token, 'hash');
    try {
        await instance.pageView.webContents.executeJavaScript("if (window.location.hash.includes('launch=')) history.replaceState(null, '', window.location.pathname + window.location.search);");
    }
    catch {
        // Best effort cleanup only
    }
    return handled;
}
