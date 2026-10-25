import { mainLog } from "../logger";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserInstance } from './shared.ts';

export function destroyAll(transportOwner: BrowserPaneManager): void {
    for (const id of [...transportOwner["instances"].keys()]) {
        transportOwner["destroyInstance"](id);
    }
}

export function finalizeDestroyedInstance(transportOwner: BrowserPaneManager, instance: BrowserInstance, source: 'destroy' | 'closed'): void {
    if (!transportOwner["instances"].has(instance.id)) {
        return;
    }
    const runCleanup = (label: string, action: () => void): void => {
        try {
            action();
        }
        catch (error) {
            mainLog.warn(`[browser-pane] finalize cleanup failed id=${instance.id} source=${source} step=${label} error=${error instanceof Error ? error.message : String(error)}`);
        }
    };
    transportOwner["destroyingIds"].delete(instance.id);
    runCleanup('closePopupsForParent', () => transportOwner["closePopupsForParent"](instance.id, 'parent_destroy'));
    runCleanup('applyAgentControlLock', () => transportOwner["applyAgentControlLock"](instance, false));
    runCleanup('updateNativeOverlayState', () => transportOwner["updateNativeOverlayState"](instance));
    runCleanup('cdp.detach', () => instance.cdp.detach());
    transportOwner["instances"].delete(instance.id);
    transportOwner["serializedOperationTails"].delete(instance.id);
    transportOwner["removedCallback"]?.(instance.id);
    mainLog.info(`[browser-pane] Destroyed instance: ${instance.id} (${source})`);
}
