

export interface AccessibilityNode {
    ref: string; // "@e1", "@e2", etc.
    role: string; // "button", "link", "textbox", etc.
    name: string; // Accessible name
    value?: string; // Current value (for inputs)
    description?: string; // Additional description
    focused?: boolean;
    checked?: boolean;
    disabled?: boolean;
}

export interface AccessibilitySnapshot {
    url: string;
    title: string;
    nodes: AccessibilityNode[];
}

export interface ElementBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ElementGeometry {
    ref: string;
    role?: string;
    name?: string;
    box: ElementBox;
    clickPoint: {
        x: number;
        y: number;
    };
}

export interface ViewportMetrics {
    width: number;
    height: number;
    dpr: number;
    scrollX: number;
    scrollY: number;
}

// Roles that are typically interactive or contain meaningful content
export const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
    'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'treeitem', 'row', 'cell', 'columnheader',
    'rowheader', 'gridcell',
]);

export const CONTENT_ROLES = new Set([
    'heading', 'img', 'table', 'list', 'listitem',
    'paragraph', 'blockquote', 'article', 'main',
    'navigation', 'complementary', 'contentinfo', 'banner',
    'form', 'region', 'alert', 'dialog', 'alertdialog',
    'status', 'progressbar', 'meter', 'timer',
]);

export const MAX_AX_SNAPSHOT_NODES = 500;

export const MAX_REF_DETAIL_HISTORY = 1500;

export const FALLBACK_EXCLUDED_ROLES = new Set(['none', 'generic', 'rootwebarea', 'webarea']);

export function normalizeAxText(value: unknown): string {
    return String(value ?? '').trim();
}

export function incrementCount(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

export function summarizeTopCounts(map: Map<string, number>, maxEntries = 8): string {
    return Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxEntries)
        .map(([key, count]) => `${key}:${count}`)
        .join(', ');
}

export const CDP_IDLE_DETACH_MS = 30000;

export interface ElementRefDetails {
    role: string;
    name: string;
    pageUrl: string;
    value?: string;
    description?: string;
}

export interface ResolvedElementRef {
    ref: string;
    backendNodeId: number;
    objectId: string;
}
