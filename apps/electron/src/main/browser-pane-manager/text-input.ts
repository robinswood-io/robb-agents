import { existsSync } from "fs";
import { validateFilePath, getWorkspaceAllowedDirs } from "@craft-agent/server-core/handlers";
import { type ElementGeometry } from "../browser-cdp";
import { isBrowserPanePermissionAllowed } from "../browser-pane-permissions";
import type { BrowserMutationUrlPolicy } from "@craft-agent/server-core/handlers";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserKeyArgs } from './shared.ts';
import * as browserPaneManagerNavigationRules from './navigation-rules.ts';

export async function typeText(transportOwner: BrowserPaneManager, id: string, text: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.typeTextAtCurrentUrl(id, text, mutationPolicy));
}

export async function typeTextAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, text: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    try {
        transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
        await instance.cdp.typeText(text);
        instance.lastAction = {
            tool: 'browser_type',
            status: 'succeeded',
            timestamp: Date.now(),
        };
    }
    catch (error) {
        instance.lastAction = {
            tool: 'browser_type',
            status: 'failed',
            timestamp: Date.now(),
        };
        throw error;
    }
}

export async function setClipboard(transportOwner: BrowserPaneManager, id: string, text: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.setClipboardAtCurrentUrl(id, text, mutationPolicy));
}

export async function setClipboardAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, text: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    // Apply the host policy before invoking page-controlled JavaScript. A page
    // cannot authorize OS clipboard access by replacing navigator.clipboard.
    if (!isBrowserPanePermissionAllowed('clipboard-sanitized-write')) {
        throw new Error('Clipboard write is denied by browser policy. No paste shortcut was sent. Use a DOM field or explicit type-keys; do not repeat paste or change permissions.');
    }
    transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
    await instance.cdp.setClipboard(text);
}

export async function getClipboard(transportOwner: BrowserPaneManager, id: string): Promise<string> {
    const instance = transportOwner["requireAliveInstance"](id);
    if (!isBrowserPanePermissionAllowed('clipboard-read')) {
        throw new Error('Clipboard read is denied by browser policy; its contents are unknown, not empty.');
    }
    return instance.cdp.getClipboard();
}

export async function fillElement(transportOwner: BrowserPaneManager, id: string, ref: string, value: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.fillElementAtCurrentUrl(id, ref, value, mutationPolicy));
}

export async function fillElementAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, ref: string, value: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    try {
        transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
        const geometry = await instance.cdp.fillElement(ref, value);
        instance.lastAction = {
            tool: 'browser_fill',
            ref,
            status: 'succeeded',
            geometry,
            timestamp: Date.now(),
        };
    }
    catch (error) {
        instance.lastAction = {
            tool: 'browser_fill',
            ref,
            status: 'failed',
            timestamp: Date.now(),
        };
        throw error;
    }
}

export async function selectOption(transportOwner: BrowserPaneManager, id: string, ref: string, value: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.selectOptionAtCurrentUrl(id, ref, value, mutationPolicy));
}

export async function selectOptionAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, ref: string, value: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    try {
        transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
        const geometry = await instance.cdp.selectOption(ref, value);
        instance.lastAction = {
            tool: 'browser_select',
            ref,
            status: 'succeeded',
            geometry,
            timestamp: Date.now(),
        };
    }
    catch (error) {
        instance.lastAction = {
            tool: 'browser_select',
            ref,
            status: 'failed',
            timestamp: Date.now(),
        };
        throw error;
    }
}

export async function sendKey(transportOwner: BrowserPaneManager, id: string, args: BrowserKeyArgs, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.sendKeyAtCurrentUrl(id, args, mutationPolicy));
}

export async function sendKeyAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, args: BrowserKeyArgs, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
    const instance = transportOwner["requireAliveInstance"](id);
    if (args.text !== undefined) {
        if (args.key !== 'Unidentified' || (args.modifiers !== undefined && (!Array.isArray(args.modifiers) || args.modifiers.length !== 0)))
            throw new Error('Keyboard text cannot include shortcut modifiers');
        const owner = instance.ownerSessionId;
        const bound = instance.boundSessionId;
        const controlled = instance.agentControl;
        transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
        return instance.cdp.typeKeys(args.text, () => {
            const current = transportOwner["instances"].get(id);
            return current === instance && !instance.pageView.webContents.isDestroyed()
                && instance.ownerSessionId === owner && instance.boundSessionId === bound
                && instance.agentControl === controlled
                && browserPaneManagerNavigationRules.mutationUrlAllowed(transportOwner, instance, mutationPolicy);
        });
    }
    const key = args.key?.trim();
    if (!key)
        throw new Error('browser_key requires key');
    const modifiers = args.modifiers ?? [];
    transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
    instance.pageView.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: key,
        modifiers,
    });
    instance.pageView.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: key,
        modifiers,
    });
}

// validateUploadFilePath removed — uses shared validateFilePath from @craft-agent/server-core/handlers
export async function uploadFile(transportOwner: BrowserPaneManager, id: string, ref: string, filePaths: string[], mutationPolicy?: BrowserMutationUrlPolicy): Promise<ElementGeometry> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.uploadFileAtCurrentUrl(id, ref, filePaths, mutationPolicy));
}

export async function uploadFileAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, ref: string, filePaths: string[], mutationPolicy?: BrowserMutationUrlPolicy): Promise<ElementGeometry> {
    const instance = transportOwner["requireAliveInstance"](id);
    const safePaths: string[] = [];
    for (const p of filePaths) {
        const workspaceId = browserPaneManagerNavigationRules.resolveLaunchWorkspaceId(transportOwner);
        const safePath = await validateFilePath(p, getWorkspaceAllowedDirs(workspaceId));
        if (!existsSync(safePath))
            throw new Error(`File not found: ${p}`);
        safePaths.push(safePath);
    }
    transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
    return instance.cdp.setFileInputFiles(ref, safePaths);
}
