import { mainLog } from "../logger";
import { buildCanvasCaptureExpression, validateCanvasBitmapReceipt } from "../browser-canvas-capture";
import type { BrowserCDP } from '../browser-cdp.ts';
import { INTERACTIVE_ROLES, CONTENT_ROLES, MAX_AX_SNAPSHOT_NODES, FALLBACK_EXCLUDED_ROLES, normalizeAxText, incrementCount, summarizeTopCounts } from './shared.ts';
import type { AccessibilityNode, AccessibilitySnapshot } from './shared.ts';

export async function getAccessibilitySnapshot(transportOwner: BrowserCDP): Promise<AccessibilitySnapshot> {
    const tree = await transportOwner["send"]('Accessibility.getFullAXTree');
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const snapshotUrl = transportOwner["webContents"].getURL();
    transportOwner["refMap"].clear();
    const result: AccessibilityNode[] = [];
    const fallbackCandidates: Array<{
        backendDOMNodeId: number;
        role: string;
        name: string;
        value?: string;
        description?: string;
        focused?: boolean;
        checked?: boolean;
        disabled?: boolean;
    }> = [];
    const rawRoleCounts = new Map<string, number>();
    const droppedReasonCounts = new Map<string, number>();
    const seenBackendNodeIds = new Set<number>();
    const pushAccessNode = (entry: {
        backendDOMNodeId?: number;
        role: string;
        name: string;
        value?: string;
        description?: string;
        focused?: boolean;
        checked?: boolean;
        disabled?: boolean;
    }): boolean => {
        if (result.length >= MAX_AX_SNAPSHOT_NODES)
            return false;
        if (entry.backendDOMNodeId !== undefined) {
            if (seenBackendNodeIds.has(entry.backendDOMNodeId)) {
                return true;
            }
            seenBackendNodeIds.add(entry.backendDOMNodeId);
        }
        const ref = transportOwner["allocateRef"](entry.backendDOMNodeId);
        if (entry.backendDOMNodeId !== undefined) {
            transportOwner["refMap"].set(ref, entry.backendDOMNodeId);
        }
        transportOwner["refDetails"].set(ref, {
            role: entry.role,
            name: entry.name,
            pageUrl: snapshotUrl,
            value: entry.value,
            description: entry.description,
        });
        const accessNode: AccessibilityNode = {
            ref,
            role: entry.role,
            name: entry.name,
        };
        if (entry.value !== undefined)
            accessNode.value = entry.value;
        if (entry.description)
            accessNode.description = entry.description;
        if (entry.focused)
            accessNode.focused = true;
        if (entry.checked)
            accessNode.checked = true;
        if (entry.disabled)
            accessNode.disabled = true;
        result.push(accessNode);
        return true;
    };
    for (const node of nodes) {
        const role = normalizeAxText(node.role?.value).toLowerCase();
        const name = normalizeAxText(node.name?.value);
        const rawValue = node.value?.value;
        const hasValue = rawValue !== undefined && rawValue !== '';
        const value = hasValue ? String(rawValue) : undefined;
        const description = normalizeAxText(node.description?.value) || undefined;
        const backendDOMNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined;
        incrementCount(rawRoleCounts, role || '(empty)');
        let focused = false;
        let checked = false;
        let disabled = false;
        let focusable = false;
        const props = node.properties;
        if (props) {
            for (const prop of props) {
                if (prop.name === 'focused' && prop.value?.value === true)
                    focused = true;
                if (prop.name === 'checked' && prop.value?.value !== 'false')
                    checked = prop.value?.value === true || prop.value?.value === 'true';
                if (prop.name === 'disabled' && prop.value?.value === true)
                    disabled = true;
                if (prop.name === 'focusable' && prop.value?.value === true)
                    focusable = true;
            }
        }
        const isInteractive = INTERACTIVE_ROLES.has(role);
        const isContent = CONTENT_ROLES.has(role) && !!name;
        const hasPrimarySignal = isInteractive || isContent || hasValue;
        const isGenericWithoutName = (!role || role === 'generic' || role === 'none') && !name;
        if (!hasPrimarySignal) {
            incrementCount(droppedReasonCounts, 'no-primary-signal');
        }
        else if (isGenericWithoutName) {
            incrementCount(droppedReasonCounts, 'generic-without-name');
        }
        const shouldKeepPrimary = hasPrimarySignal && !isGenericWithoutName;
        if (shouldKeepPrimary) {
            pushAccessNode({
                backendDOMNodeId,
                role,
                name,
                value,
                description,
                focused,
                checked,
                disabled,
            });
            if (result.length >= MAX_AX_SNAPSHOT_NODES)
                break;
            continue;
        }
        const fallbackEligible = !!backendDOMNodeId
            && !FALLBACK_EXCLUDED_ROLES.has(role)
            && (!!name || hasValue || focusable || focused);
        if (fallbackEligible) {
            fallbackCandidates.push({
                backendDOMNodeId,
                role,
                name,
                value,
                description,
                focused,
                checked,
                disabled,
            });
        }
    }
    let fallbackKept = 0;
    if (result.length === 0 && fallbackCandidates.length > 0) {
        for (const candidate of fallbackCandidates) {
            const pushed = pushAccessNode(candidate);
            if (!pushed)
                break;
            fallbackKept++;
        }
        mainLog.info(`[browser-cdp] snapshot fallback engaged url=${snapshotUrl} raw=${nodes.length} kept=${result.length} fallbackKept=${fallbackKept} roles=[${summarizeTopCounts(rawRoleCounts)}] dropped=[${summarizeTopCounts(droppedReasonCounts)}]`);
    }
    transportOwner["trimRefDetailHistory"]();
    if (result.length === 0 && nodes.length > 0) {
        mainLog.warn(`[browser-cdp] snapshot produced zero nodes url=${snapshotUrl} raw=${nodes.length} roles=[${summarizeTopCounts(rawRoleCounts)}] dropped=[${summarizeTopCounts(droppedReasonCounts)}]`);
    }
    return {
        url: snapshotUrl,
        title: transportOwner["webContents"].getTitle(),
        nodes: result,
    };
}

export async function captureCanvasBitmap(transportOwner: BrowserCDP, selector: string, isCurrent: () => boolean) {
    const expression = buildCanvasCaptureExpression(selector);
    const url = transportOwner["webContents"].getURL();
    const check = () => {
        if (!isCurrent() || transportOwner["webContents"].getURL() !== url)
            throw new Error('Canvas capture target changed; no image was returned');
    };
    check();
    const before = await transportOwner["send"]('Page.getFrameTree');
    check();
    const frame = before?.frameTree?.frame;
    if (typeof frame?.id !== 'string' || typeof frame?.loaderId !== 'string')
        throw new Error('Canvas capture document identity unavailable');
    const world = await transportOwner["send"]('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'robb-canvas-capture', grantUniveralAccess: false });
    check();
    if (!Number.isInteger(world?.executionContextId))
        throw new Error('Canvas capture isolated context unavailable');
    const result = await transportOwner["send"]('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true, timeout: 2000 });
    check();
    if (result?.exceptionDetails)
        throw new Error('Canvas capture unavailable: selector, visibility, transform, clipping, origin or bitmap limit was not satisfied. No page screenshot was substituted.');
    const after = await transportOwner["send"]('Page.getFrameTree');
    check();
    if (after?.frameTree?.frame?.id !== frame.id || after?.frameTree?.frame?.loaderId !== frame.loaderId)
        throw new Error('Canvas capture document changed; no image was returned');
    return validateCanvasBitmapReceipt(result?.result?.value);
}
