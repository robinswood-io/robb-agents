import { BrowserWindow, nativeTheme, Menu, app } from "electron";
import { windowLog } from "../logger";
import { join } from "path";
import { existsSync } from "fs";
import { RPC_CHANNELS, type WindowCloseRequestSource } from "../../shared/types";
import type { WindowManager } from '../window-manager.ts';
import { VITE_DEV_SERVER_URL, getWindowsBackgroundMaterial } from './shared.ts';
import type { CreateWindowOptions } from './shared.ts';

export function createWindow(transportOwner: WindowManager, moduleDirectory: string, options: CreateWindowOptions): BrowserWindow {
    const { workspaceId, focused = false, initialDeepLink, restoreUrl } = options;
    // Load platform-specific app icon
    // Packaged assets copied by electron-builder live outside app.asar under
    // Resources/app/resources. In dev, resources remain next to dist/.
    const getIconPath = () => {
        const iconName = process.platform === 'darwin' ? 'robinswood-icon.icns'
            : process.platform === 'win32' ? 'robinswood-icon.ico'
                : 'robinswood-icon.png';
        return [
            join(process.resourcesPath, 'app', 'resources', iconName),
            join(moduleDirectory, 'resources', iconName),
            join(moduleDirectory, '../resources', iconName),
        ].find(p => existsSync(p)) ?? join(moduleDirectory, '../resources', iconName);
    };
    const iconPath = getIconPath();
    const iconExists = existsSync(iconPath);
    if (!iconExists) {
        windowLog.warn('App icon not found at:', iconPath);
    }
    // Use smaller window size for focused mode (single session view)
    const windowWidth = focused ? 900 : 1400;
    const windowHeight = focused ? 700 : 900;
    // Platform-specific window options
    const isMac = process.platform === 'darwin';
    const isWindows = process.platform === 'win32';
    const windowsBackgroundMaterial = getWindowsBackgroundMaterial();
    const window = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        minWidth: 800,
        minHeight: 600,
        show: false, // Don't show until ready-to-show event (faster perceived startup)
        title: '',
        icon: iconExists ? iconPath : undefined,
        // macOS-specific: hidden title bar with inset traffic lights
        ...(isMac && {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 18, y: 16 },
            vibrancy: 'under-window',
            visualEffectState: 'active',
        }),
        // Windows: use native frame with Mica/Acrylic transparency (Windows 10/11)
        ...(isWindows && {
            frame: true, // Keep native frame for better UX
            autoHideMenuBar: true, // Menu is null on Windows, this is just for safety
            // Note: Don't use transparent:true with backgroundMaterial - it hides the window frame
            ...(windowsBackgroundMaterial && {
                backgroundMaterial: windowsBackgroundMaterial,
            }),
        }),
        // Linux: use native frame
        ...(!isMac && !isWindows && {
            frame: true,
            autoHideMenuBar: true,
        }),
        webPreferences: {
            preload: join(moduleDirectory, 'bootstrap-preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webviewTag: false // Browser integration uses WebContentsView, not <webview>
        }
    });
    // Show window when first paint is ready (faster perceived startup)
    window.once('ready-to-show', () => {
        window.show();
    });
    // Open external links in default browser, but never hand known-dangerous
    // schemes directly to shell.openExternal. Markdown normal-clicks go through
    // OPEN_URL; middle-clicks/window.open/top-navigation land here.
    window.webContents.setWindowOpenHandler((details) => {
        transportOwner["openExternalFromRenderer"](details.url, 'window-open', window);
        return { action: 'deny' };
    });
    // Handle external navigation attempts from renderer WebContents
    window.webContents.on('will-navigate', (event, url) => {
        // Allow only the actual app shell (file:// in prod, Vite dev server in dev).
        // Any other navigation is treated as an external URL and goes through the
        // same URL-safety classifier used by OPEN_URL.
        if (transportOwner["isRendererAppUrl"](url))
            return;
        event.preventDefault();
        transportOwner["openExternalFromRenderer"](url, 'will-navigate', window);
    });
    // Enable right-click context menu in development
    if (!app.isPackaged) {
        window.webContents.on('context-menu', (_event, params) => {
            Menu.buildFromTemplate([
                { label: 'Inspect Element', click: () => window.webContents.inspectElement(params.x, params.y) },
                { type: 'separator' },
                { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
                { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
                { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
            ]).popup();
        });
    }
    // The renderer's index.html ships with `<title>Robb Agents</title>`, so
    // without this Electron auto-syncs every window's title back to that on
    // load — clobbering the workspace-name policy applied below. Suppress the
    // default sync so setTitle() calls from refreshWindowTitles() stick.
    window.on('page-title-updated', (event) => {
        event.preventDefault();
    });
    // Store the window mapping BEFORE loadURL — bootstrap preload uses
    // __get-workspace-id (via sendSync) which reads this map during eval.
    const webContentsId = window.webContents.id;
    transportOwner["windows"].set(webContentsId, { window, workspaceId });
    // Apply window-title policy now that the map size reflects this window —
    // covers both the new window and any existing windows that should switch
    // from app name → workspace name as the count crosses 1 → 2.
    transportOwner["refreshWindowTitles"]();
    // Track focused mode state for persistence
    if (focused) {
        transportOwner["focusedModeWindows"].add(webContentsId);
    }
    // Load the renderer - use restoreUrl if provided, otherwise build from options
    if (restoreUrl) {
        // Restore from saved URL - need to adapt for dev vs prod
        if (VITE_DEV_SERVER_URL) {
            // In dev mode, replace the base URL but keep the path and query
            try {
                const savedUrl = new URL(restoreUrl);
                const devUrl = new URL(VITE_DEV_SERVER_URL);
                // Preserve pathname and search from saved URL, use dev server host
                devUrl.pathname = savedUrl.pathname;
                devUrl.search = savedUrl.search;
                window.loadURL(devUrl.toString());
            }
            catch {
                // Fallback if URL parsing fails
                windowLog.warn('Failed to parse restoreUrl, using default:', restoreUrl);
                const params = new URLSearchParams({ workspaceId, ...(focused && { focused: 'true' }) }).toString();
                window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`);
            }
        }
        else {
            // In prod, always extract query params and load from current __dirname.
            // Never load file:// URLs directly — the path may be stale (e.g. Linux AppImage
            // mounts to a different /tmp dir on each launch). See #13.
            try {
                const savedUrl = new URL(restoreUrl);
                const query: Record<string, string> = {};
                savedUrl.searchParams.forEach((value, key) => { query[key] = value; });
                window.loadFile(join(moduleDirectory, 'renderer/index.html'), { query });
            }
            catch {
                window.loadFile(join(moduleDirectory, 'renderer/index.html'), { query: { workspaceId } });
            }
        }
    }
    else {
        // Build URL from options
        const query: Record<string, string> = { workspaceId };
        if (focused) {
            query.focused = 'true'; // Open in focused mode (no sidebars)
        }
        if (VITE_DEV_SERVER_URL) {
            const params = new URLSearchParams(query).toString();
            window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`);
        }
        else {
            window.loadFile(join(moduleDirectory, 'renderer/index.html'), { query });
        }
    }
    // Fallback: if the renderer fails to load (e.g. stale path, disk error),
    // recover gracefully by loading the default state instead of showing a white screen. See #13.
    // In dev mode, retry the Vite dev server (it may not be ready yet) instead of falling back
    // to file:// which doesn't exist during development.
    let failLoadRetries = 0;
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        windowLog.warn('Failed to load renderer:', errorCode, errorDescription);
        if (VITE_DEV_SERVER_URL && failLoadRetries < 5) {
            failLoadRetries++;
            windowLog.info(`Retrying Vite dev server (attempt ${failLoadRetries}/5)...`);
            setTimeout(() => {
                const params = new URLSearchParams({ workspaceId }).toString();
                window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`);
            }, 1000);
        }
        else {
            window.loadFile(join(moduleDirectory, 'renderer/index.html'), { query: { workspaceId } });
        }
    });
    // If an initial deep link was provided, navigate to it after the window is ready
    if (initialDeepLink) {
        window.once('ready-to-show', () => {
            // Import parseDeepLink dynamically to avoid circular dependency
            import("../deep-link").then(({ parseDeepLink }) => {
                const target = parseDeepLink(initialDeepLink);
                if (target && (target.view || target.action)) {
                    // Wait a bit for React to mount and register IPC listeners
                    setTimeout(() => {
                        transportOwner["pushToWindow"](window, RPC_CHANNELS.deeplink.NAVIGATE, {
                            view: target.view,
                            action: target.action,
                            actionParams: target.actionParams,
                        });
                    }, 100);
                }
            });
        });
    }
    // Listen for system theme changes and notify this window's renderer
    const themeHandler = () => {
        transportOwner["pushToWindow"](window, RPC_CHANNELS.theme.SYSTEM_CHANGED, nativeTheme.shouldUseDarkColors);
    };
    nativeTheme.on('updated', themeHandler);
    // Handle focus/blur to broadcast window focus state
    window.on('focus', () => {
        transportOwner["pushToWindow"](window, RPC_CHANNELS.window.FOCUS_STATE, true);
    });
    window.on('blur', () => {
        transportOwner["pushToWindow"](window, RPC_CHANNELS.window.FOCUS_STATE, false);
    });
    // Detect Cmd/Ctrl+W before close events so renderer can distinguish close source.
    // Intent is short-lived to avoid stale classification.
    window.webContents.on('before-input-event', (_event, input) => {
        if (!input || input.type !== 'keyDown')
            return;
        const key = input.key?.toLowerCase?.();
        if (key !== 'w')
            return;
        const isCloseShortcut = process.platform === 'darwin'
            ? !!input.meta
            : !!input.control;
        if (!isCloseShortcut)
            return;
        const wcId = window.webContents.id;
        transportOwner["keyboardCloseIntents"].add(wcId);
        const existingTimeout = transportOwner["keyboardCloseIntentTimeouts"].get(wcId);
        if (existingTimeout)
            clearTimeout(existingTimeout);
        transportOwner["keyboardCloseIntentTimeouts"].set(wcId, setTimeout(() => {
            transportOwner["keyboardCloseIntentTimeouts"].delete(wcId);
            transportOwner["keyboardCloseIntents"].delete(wcId);
        }, 500));
    });
    // Handle window close request (traffic-light button, menu close, Cmd/Ctrl+W)
    // and send source metadata so renderer can decide layered dismiss vs direct close.
    window.on('close', (event) => {
        // During app quit, bypass layered close behavior and allow native close flow.
        // This preserves expected Cmd+Q semantics (quit app instead of closing overlays/panels first).
        if (transportOwner["isAppQuitting"]) {
            return;
        }
        // Check if renderer is ready (mainFrame exists) - if not, allow close directly
        if (!window.webContents.isDestroyed() && window.webContents.mainFrame) {
            event.preventDefault();
            const wcId = window.webContents.id;
            let source: WindowCloseRequestSource = 'window-button';
            if (transportOwner["keyboardCloseIntents"].has(wcId)) {
                source = 'keyboard-shortcut';
                transportOwner["keyboardCloseIntents"].delete(wcId);
                const keyboardIntentTimeout = transportOwner["keyboardCloseIntentTimeouts"].get(wcId);
                if (keyboardIntentTimeout) {
                    clearTimeout(keyboardIntentTimeout);
                    transportOwner["keyboardCloseIntentTimeouts"].delete(wcId);
                }
            }
            // Send close request to renderer - it will either close a modal/panel or confirm close.
            transportOwner["pushToWindow"](window, RPC_CHANNELS.window.CLOSE_REQUESTED, { source });
            // Fallback timeout: if IPC fails (e.g., on Hyprland/Wayland), force close after 3s.
            // Reset timeout on each attempt so active users closing modals aren't interrupted.
            const existingTimeout = transportOwner["pendingCloseTimeouts"].get(wcId);
            if (existingTimeout)
                clearTimeout(existingTimeout);
            transportOwner["pendingCloseTimeouts"].set(wcId, setTimeout(() => {
                transportOwner["pendingCloseTimeouts"].delete(wcId);
                if (!window.isDestroyed())
                    window.destroy();
            }, 3000));
        }
        // If renderer not ready, allow default close behavior
    });
    // Handle window closed - clean up theme listener and internal state
    window.on('closed', () => {
        // Clean up any pending close timeout to prevent memory leaks
        const timeout = transportOwner["pendingCloseTimeouts"].get(webContentsId);
        if (timeout) {
            clearTimeout(timeout);
            transportOwner["pendingCloseTimeouts"].delete(webContentsId);
        }
        // Clean up short-lived keyboard-close intent tracking.
        const keyboardIntentTimeout = transportOwner["keyboardCloseIntentTimeouts"].get(webContentsId);
        if (keyboardIntentTimeout) {
            clearTimeout(keyboardIntentTimeout);
            transportOwner["keyboardCloseIntentTimeouts"].delete(webContentsId);
        }
        transportOwner["keyboardCloseIntents"].delete(webContentsId);
        nativeTheme.removeListener('updated', themeHandler);
        transportOwner["windows"].delete(webContentsId);
        transportOwner["focusedModeWindows"].delete(webContentsId);
        // Re-apply window-title policy — surviving windows revert from workspace
        // name back to app name when the count drops from 2 → 1.
        transportOwner["refreshWindowTitles"]();
        windowLog.info(`Window closed for workspace ${workspaceId}`);
    });
    windowLog.info(`Created window for workspace ${workspaceId} (focused: ${focused})`);
    return window;
}
