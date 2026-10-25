/**
 * BrowserPaneManager
 *
 * Owns browser instances as dedicated BrowserWindow objects.
 * Each instance maps 1:1 to a full native window while preserving
 * shared session/cookie partition and CDP automation support.
 */
import { join } from "path";
import { BrowserWindow, WebContentsView, nativeTheme, session } from "electron";
import { mainLog } from "../logger";
import { BrowserCDP } from "../browser-cdp";
import { type BrowserInstanceInfo } from "../../shared/types";
import type { BrowserInstanceSnapshot } from "@craft-agent/server-core/handlers";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { SESSION_PARTITION } from './shared.ts';
import type { BrowserInstance, CreateBrowserInstanceOptions } from './shared.ts';
import type { BrowserPaneCreateForSessionAsyncOptionsPayload, BrowserPaneGetOrCreateForSessionAsyncOptionsPayload } from './protocol.ts';
import * as browserPaneManagerWindowState from './window-state.ts';
import * as browserPaneManagerNavigationRules from './navigation-rules.ts';

let instanceCounter = 0;

export function createInstance(transportOwner: BrowserPaneManager, moduleDirectory: string, id?: string, options?: CreateBrowserInstanceOptions): string {
    const instanceId = id || `browser-${++instanceCounter}`;
    const shouldShow = options?.show ?? false;
    const ownerType = options?.ownerType ?? 'manual';
    const ownerSessionId = ownerType === 'session' ? (options?.ownerSessionId ?? null) : null;
    const workspaceId = options?.workspaceId ?? null;
    if (transportOwner["instances"].has(instanceId)) {
        mainLog.warn(`[browser-pane] Instance already exists, reusing: ${instanceId}`);
        return instanceId;
    }
    const ses = session.fromPartition(SESSION_PARTITION);
    transportOwner["setupSessionPermissions"](ses);
    transportOwner["setupSessionObservers"](ses);
    // Match background to current OS theme to prevent black/white flash on open
    const bgColor = nativeTheme.shouldUseDarkColors ? '#2b292e' : '#fafafb';
    const window = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 700,
        minHeight: 500,
        show: false, // Always hidden until toolbar is painted (ready-to-show)
        backgroundColor: bgColor,
        // Fully chromeless — toolbar is rendered in a dedicated WebContentsView
        frame: false,
        webPreferences: {
            partition: SESSION_PARTITION,
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    const toolbarView = new WebContentsView({
        webPreferences: {
            preload: join(moduleDirectory, 'browser-toolbar-preload.cjs'),
            partition: SESSION_PARTITION,
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    const pageView = new WebContentsView({
        webPreferences: {
            partition: SESSION_PARTITION,
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    const nativeOverlayView = new WebContentsView({
        webPreferences: {
            partition: SESSION_PARTITION,
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    // WebContentsView defaults to opaque white. CSS transparency alone cannot
    // reveal the page beneath the toolbar or the agent/menu overlay.
    toolbarView.setBackgroundColor('#00000000');
    pageView.setBackgroundColor(bgColor);
    nativeOverlayView.setBackgroundColor('#00000000');
    const cdp = new BrowserCDP(pageView.webContents);
    const instance: BrowserInstance = {
        pageWebContentsId: pageView.webContents.id,
        id: instanceId,
        window,
        toolbarView,
        pageView,
        nativeOverlayView,
        cdp,
        currentUrl: 'about:blank',
        title: 'New Tab',
        favicon: null,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        boundSessionId: ownerSessionId,
        ownerType,
        ownerSessionId,
        workspaceId,
        isVisible: false,
        isHiding: false,
        keepAliveOnWindowClose: true,
        toolbarReady: false,
        toolbarMenuOpen: false,
        toolbarMenuHeight: 0,
        toolbarMenuOverlayActive: false,
        showOnCreate: shouldShow,
        pendingShowOnReady: false,
        pendingShowToken: 0,
        lastAction: null,
        agentControl: null,
        lockState: {
            active: false,
            previousResizable: browserPaneManagerWindowState.getWindowResizable(transportOwner, window),
        },
        nativeOverlayReady: false,
        themeColor: null,
        inPageThemeTimer: null,
        themeObserverToken: null,
        consoleLogs: [],
        networkLogs: [],
        downloads: [],
        lastLaunchToken: null,
    };
    const defaultUa = pageView.webContents.userAgent || '';
    const sanitizedUa = defaultUa.replace(/\sElectron\/[^\s]+/g, '');
    if (sanitizedUa && sanitizedUa !== defaultUa) {
        pageView.webContents.setUserAgent(sanitizedUa);
    }
    // Child view order is the z-order. Re-adding an existing child later brings it
    // to the front, which replaces BrowserWindow.setTopBrowserView.
    window.contentView.addChildView(pageView);
    window.contentView.addChildView(nativeOverlayView);
    window.contentView.addChildView(toolbarView);
    void transportOwner["loadNativeOverlayPage"](instance);
    transportOwner["layoutAllViews"](instance);
    transportOwner["setupWindowListeners"](instance);
    transportOwner["instances"].set(instanceId, instance);
    transportOwner["emitStateChange"](instance);
    mainLog.info(`[browser-pane] toolbar version: v4-react-chromeless`);
    mainLog.info(`[browser-pane] Created instance: ${instanceId} (show=${shouldShow}, ownerType=${ownerType}, ownerSessionId=${ownerSessionId ?? 'none'})`);
    void transportOwner["loadToolbarPage"](instance)
        .finally(() => {
        // Safety net: if Electron never fires ready-to-show, still unblock focus/show behavior.
        if (transportOwner["isLiveToolbarInstance"](instance) && !instance.toolbarReady) {
            transportOwner["markToolbarReady"](instance, 'toolbar-load-finalized');
        }
    });
    void transportOwner["loadEmptyStatePage"](instance).catch((error) => {
        if (browserPaneManagerNavigationRules.isAbortedNavigationError(transportOwner, error)) {
            mainLog.info(`[browser-pane] empty-state load superseded by navigation id=${instance.id}`);
            return;
        }
        mainLog.warn(`[browser-pane] empty-state load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`);
        void pageView.webContents.loadURL('about:blank');
    });
    return instanceId;
}

export function destroyInstance(transportOwner: BrowserPaneManager, id: string): void {
    const instance = transportOwner["instances"].get(id);
    if (!instance) {
        mainLog.info(`[browser-pane] destroy requested for missing instance id=${id}`);
        return;
    }
    const destroyedBefore = instance.window.isDestroyed();
    mainLog.info(`[browser-pane] destroy requested id=${id} destroyedBefore=${destroyedBefore} keepAlive=${instance.keepAliveOnWindowClose}`);
    // Clear pending timers before destroying the window
    if (instance.inPageThemeTimer) {
        clearTimeout(instance.inPageThemeTimer);
        instance.inPageThemeTimer = null;
    }
    instance.themeObserverToken = null;
    instance.pendingShowOnReady = false;
    instance.pendingShowToken += 1;
    // Clean up in-flight network tracking for this instance's webContents
    const wcId = instance.pageWebContentsId;
    transportOwner["inFlightRequestsByWebContentsId"].delete(wcId);
    transportOwner["lastNetworkActivityByWebContentsId"].delete(wcId);
    const runCleanup = (label: string, action: () => void): void => {
        try {
            action();
        }
        catch (error) {
            mainLog.warn(`[browser-pane] destroy cleanup failed id=${id} step=${label} error=${error instanceof Error ? error.message : String(error)}`);
        }
    };
    runCleanup('closePopupsForParent', () => transportOwner["closePopupsForParent"](instance.id, 'parent_destroy'));
    runCleanup('applyAgentControlLock', () => transportOwner["applyAgentControlLock"](instance, false));
    runCleanup('updateNativeOverlayState', () => transportOwner["updateNativeOverlayState"](instance));
    try {
        if (!instance.window.isDestroyed()) {
            transportOwner["destroyingIds"].add(id);
            instance.window.destroy();
        }
    }
    catch (error) {
        mainLog.warn(`[browser-pane] destroy failed id=${id} error=${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        // Finalize synchronously in case closed does not fire (or fires later).
        transportOwner["finalizeDestroyedInstance"](instance, 'destroy');
        mainLog.info(`[browser-pane] destroy completed id=${id} removed=${!transportOwner["instances"].has(id)}`);
    }
}

export function cleanupDestroyedInstance(transportOwner: BrowserPaneManager, instance: BrowserInstance, reason: string): void {
    transportOwner["finalizeDestroyedInstance"](instance, 'closed');
    mainLog.info(`[browser-pane] cleaned up stale instance ${instance.id}: ${reason}`);
}

/**
   * Get an instance that is confirmed alive (window not destroyed).
   * Throws a clear error if the instance is missing or its window was closed.
   * Automatically cleans up stale entries from the instance map.
   */
export function requireAliveInstance(transportOwner: BrowserPaneManager, id: string): BrowserInstance {
    const instance = transportOwner["instances"].get(id);
    if (!instance)
        throw new Error(`Browser instance not found: ${id}`);
    if (instance.window.isDestroyed()) {
        transportOwner["cleanupDestroyedInstance"](instance, `lookup by id ${id}`);
        throw new Error(`Browser window was closed (instance: ${id})`);
    }
    return instance;
}

export function listInstances(transportOwner: BrowserPaneManager): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = [];
    for (const instance of transportOwner["instances"].values()) {
        if (instance.window.isDestroyed()) {
            transportOwner["cleanupDestroyedInstance"](instance, 'listInstances');
            continue;
        }
        infos.push(transportOwner["toInfo"](instance));
    }
    return infos;
}

export async function listInstancesAsync(transportOwner: BrowserPaneManager): Promise<BrowserInstanceInfo[]> {
    return transportOwner["listInstances"]();
}

export async function getInstanceAsync(transportOwner: BrowserPaneManager, id: string): Promise<BrowserInstanceSnapshot | undefined> {
    return transportOwner["getInstance"](id);
}

export async function createForSessionAsync(transportOwner: BrowserPaneManager, sessionId: string, options?: BrowserPaneCreateForSessionAsyncOptionsPayload): Promise<string> {
    return transportOwner["createForSession"](sessionId, options);
}

export async function getOrCreateForSessionAsync(transportOwner: BrowserPaneManager, sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): Promise<string> {
    return transportOwner["getOrCreateForSession"](sessionId, options);
}

export async function focusBoundForSessionAsync(transportOwner: BrowserPaneManager, sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): Promise<string> {
    return transportOwner["focusBoundForSession"](sessionId, options);
}

export function isLiveInstance(transportOwner: BrowserPaneManager, instance: BrowserInstance): boolean {
    return transportOwner["instances"].get(instance.id) === instance
        && !transportOwner["destroyingIds"].has(instance.id)
        && browserPaneManagerWindowState.isBrowserWindowAlive(transportOwner, instance.window);
}
