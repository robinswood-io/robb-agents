import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { TOOLBAR_HEIGHT, TOOLBAR_CHANNELS } from './shared.ts';
import type { BrowserInstance } from './shared.ts';
import * as browserPaneManagerWindowState from './window-state.ts';

export function layoutToolbarView(transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    const [width] = instance.window.getContentSize();
    if (width === undefined) throw new Error('Browser window content width unavailable');
    const toolbarHeight = browserPaneManagerWindowState.getToolbarEffectiveHeight(transportOwner, instance);
    instance.toolbarView.setBounds({ x: 0, y: 0, width, height: toolbarHeight });
}

export function bringToolbarToFront(transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    if (!browserPaneManagerWindowState.isBrowserWindowAlive(transportOwner, instance.window))
        return;
    // View.addChildView reorders an existing child to the top of the z-stack.
    try {
        instance.window.contentView.addChildView(instance.toolbarView);
    }
    catch {
        // Native BrowserWindow teardown can invalidate the content view between
        // the liveness check and the reorder operation.
    }
}

export function layoutPageView(transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    const [width, height] = instance.window.getContentSize();
    if (width === undefined || height === undefined) throw new Error('Browser window content size unavailable');
    instance.pageView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(100, height - TOOLBAR_HEIGHT) });
    transportOwner["updateNativeOverlayState"](instance);
}

export function layoutAllViews(transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    transportOwner.layoutToolbarView(instance);
    transportOwner.layoutPageView(instance);
    transportOwner.bringToolbarToFront(instance);
}

export function forceCloseToolbarMenu(transportOwner: BrowserPaneManager, instance: BrowserInstance, reason: string): void {
    if (!instance.toolbarMenuOpen && instance.toolbarMenuHeight === 0 && !instance.toolbarMenuOverlayActive) {
        return;
    }
    instance.toolbarMenuOpen = false;
    instance.toolbarMenuHeight = 0;
    instance.toolbarMenuOverlayActive = false;
    transportOwner["layoutAllViews"](instance);
    if (!instance.window.isDestroyed() && !instance.toolbarView.webContents.isDestroyed()) {
        instance.toolbarView.webContents.send(TOOLBAR_CHANNELS.FORCE_CLOSE_MENU, { reason });
    }
}
