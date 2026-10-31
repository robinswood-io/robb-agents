import type { BrowserMutationUrlPolicy } from "@craft-agent/server-core/handlers";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserInstance } from './shared.ts';
import * as browserPaneManagerNavigationRules from './navigation-rules.ts';

export async function runSerializedBrowserOperation<T>(transportOwner: BrowserPaneManager, id: string, operation: () => Promise<T> | T): Promise<T> {
    const expectedInstance = transportOwner["requireAliveInstance"](id);
    const expectedOwnerSessionId = expectedInstance.ownerSessionId;
    const expectedBoundSessionId = expectedInstance.boundSessionId;
    const previous = transportOwner["serializedOperationTails"].get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => { }).then(() => gate);
    transportOwner["serializedOperationTails"].set(id, tail);
    await previous.catch(() => { });
    try {
        if (transportOwner["instances"].get(id) !== expectedInstance
            || expectedInstance.window.isDestroyed()
            || expectedInstance.ownerSessionId !== expectedOwnerSessionId
            || expectedInstance.boundSessionId !== expectedBoundSessionId) {
            throw new Error(`Browser instance changed before serialized operation: ${id}`);
        }
        return await operation();
    }
    finally {
        release();
        if (transportOwner["serializedOperationTails"].get(id) === tail) {
            transportOwner["serializedOperationTails"].delete(id);
        }
    }
}

export function assertMutationUrlAllowed(transportOwner: BrowserPaneManager, instance: BrowserInstance, policy?: BrowserMutationUrlPolicy): void {
    if (browserPaneManagerNavigationRules.mutationUrlAllowed(transportOwner, instance, policy))
        return;
    throw new Error('Validation failed: browser mutations on Gmail are disabled for this contextual reply. '
        + 'Use only gmail_reply_preflight + gmail_reply_bound or '
        + 'gmail_reply_all_preflight + gmail_reply_all with the signed closed payload.');
}
