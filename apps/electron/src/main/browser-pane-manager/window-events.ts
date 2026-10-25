import { mainLog } from "../logger";
import { redactSecretLikeMaterial } from "@craft-agent/shared/utils";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { MAX_CONSOLE_LOG_ENTRIES, THEME_COLOR_SIGNAL_PREFIX, THEME_COLOR_NULL_SENTINEL, CRAFT_DEEPLINK_SCHEME_PREFIX, SESSION_PARTITION } from './shared.ts';
import type { BrowserInstance, BrowserConsoleEntry } from './shared.ts';
import * as browserPaneManagerNavigationRules from './navigation-rules.ts';
import * as browserPaneManagerToolbarState from './toolbar-state.ts';

export function setupWindowListeners(transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    const pageWc = instance.pageView.webContents;
    const toolbarWc = instance.toolbarView.webContents;
    const overlayWc = instance.nativeOverlayView.webContents;
    instance.window.on('close', (event) => {
        const explicitDestroy = transportOwner["destroyingIds"].has(instance.id);
        const interceptToHide = !explicitDestroy && instance.keepAliveOnWindowClose;
        mainLog.info(`[browser-pane] window close requested id=${instance.id} explicitDestroy=${explicitDestroy} keepAlive=${instance.keepAliveOnWindowClose} interceptToHide=${interceptToHide}`);
        if (interceptToHide) {
            event.preventDefault();
            // Skip if a hide is already in flight — hide() guards against re-entry
            // itself, but bailing here also avoids redundant log noise during the
            // teardown race that triggered issue #695.
            if (!instance.isHiding) {
                transportOwner["hide"](instance.id);
            }
        }
    });
    instance.window.on('resize', () => {
        transportOwner["layoutAllViews"](instance);
    });
    instance.window.on('ready-to-show', () => {
        transportOwner["markToolbarReady"](instance, 'ready-to-show');
    });
    toolbarWc.on('did-finish-load', () => {
        const loadedUrl = typeof toolbarWc.getURL === 'function' ? toolbarWc.getURL() : '';
        if (!browserPaneManagerNavigationRules.isToolbarUiDocumentUrl(transportOwner, loadedUrl)) {
            mainLog.info(`[browser-pane] toolbar did-finish-load ignored id=${instance.id} url=${loadedUrl || 'unknown'}`);
            browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
            return;
        }
        transportOwner["markToolbarReady"](instance, 'did-finish-load');
        browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
    });
    toolbarWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame)
            return;
        mainLog.warn(`[browser-pane] toolbar did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`);
    });
    pageWc.on('did-start-loading', () => {
        instance.isLoading = true;
        transportOwner["emitStateChange"](instance);
        void browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
    });
    pageWc.on('did-stop-loading', () => {
        instance.isLoading = false;
        instance.canGoBack = pageWc.canGoBack();
        instance.canGoForward = pageWc.canGoForward();
        // Drain in-flight count — all pending requests are settled once loading stops
        transportOwner["inFlightRequestsByWebContentsId"].set(pageWc.id, 0);
        transportOwner["lastNetworkActivityByWebContentsId"].set(pageWc.id, Date.now());
        transportOwner["emitStateChange"](instance);
        void browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
        void transportOwner["extractThemeColor"](instance);
        transportOwner["reapplyAgentControlVisual"](instance);
    });
    pageWc.on('dom-ready', () => {
        transportOwner["installThemeObserver"](instance);
        void transportOwner["extractThemeColor"](instance);
    });
    pageWc.on('before-input-event', (_event, _input) => {
        if (instance.lockState.active) {
            _event.preventDefault();
        }
    });
    toolbarWc.on('before-input-event', (event) => {
        if (instance.lockState.active) {
            event.preventDefault();
        }
    });
    overlayWc.on('before-input-event', (event, input) => {
        if (!instance.toolbarMenuOverlayActive)
            return;
        const inputType = input.type || '';
        if (inputType === 'mouseDown' || inputType === 'touchStart' || inputType === 'pointerDown') {
            event.preventDefault();
            transportOwner["forceCloseToolbarMenu"](instance, 'overlay-tap');
        }
    });
    pageWc.on('did-navigate', (_event, urlFromEvent) => {
        const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || instance.currentUrl);
        const previousUrl = instance.currentUrl;
        if (instance.inPageThemeTimer) {
            clearTimeout(instance.inPageThemeTimer);
            instance.inPageThemeTimer = null;
        }
        instance.themeObserverToken = null;
        instance.themeColor = null; // reset for new page (batched with state push below)
        const normalized = transportOwner["normalizePageState"](url, pageWc.getTitle());
        instance.currentUrl = normalized.url;
        instance.title = normalized.title;
        mainLog.info(`[browser-pane] did-navigate id=${instance.id} from=${previousUrl} to=${instance.currentUrl}`);
        instance.canGoBack = pageWc.canGoBack();
        instance.canGoForward = pageWc.canGoForward();
        // Drain in-flight count — prior page's requests are cancelled on navigation
        transportOwner["inFlightRequestsByWebContentsId"].set(pageWc.id, 0);
        transportOwner["lastNetworkActivityByWebContentsId"].set(pageWc.id, Date.now());
        transportOwner["emitStateChange"](instance);
        void browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
        transportOwner["scheduleEarlyThemeExtraction"](instance, url);
        transportOwner["reapplyAgentControlVisual"](instance);
    });
    pageWc.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (!isMainFrame)
            return;
        mainLog.info(`[browser-pane] did-redirect-navigation id=${instance.id} url=${url} inPlace=${isInPlace}`);
    });
    pageWc.on('did-navigate-in-page', (_event, urlFromEvent) => {
        const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || instance.currentUrl);
        const normalized = transportOwner["normalizePageState"](url, instance.title);
        instance.currentUrl = normalized.url;
        instance.title = normalized.title;
        instance.canGoBack = pageWc.canGoBack();
        instance.canGoForward = pageWc.canGoForward();
        void transportOwner["maybeHandleEmptyStateLaunch"](instance, url).then((handled) => {
            if (handled) {
                transportOwner["emitStateChange"](instance);
                void browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
                return;
            }
            // SPA route change — re-extract theme color (debounced)
            if (instance.inPageThemeTimer)
                clearTimeout(instance.inPageThemeTimer);
            instance.themeObserverToken = null;
            instance.themeColor = null;
            transportOwner["emitStateChange"](instance);
            void browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
            transportOwner["installThemeObserver"](instance);
            instance.inPageThemeTimer = setTimeout(() => { void transportOwner["extractThemeColor"](instance); }, 300);
            transportOwner["reapplyAgentControlVisual"](instance);
        }).catch((error) => {
            mainLog.warn(`[browser-pane] empty-state launch handling failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
    pageWc.on('page-title-updated', (_event, title) => {
        const normalized = transportOwner["normalizePageState"](pageWc.getURL(), title);
        instance.title = normalized.title;
        transportOwner["emitStateChange"](instance);
        void browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
    });
    pageWc.on('page-favicon-updated', (_event, favicons) => {
        instance.favicon = favicons[0] || null;
        transportOwner["emitStateChange"](instance);
    });
    pageWc.on('did-change-theme-color', (_event, color) => {
        transportOwner["applyThemeColor"](instance, color ?? null);
    });
    pageWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        mainLog.warn(`[browser-pane] did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`);
    });
    pageWc.on('console-message', (_event, level, message) => {
        if (message.startsWith(THEME_COLOR_SIGNAL_PREFIX)) {
            const payload = message.slice(THEME_COLOR_SIGNAL_PREFIX.length);
            const delimiterIdx = payload.indexOf(':');
            if (delimiterIdx > 0) {
                const token = payload.slice(0, delimiterIdx);
                const value = payload.slice(delimiterIdx + 1).trim();
                if (token === instance.themeObserverToken) {
                    if (value === THEME_COLOR_NULL_SENTINEL) {
                        transportOwner["applyThemeColor"](instance, null);
                    }
                    else if (value.length > 0) {
                        transportOwner["applyThemeColor"](instance, value);
                    }
                }
            }
            return;
        }
        const mappedLevel: BrowserConsoleEntry['level'] = level >= 3 ? 'error' : level === 2 ? 'warn' : level === 1 ? 'info' : 'log';
        // Browser console messages can contain full OAuth callback URLs emitted
        // by third-party pages. Redact before retaining the entry so neither the
        // browser console tool nor the main logger receives raw callback data.
        const sanitizedMessage = redactSecretLikeMaterial(message);
        instance.consoleLogs.push({
            timestamp: Date.now(),
            level: mappedLevel,
            message: sanitizedMessage,
        });
        if (instance.consoleLogs.length > MAX_CONSOLE_LOG_ENTRIES) {
            instance.consoleLogs.splice(0, instance.consoleLogs.length - MAX_CONSOLE_LOG_ENTRIES);
        }
        if (level >= 2) {
            mainLog.warn(`[browser-pane] console id=${instance.id} level=${level}: ${sanitizedMessage}`);
        }
    });
    pageWc.on('will-navigate', (event, url) => {
        if (url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
            event.preventDefault();
            void browserPaneManagerNavigationRules.handleDeepLinkUrl(transportOwner, url);
            return;
        }
        if (url === 'about:blank' || browserPaneManagerNavigationRules.isBrowserEmptyStateUrl(transportOwner, url)) {
            return;
        }
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                mainLog.warn(`[browser-pane] will-navigate denied id=${instance.id} reason=unsupported_protocol protocol=${parsed.protocol} url=${url}`);
                event.preventDefault();
            }
        }
        catch {
            mainLog.warn(`[browser-pane] will-navigate denied id=${instance.id} reason=invalid_url url=${url}`);
            event.preventDefault();
        }
    });
    pageWc.on('did-create-window', (popupWindow, details) => {
        const popupUrl = details?.url || popupWindow?.webContents?.getURL?.() || 'about:blank';
        transportOwner["registerPopupWindow"](instance, popupWindow, popupUrl);
    });
    pageWc.setWindowOpenHandler((details) => {
        mainLog.info(`[browser-pane] window-open requested id=${instance.id} url=${details.url} disposition=${details.disposition ?? 'unknown'} frameName=${details.frameName || 'none'}`);
        if (details.url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
            void browserPaneManagerNavigationRules.handleDeepLinkUrl(transportOwner, details.url);
            return { action: 'deny' };
        }
        let parsed: URL;
        try {
            parsed = new URL(details.url);
        }
        catch {
            mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=invalid_url url=${details.url}`);
            return { action: 'deny' };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=unsupported_protocol protocol=${parsed.protocol} url=${details.url}`);
            return { action: 'deny' };
        }
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                width: 520,
                height: 720,
                minWidth: 420,
                minHeight: 520,
                show: true,
                autoHideMenuBar: true,
                parent: instance.window,
                modal: false,
                webPreferences: {
                    partition: SESSION_PARTITION,
                    session: pageWc.session,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                },
            },
        };
    });
    pageWc.on('focus', () => {
        transportOwner["interactedCallback"]?.(instance.id);
    });
    instance.window.on('focus', () => {
        transportOwner["interactedCallback"]?.(instance.id);
    });
    instance.window.on('show', () => {
        instance.isVisible = true;
        transportOwner["emitStateChange"](instance);
        transportOwner["reapplyAgentControlVisual"](instance);
        browserPaneManagerToolbarState.pushToolbarState(transportOwner, instance);
        transportOwner["updateNativeOverlayState"](instance);
        if (!instance.themeColor) {
            void transportOwner["extractThemeColor"](instance);
        }
    });
    instance.window.on('hide', () => {
        instance.isVisible = false;
        transportOwner["emitStateChange"](instance);
        transportOwner["updateNativeOverlayState"](instance);
    });
    instance.window.on('closed', () => {
        transportOwner["finalizeDestroyedInstance"](instance, 'closed');
    });
}
