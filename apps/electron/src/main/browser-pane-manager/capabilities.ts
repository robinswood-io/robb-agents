import { type BrowserInstanceInfo } from "../../shared/types";
import { getAllowRemoteEvaluate } from "@craft-agent/shared/config";
import { CodedError } from "@craft-agent/shared/protocol";
import type { BrowserCapabilityRequest } from "@craft-agent/server-core/transport";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { POLICY_MUTATION_CAPABILITY_METHODS } from './shared.ts';
import type { BrowserScreenshotOptions, BrowserConsoleOptions, BrowserScreenshotRegionTarget, BrowserNetworkOptions, BrowserWaitArgs, BrowserKeyArgs, BrowserDownloadOptions } from './shared.ts';
import type { BrowserPaneParseOwnerKeyResult } from './protocol.ts';
import * as browserPaneManagerCapabilityValues from './capability-values.ts';

export function parseOwnerKey(transportOwner: BrowserPaneManager, value: string): BrowserPaneParseOwnerKeyResult | null {
    if (!browserPaneManagerCapabilityValues.isRemoteOwnerKey(transportOwner, value))
        return null;
    const rest = value.slice('remote:'.length);
    const colon = rest.indexOf(':');
    if (colon === -1)
        return null;
    return { workspaceId: rest.slice(0, colon), sessionId: rest.slice(colon + 1) };
}

/** Replace `remote:${ws}:${sid}` owner-keys with raw `sid` on outbound payloads. */
export function stripOwnerKeysInPlace<T extends Partial<BrowserInstanceInfo>>(transportOwner: BrowserPaneManager, info: T): T {
    if (browserPaneManagerCapabilityValues.isRemoteOwnerKey(transportOwner, info.boundSessionId)) {
        info.boundSessionId = transportOwner["parseOwnerKey"](info.boundSessionId)!.sessionId;
    }
    if (browserPaneManagerCapabilityValues.isRemoteOwnerKey(transportOwner, info.ownerSessionId)) {
        info.ownerSessionId = transportOwner["parseOwnerKey"](info.ownerSessionId)!.sessionId;
    }
    return info;
}

/** Session-scoped listInstances — never returns workspace-wide windows to a remote agent. */
export function listInstancesForOwner(transportOwner: BrowserPaneManager, ownerKey: string): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = [];
    for (const instance of transportOwner["instances"].values()) {
        if (instance.window.isDestroyed()) {
            transportOwner["cleanupDestroyedInstance"](instance, 'listInstancesForOwner');
            continue;
        }
        const owned = instance.boundSessionId === ownerKey || instance.ownerSessionId === ownerKey;
        if (!owned)
            continue;
        infos.push(transportOwner["stripOwnerKeysInPlace"](transportOwner["toInfo"](instance)));
    }
    return infos;
}

