import { parseCDPResponse } from './browser-cdp/protocol.ts';
/**
 * Browser CDP Helpers
 *
 * Uses Electron's webContents.debugger API (Chrome DevTools Protocol) for:
 * - Accessibility tree snapshots with ref-based element identification
 * - Element interaction (click, fill, select) via CDP commands
 *
 * This is the same approach used by Playwright/Stagehand — deterministic,
 * no fragile CSS selectors needed.
 */
import type { MouseInputEvent, WebContents } from "electron";
import type { CDPCommandResponses } from './browser-cdp/protocol.ts';
import type { AccessibilitySnapshot, ElementGeometry, ViewportMetrics, ElementRefDetails, ResolvedElementRef } from './browser-cdp/shared.ts';
import * as browserCdpConnection from './browser-cdp/connection.ts';
import * as browserCdpReferences from './browser-cdp/references.ts';
import * as browserCdpSnapshot from './browser-cdp/snapshot.ts';
import * as browserCdpGeometry from './browser-cdp/geometry.ts';
import * as browserCdpPointer from './browser-cdp/pointer.ts';
import * as browserCdpInput from './browser-cdp/input.ts';
export type { AccessibilityNode, AccessibilitySnapshot, ElementBox, ElementGeometry, ViewportMetrics } from './browser-cdp/shared.ts';

export type BrowserCDPWebContents = Pick<WebContents, 'getURL' | 'getTitle' | 'sendInputEvent'> & {
    debugger: {
        attach(version: string): void;
        detach(): void;
        on(event: 'detach', listener: () => void): unknown;
        sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
    };
};

