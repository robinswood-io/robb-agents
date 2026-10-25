import { mainLog } from "../logger";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { TOOLBAR_HEIGHT } from './shared.ts';
import type { BrowserPaneWindowResizeResult } from './protocol.ts';

export function focus(transportOwner: BrowserPaneManager, id: string): void {
    const instance = transportOwner["instances"].get(id);
    if (!instance)
        return;
    const win = instance.window;
    if (win.isDestroyed())
        return;
    // If toolbar hasn't painted yet, defer showing until markToolbarReady runs.
    // Token guard prevents stale deferred focus from showing after hide/destroy.
    if (!instance.toolbarReady) {
        if (instance.pendingShowOnReady)
            return;
        instance.pendingShowOnReady = true;
        const token = ++instance.pendingShowToken;
        mainLog.info(`[browser-pane] focus deferred until ready id=${instance.id} token=${token}`);
        return;
    }
    if (win.isMinimized())
        win.restore();
    win.show();
    win.focus();
    instance.isVisible = true;
    transportOwner["emitStateChange"](instance);
}

export function hide(transportOwner: BrowserPaneManager, id: string): void {
    const instance = transportOwner["instances"].get(id);
    if (!instance)
        return;
    // Re-entrancy guard: bail if a hide is already in progress. Prevents the
    // 'close' listener from re-entering hide() during teardown, which can crash
    // Chromium's compositor when the embedded WebContentsView is mid-load.
    if (instance.isHiding)
        return;
    const win = instance.window;
    if (win.isDestroyed())
        return;
    instance.isHiding = true;
    // Cancel any deferred show request queued before toolbar was ready.
    if (instance.pendingShowOnReady) {
        instance.pendingShowOnReady = false;
        instance.pendingShowToken += 1;
    }
    transportOwner["forceCloseToolbarMenu"](instance, 'window-hide');
    // Cancel an in-flight page load before hiding. Hiding the window while the
    // WebContentsView is still loading can trigger a Chromium compositor assertion
    // and kill the main process.
    if (instance.isLoading) {
        try {
            const pageWc = instance.pageView.webContents;
            if (!pageWc.isDestroyed())
                pageWc.stop();
        }
        catch (error) {
            mainLog.warn(`[browser-pane] failed to stop page load before hide id=${id}: ${(error as Error)?.message ?? error}`);
        }
    }
    win.hide();
    instance.isVisible = false;
    // Defer the state-change callback so native window teardown completes before
    // listeners (which may touch WebContentsView/Chromium internals) run.
    queueMicrotask(() => {
        instance.isHiding = false;
        transportOwner["emitStateChange"](instance);
    });
}

export function windowResize(transportOwner: BrowserPaneManager, id: string, width: number, height: number): BrowserPaneWindowResizeResult {
    const instance = transportOwner["requireAliveInstance"](id);
    const requestedViewportWidth = Math.max(320, Math.floor(width));
    const requestedViewportHeight = Math.max(240, Math.floor(height));
    instance.window.setContentSize(requestedViewportWidth, requestedViewportHeight + TOOLBAR_HEIGHT);
    transportOwner["layoutAllViews"](instance);
    // Return effective viewport dimensions after OS/window min-size constraints are applied.
    const [appliedContentWidth, appliedContentHeight] = instance.window.getContentSize();
    return {
        width: Math.max(0, Math.floor(appliedContentWidth)),
        height: Math.max(0, Math.floor(appliedContentHeight - TOOLBAR_HEIGHT)),
    };
}