/** Main dispatcher. Strongly-typed `switch` over `IBrowserPaneManager` methods. */
export async function dispatchCapability(transportOwner: BrowserPaneManager, req: BrowserCapabilityRequest): Promise<unknown> {
    if (!req || (req.v !== 1 && req.v !== 2)) {
        throw new CodedError('HANDLER_ERROR', `Unsupported browser capability request shape (v=${(req as {
            v?: unknown;
        })?.v}).`);
    }
    if (req.v === 2 && (!POLICY_MUTATION_CAPABILITY_METHODS.has(req.method)
        || !req.mutationUrlPolicy || typeof req.mutationUrlPolicy !== 'object')) {
        throw new CodedError('HANDLER_ERROR', 'Browser capability v2 is reserved for a policy-bearing page mutation.');
    }
    const ownerKey = browserPaneManagerCapabilityValues.toOwnerKey(transportOwner, req.workspaceId, req.sessionId);
    const args = req.args ?? [];
    const mutationPolicy = req.v === 2 ? req.mutationUrlPolicy : undefined;
    switch (req.method) {
        // -- Session-scoped (no instanceId arg, takes a sessionId) ----------------
        case 'createForSession': {
            const [, options] = args as [
                string,
                {
                    show?: boolean;
                } | undefined
            ];
            return transportOwner["createForSession"](ownerKey, {
                show: options?.show ?? false,
                allowReuseManual: false,
                workspaceId: req.workspaceId,
            });
        }
        // Remote agents must NEVER reuse an existing manual / unbound window —
        // even one that was previously bound to a local session. The
        // workspaceId-aware reuse filter is best-effort (it can still match
        // legacy windows stamped with workspaceId=null), so we belt-and-brace
        // by disabling manual reuse on every remote lifecycle path. Each remote
        // session-id namespace gets a fresh window unless it already owns one.
        case 'getOrCreateForSession':
            return transportOwner["createForSession"](ownerKey, {
                show: false,
                allowReuseManual: false,
                workspaceId: req.workspaceId,
            });
        case 'focusBoundForSession': {
            const id = transportOwner["createForSession"](ownerKey, {
                show: true,
                allowReuseManual: false,
                workspaceId: req.workspaceId,
            });
            transportOwner["focus"](id);
            return id;
        }
        case 'destroyForSession':
            transportOwner["destroyForSession"](ownerKey);
            return undefined;
        case 'clearVisualsForSession':
            await transportOwner["clearVisualsForSession"](ownerKey);
            return undefined;
        case 'unbindAllForSession':
            transportOwner["unbindAllForSession"](ownerKey);
            return undefined;
        case 'setAgentControl': {
            const [, meta] = args as [
                string,
                {
                    displayName?: string;
                    intent?: string;
                }
            ];
            transportOwner["setAgentControl"](ownerKey, meta, { workspaceId: req.workspaceId });
            return undefined;
        }
        case 'clearAgentControl':
            transportOwner["clearAgentControl"](ownerKey);
            return undefined;
        // -- Mixed (instanceId + optional sessionId) ----------------------------
        case 'clearAgentControlForInstance': {
            const [instanceId, sessionId] = args as [
                string,
                string | undefined
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["clearAgentControlForInstance"](instanceId, sessionId !== undefined ? ownerKey : undefined);
        }
        // -- Instance-id only ----------------------------------------------------
        case 'getInstance': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            const live = transportOwner["getInstance"](instanceId);
            if (!live)
                return undefined;
            // `getInstance` returns the live BrowserInstance (which embeds non-
            // cloneable Electron native objects). Project to a plain snapshot
            // before crossing the IPC boundary.
            return transportOwner["stripOwnerKeysInPlace"](browserPaneManagerCapabilityValues.toSnapshot(transportOwner, live));
        }
        case 'listInstances':
            return transportOwner["listInstancesForOwner"](ownerKey);
        case 'bindSession': {
            const [instanceId] = args as [
                string,
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            transportOwner["bindSession"](instanceId, ownerKey, { workspaceId: req.workspaceId });
            return undefined;
        }
        case 'focus': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            transportOwner["focus"](instanceId);
            return undefined;
        }
        case 'hide': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            transportOwner["hide"](instanceId);
            return undefined;
        }
        case 'destroyInstance': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            transportOwner["destroyInstance"](instanceId);
            return undefined;
        }
        // -- Navigation ----------------------------------------------------------
        case 'navigate': {
            const [instanceId, url] = args as [
                string,
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["navigate"](instanceId, url);
        }
        case 'goBack': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["goBack"](instanceId);
        }
        case 'goForward': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["goForward"](instanceId);
        }
        // -- Interaction ---------------------------------------------------------
        case 'getAccessibilitySnapshot': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["getAccessibilitySnapshot"](instanceId);
        }
        case 'clickElement': {
            const [instanceId, ref, options] = args as [
                string,
                string,
                {
                    waitFor?: 'none' | 'navigation' | 'network-idle';
                    timeoutMs?: number;
                } | undefined
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["clickElement"](instanceId, ref, options, mutationPolicy);
        }
        case 'clickAtCoordinates': {
            const [instanceId, x, y] = args as [
                string,
                number,
                number
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["clickAtCoordinates"](instanceId, x, y, mutationPolicy);
        }
        case 'drag': {
            const [instanceId, x1, y1, x2, y2] = args as [
                string,
                number,
                number,
                number,
                number
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["drag"](instanceId, x1, y1, x2, y2, mutationPolicy);
        }
        case 'fillElement': {
            const [instanceId, ref, value] = args as [
                string,
                string,
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["fillElement"](instanceId, ref, value, mutationPolicy);
        }
        case 'typeText': {
            const [instanceId, text] = args as [
                string,
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["typeText"](instanceId, text, mutationPolicy);
        }
        case 'selectOption': {
            const [instanceId, ref, value] = args as [
                string,
                string,
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["selectOption"](instanceId, ref, value, mutationPolicy);
        }
        case 'sendKey': {
            const [instanceId, keyArgs] = args as [
                string,
                BrowserKeyArgs
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["sendKey"](instanceId, keyArgs, mutationPolicy);
        }
        case 'scroll': {
            const [instanceId, direction, amount] = args as [
                string,
                'up' | 'down' | 'left' | 'right',
                number | undefined
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["scroll"](instanceId, direction, amount);
        }
        case 'waitFor': {
            const [instanceId, waitArgs] = args as [
                string,
                BrowserWaitArgs
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["waitFor"](instanceId, waitArgs);
        }
        case 'evaluate': {
            const [instanceId, expression] = args as [
                string,
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            if (!getAllowRemoteEvaluate()) {
                throw new CodedError('BROWSER_REMOTE_EVALUATE_BLOCKED', 'JavaScript evaluation from remote agents is disabled in this client.');
            }
            return transportOwner["evaluate"](instanceId, expression, mutationPolicy);
        }
        // -- Clipboard -----------------------------------------------------------
        case 'setClipboard': {
            const [instanceId, text] = args as [
                string,
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["setClipboard"](instanceId, text, mutationPolicy);
        }
        case 'getClipboard': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["getClipboard"](instanceId);
        }
        // -- Capture / introspection --------------------------------------------
        case 'screenshot': {
            const [instanceId, options] = args as [
                string,
                BrowserScreenshotOptions | undefined
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            const result = await transportOwner["screenshot"](instanceId, options);
            return browserPaneManagerCapabilityValues.toScreenshotWire(transportOwner, result);
        }
        case 'screenshotRegion': {
            const [instanceId, target] = args as [
                string,
                BrowserScreenshotRegionTarget
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            const result = await transportOwner["screenshotRegion"](instanceId, target);
            return browserPaneManagerCapabilityValues.toScreenshotWire(transportOwner, result);
        }
        case 'getConsoleLogs': {
            const [instanceId, options] = args as [
                string,
                BrowserConsoleOptions | undefined
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["getConsoleLogs"](instanceId, options);
        }
        case 'getNetworkLogs': {
            const [instanceId, options] = args as [
                string,
                BrowserNetworkOptions | undefined
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["getNetworkLogs"](instanceId, options);
        }
        case 'windowResize': {
            const [instanceId, width, height] = args as [
                string,
                number,
                number
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["windowResize"](instanceId, width, height);
        }
        case 'getDownloads': {
            const [instanceId, options] = args as [
                string,
                BrowserDownloadOptions | undefined
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["getDownloads"](instanceId, options);
        }
        case 'uploadFile':
            throw new CodedError('BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED', 'File upload from a remote agent is not supported yet. Ask the user to attach the file to the session.');
        case 'detectSecurityChallenge': {
            const [instanceId] = args as [
                string
            ];
            browserPaneManagerCapabilityValues.requireOwnedInstance(transportOwner, instanceId, ownerKey);
            return transportOwner["detectSecurityChallenge"](instanceId);
        }
        default: {
            const method = (req as {
                method?: unknown;
            }).method;
            throw new CodedError('HANDLER_ERROR', `Unknown browser capability method: ${String(method)}`);
        }
    }
}
