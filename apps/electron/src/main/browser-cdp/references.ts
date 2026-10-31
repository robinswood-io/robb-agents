import { mainLog } from "../logger";
import type { BrowserCDP } from '../browser-cdp.ts';
import { MAX_REF_DETAIL_HISTORY } from './shared.ts';
import type { ResolvedElementRef } from './shared.ts';

export function allocateRef(transportOwner: BrowserCDP, backendDOMNodeId?: number): string {
    if (backendDOMNodeId !== undefined) {
        const existing = transportOwner.backendNodeRefMap.get(backendDOMNodeId);
        if (existing) {
            return existing;
        }
    }
    transportOwner.nextRefCounter += 1;
    const ref = `@e${transportOwner.nextRefCounter}`;
    if (backendDOMNodeId !== undefined) {
        transportOwner.backendNodeRefMap.set(backendDOMNodeId, ref);
    }
    return ref;
}

export function trimRefDetailHistory(transportOwner: BrowserCDP): void {
    while (transportOwner["refDetails"].size > MAX_REF_DETAIL_HISTORY) {
        const oldestRef = transportOwner["refDetails"].keys().next().value;
        if (typeof oldestRef !== 'string')
            break;
        transportOwner["refDetails"].delete(oldestRef);
    }
}

export async function recoverRef(transportOwner: BrowserCDP, ref: string): Promise<string> {
    const previous = transportOwner["refDetails"].get(ref);
    if (!previous) {
        throw new Error(`Element ${ref} not found. Run browser_snapshot first to get current element refs.`);
    }
    if (previous.pageUrl !== transportOwner["webContents"].getURL()) {
        throw new Error(`Element ${ref} belongs to a previous page. `
            + 'Run browser_snapshot to inspect the current page state.');
    }
    const snapshot = await transportOwner["getAccessibilitySnapshot"]();
    const semanticMatches = snapshot.nodes.filter((node) => (node.role === previous.role
        && node.name === previous.name
        && !node.disabled));
    const valueMatches = previous.value === undefined
        ? []
        : semanticMatches.filter((node) => node.value === previous.value);
    const candidates = valueMatches.length > 0 ? valueMatches : semanticMatches;
    if (candidates.length !== 1) {
        const detail = candidates.length === 0
            ? 'no semantic match remains'
            : `${candidates.length} semantic matches are ambiguous`;
        throw new Error(`Element ${ref} became stale and could not be recovered (${detail}). `
            + 'Run browser_snapshot to inspect the current page state.');
    }
    const recoveredRef = candidates[0]!.ref;
    mainLog.info(`[browser-cdp] recovered stale ref ${ref} -> ${recoveredRef} `
        + `role=${previous.role} name=${JSON.stringify(previous.name)}`);
    return recoveredRef;
}

export async function resolveElementRef(transportOwner: BrowserCDP, ref: string): Promise<ResolvedElementRef> {
    let resolvedRef = ref;
    let backendNodeId = transportOwner["refMap"].get(resolvedRef);
    if (!backendNodeId) {
        resolvedRef = await transportOwner.recoverRef(ref);
        backendNodeId = transportOwner["refMap"].get(resolvedRef);
    }
    if (!backendNodeId) {
        throw new Error(`Element ${ref} not found. Run browser_snapshot first to get current element refs.`);
    }
    try {
        const { object } = await transportOwner["send"]('DOM.resolveNode', { backendNodeId });
        return { ref: resolvedRef, backendNodeId, objectId: object.objectId };
    }
    catch (error) {
        const recoveredRef = await transportOwner.recoverRef(ref);
        const recoveredBackendNodeId = transportOwner["refMap"].get(recoveredRef);
        if (!recoveredBackendNodeId)
            throw error;
        const { object } = await transportOwner["send"]('DOM.resolveNode', { backendNodeId: recoveredBackendNodeId });
        return {
            ref: recoveredRef,
            backendNodeId: recoveredBackendNodeId,
            objectId: object.objectId,
        };
    }
}