export class BrowserCDP {
    private webContents: BrowserCDPWebContents;
    /** @internal */ public attached = false;
    /** @internal */ public detachListenerRegistered = false;
    /** @internal */ public idleDetachTimer: ReturnType<typeof setTimeout> | null = null;
    // Map from "@eN" refs to backend node IDs for the current snapshot.
    private refMap: Map<string, number> = new Map();
    // Map from "@eN" refs to semantic details captured during snapshot.
    private refDetails: Map<string, ElementRefDetails> = new Map();
    // Stable mapping for backend DOM nodes across snapshots.
    /** @internal */ public backendNodeRefMap: Map<number, string> = new Map();
    /** @internal */ public nextRefCounter = 0;
    constructor(webContents: BrowserCDPWebContents) {
        this.webContents = webContents;
    }
    private async ensureAttached(): Promise<void> {
        return browserCdpConnection.ensureAttached(this);
    }
    private resetIdleDetachTimer(): void {
        return browserCdpConnection.resetIdleDetachTimer(this);
    }
    detach(): void {
        return browserCdpConnection.detach(this);
    }
    private async send<Method extends keyof CDPCommandResponses>(method: Method, params?: Record<string, unknown>): Promise<CDPCommandResponses[Method]> {
        await this.ensureAttached();
        try {
            const value = await this.webContents.debugger.sendCommand(method, params);
            return parseCDPResponse(method, value);
        }
        finally {
            // Keep detach countdown tied to completed calls so we do not detach mid-flight.
            this.resetIdleDetachTimer();
        }
    }
    private allocateRef(backendDOMNodeId?: number): string {
        return browserCdpReferences.allocateRef(this, backendDOMNodeId);
    }
    private trimRefDetailHistory(): void {
        return browserCdpReferences.trimRefDetailHistory(this);
    }
    /** @internal */ public async recoverRef(ref: string): Promise<string> {
        return browserCdpReferences.recoverRef(this, ref);
    }
    /** @internal */ public async resolveElementRef(ref: string): Promise<ResolvedElementRef> {
        return browserCdpReferences.resolveElementRef(this, ref);
    }
    // ---------------------------------------------------------------------------
    // Accessibility Snapshot
    // ---------------------------------------------------------------------------
    async getAccessibilitySnapshot(): Promise<AccessibilitySnapshot> {
        return browserCdpSnapshot.getAccessibilitySnapshot(this);
    }
    // ---------------------------------------------------------------------------
    // Screenshot Annotation Helpers
    // ---------------------------------------------------------------------------
    /** Reads only the selected canvas bitmap; it never calls capturePage or page-supplied JS. */
    async captureCanvasBitmap(selector: string, isCurrent: () => boolean = () => true) {
        return browserCdpSnapshot.captureCanvasBitmap(this, selector, isCurrent);
    }
    async getElementGeometry(ref: string): Promise<ElementGeometry> {
        return browserCdpGeometry.getElementGeometry(this, ref);
    }
    async getElementGeometryBySelector(selector: string): Promise<ElementGeometry> {
        return browserCdpGeometry.getElementGeometryBySelector(this, selector);
    }
    async getViewportMetrics(): Promise<ViewportMetrics> {
        return browserCdpGeometry.getViewportMetrics(this);
    }
    async renderTemporaryOverlay(params: {
        geometries: ElementGeometry[];
        includeMetadata?: boolean;
        metadataText?: string;
        includeClickPoints?: boolean;
    }): Promise<void> {
        return browserCdpGeometry.renderTemporaryOverlay(this, params);
    }
    async clearTemporaryOverlay(): Promise<void> {
        return browserCdpGeometry.clearTemporaryOverlay(this);
    }
    /** @internal */ public generateTrajectory(fromX: number, fromY: number, toX: number, toY: number, steps: number): Array<{
        x: number;
        y: number;
    }> {
        return browserCdpPointer.generateTrajectory(this, fromX, fromY, toX, toY, steps);
    }
    /** @internal */ public sendMouseEvent(type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number, button?: 'left' | 'right' | 'middle', clickCount?: number): void {
        const event: MouseInputEvent = { type, x: Math.round(x), y: Math.round(y) };
        if (button)
            event.button = button;
        if (clickCount !== undefined)
            event.clickCount = clickCount;
        this.webContents.sendInputEvent(event);
    }
    /** @internal */ public async clickAtCDP(x: number, y: number): Promise<void> {
        return browserCdpPointer.clickAtCDP(this, x, y);
    }
    /** @internal */ public async dragCDP(x1: number, y1: number, x2: number, y2: number): Promise<void> {
        return browserCdpPointer.dragCDP(this, x1, y1, x2, y2);
    }
    // ---------------------------------------------------------------------------
    // Element Interaction
    // ---------------------------------------------------------------------------
    async clickAtCoordinates(x: number, y: number): Promise<void> {
        return browserCdpPointer.clickAtCoordinates(this, x, y);
    }
    async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
        return browserCdpPointer.drag(this, x1, y1, x2, y2);
    }
    async typeText(text: string): Promise<void> {
        return browserCdpInput.typeText(this, text);
    }
    /** Explicit keyboard delivery for canvas/RDP receivers; never uses the OS clipboard. */
    async typeKeys(text: string, isCurrent: () => boolean = () => true): Promise<void> {
        return browserCdpInput.typeKeys(this, text, isCurrent);
    }
    async setClipboard(text: string): Promise<void> {
        return browserCdpInput.setClipboard(this, text);
    }
    async getClipboard(): Promise<string> {
        return browserCdpInput.getClipboard(this);
    }
    async clickElement(ref: string): Promise<ElementGeometry> {
        return browserCdpInput.clickElement(this, ref);
    }
    async fillElement(ref: string, value: string): Promise<ElementGeometry> {
        return browserCdpInput.fillElement(this, ref, value);
    }
    async selectOption(ref: string, value: string): Promise<ElementGeometry> {
        return browserCdpInput.selectOption(this, ref, value);
    }
    async setFileInputFiles(ref: string, filePaths: string[]): Promise<ElementGeometry> {
        return browserCdpInput.setFileInputFiles(this, ref, filePaths);
    }
}
