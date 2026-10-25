import type { AutomationSystem } from '../automation-system.ts';
import { log } from './shared.ts';

export function dispose(transportOwner: AutomationSystem): Promise<void> {
    if (transportOwner["disposePromise"])
        return transportOwner["disposePromise"];
    if (transportOwner["disposed"])
        return Promise.resolve();
    // Invalidate running/queued metadata work before the first await. This is
    // deliberately earlier than resource cleanup so a held event handler
    // cannot later commit or emit another transition during disposal.
    transportOwner["disposed"] = true;
    transportOwner["metadataLifecycleToken"] = {};
    transportOwner["sessionMetadataTokens"].clear();
    transportOwner["disposePromise"] = Promise.resolve().then(() => transportOwner["disposeResources"]());
    return transportOwner["disposePromise"];
}

export async function disposeResources(transportOwner: AutomationSystem): Promise<void> {
    log.debug(`[AutomationSystem] Disposing for workspace: ${transportOwner["options"].workspaceId}`);
    // Stop scheduler
    transportOwner["stopScheduler"]();
    // Dispose handlers
    transportOwner["promptHandler"]?.dispose();
    transportOwner["webhookHandler"]?.dispose();
    await transportOwner["eventLogHandler"]?.dispose();
    // Dispose event bus
    transportOwner["eventBus"].dispose();
    // Clear metadata
    transportOwner["lastKnownMetadata"].clear();
    transportOwner["sessionMetadataUpdateTails"].clear();
    log.debug(`[AutomationSystem] Disposed`);
}
