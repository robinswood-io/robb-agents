import type { BrowserMutationUrlPolicy } from "@craft-agent/server-core/handlers";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { DEFAULT_WAIT_TIMEOUT_MS } from './shared.ts';
import type { BrowserPaneClickElementOptionsPayload } from './protocol.ts';

export async function clickAtCoordinates(transportOwner: BrowserPaneManager, id: string, x: number, y: number, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.clickAtCoordinatesAtCurrentUrl(id, x, y, mutationPolicy));
}

export async function clickAtCoordinatesAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, x: number, y: number, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    try {
        transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
        await instance.cdp.clickAtCoordinates(x, y);
        instance.lastAction = {
            tool: 'browser_click_at',
            status: 'succeeded',
            timestamp: Date.now(),
        };
    }
    catch (error) {
        instance.lastAction = {
            tool: 'browser_click_at',
            status: 'failed',
            timestamp: Date.now(),
        };
        throw error;
    }
}

export async function drag(transportOwner: BrowserPaneManager, id: string, x1: number, y1: number, x2: number, y2: number, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.dragAtCurrentUrl(id, x1, y1, x2, y2, mutationPolicy));
}

export async function dragAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, x1: number, y1: number, x2: number, y2: number, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    try {
        transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
        await instance.cdp.drag(x1, y1, x2, y2);
        instance.lastAction = {
            tool: 'browser_drag',
            status: 'succeeded',
            timestamp: Date.now(),
        };
    }
    catch (error) {
        instance.lastAction = {
            tool: 'browser_drag',
            status: 'failed',
            timestamp: Date.now(),
        };
        throw error;
    }
}

export async function clickElement(transportOwner: BrowserPaneManager, id: string, ref: string, options?: BrowserPaneClickElementOptionsPayload, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.clickElementAtCurrentUrl(id, ref, options, mutationPolicy));
}

export async function clickElementAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, ref: string, options?: BrowserPaneClickElementOptionsPayload, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    const waitFor = options?.waitFor ?? 'none';
    let cleanupNavigationWait: (() => void) | undefined;
    let navigationWait: Promise<void> | undefined;
    if (waitFor === 'navigation') {
        const timeoutMs = Math.max(100, options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
        navigationWait = new Promise<void>((resolve, reject) => {
            const onMainFrameNavigate = () => {
                cleanup();
                resolve();
            };
            const onInPageNavigate = (_event: unknown, _url: string, isMainFrame: boolean) => {
                if (isMainFrame === false)
                    return;
                cleanup();
                resolve();
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Click navigation wait timed out after ${timeoutMs}ms (no navigation event observed). `
                    + `Tip: retry with "click ${ref}" (no navigation wait), then use "wait url <pattern>" or "wait network-idle".`));
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                instance.pageView.webContents.removeListener('did-navigate', onMainFrameNavigate);
                instance.pageView.webContents.removeListener('did-navigate-in-page', onInPageNavigate);
            };
            cleanupNavigationWait = cleanup;
            instance.pageView.webContents.once('did-navigate', onMainFrameNavigate);
            // A sub-frame in-page event must not release the serialized operation
            // before the top-level navigation commits. Keep listening until a
            // main-frame event arrives, then remove both listeners in cleanup.
            instance.pageView.webContents.on('did-navigate-in-page', onInPageNavigate);
        });
    }
    try {
        transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
        const clickPromise = instance.cdp.clickElement(ref);
        const geometry = navigationWait
            ? (await Promise.all([clickPromise, navigationWait]))[0]
            : await clickPromise;
        instance.lastAction = {
            tool: 'browser_click',
            ref,
            status: 'succeeded',
            geometry,
            timestamp: Date.now(),
        };
        if (waitFor === 'network-idle') {
            await transportOwner["waitFor"](id, { kind: 'network-idle', ...(options?.timeoutMs !== undefined ? { timeoutMs: options?.timeoutMs } : {}) });
        }
    }
    catch (error) {
        instance.lastAction = {
            tool: 'browser_click',
            ref,
            status: 'failed',
            timestamp: Date.now(),
        };
        throw error;
    }
    finally {
        cleanupNavigationWait?.();
    }
}

export async function scroll(transportOwner: BrowserPaneManager, id: string, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    await instance.pageView.webContents.executeJavaScript(`window.scrollBy(${deltaX}, ${deltaY})`);
}
