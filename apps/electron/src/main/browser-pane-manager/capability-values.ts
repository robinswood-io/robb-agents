import { CodedError } from "@craft-agent/shared/protocol";
import type { BrowserInstanceSnapshot } from "@craft-agent/server-core/handlers";
import type { ScreenshotResultWire } from "@craft-agent/server-core/transport";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserInstance, BrowserScreenshotResult } from './shared.ts';

/** Owner-key namespacing: remote sessions can't collide with local sessions. */
export function toOwnerKey(_transportOwner: BrowserPaneManager, workspaceId: string, sessionId: string): string {
    return `remote:${workspaceId}:${sessionId}`;
}

export function isRemoteOwnerKey(_transportOwner: BrowserPaneManager, value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith('remote:');
}

/**
   * Throws `BROWSER_INSTANCE_NOT_OWNED` unless the instance belongs to `ownerKey`.
   * Called by every dispatcher branch that accepts an instanceId — including read-only ones.
   */
export function requireOwnedInstance(transportOwner: BrowserPaneManager, instanceId: string, ownerKey: string): void {
    const instance = transportOwner["instances"].get(instanceId);
    if (!instance || instance.window.isDestroyed()) {
        throw new CodedError('BROWSER_INSTANCE_NOT_OWNED', `Browser instance "${instanceId}" not found.`);
    }
    const owned = instance.boundSessionId === ownerKey || instance.ownerSessionId === ownerKey;
    if (!owned) {
        throw new CodedError('BROWSER_INSTANCE_NOT_OWNED', `Browser instance "${instanceId}" is not owned by this session.`);
    }
}

/**
   * Extract a plain {@link BrowserInstanceSnapshot} from a live `BrowserInstance`.
   *
   * `this.getInstance(id)` returns the full instance, which has non-cloneable
   * Electron native references (`window: BrowserWindow`, `pageView: WebContentsView`,
   * `toolbarView`, ...). When we ship the result back over the `__browser:invoke`
   * IPC channel, Electron's structured-clone serializer throws
   * "An object could not be cloned" — see the user-reported bug on the remote
   * bridge path. Always pass the live instance through this helper before
   * returning over IPC.
   */
export function toSnapshot(_transportOwner: BrowserPaneManager, instance: BrowserInstance): BrowserInstanceSnapshot {
    return {
        ownerType: instance.ownerType,
        ownerSessionId: instance.ownerSessionId,
        isVisible: instance.isVisible,
        title: instance.title,
        currentUrl: instance.currentUrl,
    };
}

export function toScreenshotWire(_transportOwner: BrowserPaneManager, result: BrowserScreenshotResult): ScreenshotResultWire {
    const buf = result.imageBuffer;
    return {
        imageFormat: result.imageFormat,
        imageBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
    };
}
