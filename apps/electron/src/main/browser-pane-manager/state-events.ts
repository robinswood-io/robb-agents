import { type BrowserInstanceInfo } from "../../shared/types";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserInstance } from './shared.ts';

export function toInfo(transportOwner: BrowserPaneManager, instance: BrowserInstance): BrowserInstanceInfo {
    return {
        id: instance.id,
        url: instance.currentUrl,
        title: instance.title,
        favicon: instance.favicon,
        isLoading: instance.isLoading,
        canGoBack: instance.canGoBack,
        canGoForward: instance.canGoForward,
        boundSessionId: instance.boundSessionId,
        ownerType: instance.ownerType,
        ownerSessionId: instance.ownerSessionId,
        isVisible: instance.isVisible,
        agentControlActive: !!instance.agentControl?.active,
        themeColor: instance.themeColor,
        workspaceId: instance.workspaceId,
    };
}

export function emitStateChange(transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    if (!transportOwner["instances"].has(instance.id)) {
        return;
    }
    transportOwner["stateChangeCallback"]?.(transportOwner["toInfo"](instance));
}
