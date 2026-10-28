import { omitUndefined } from '@craft-agent/shared/utils/json';
import { nativeImage } from "electron";
import { type ElementGeometry } from "../browser-cdp";
import { CANVAS_CAPTURE_LIMITS } from "../browser-canvas-capture";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { SCREENSHOT_RETRY_DELAY_MS, SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS, SCREENSHOT_NETWORK_IDLE_MS } from './shared.ts';
import type { BrowserInstance, BrowserScreenshotOptions, BrowserScreenshotRegionTarget, BrowserScreenshotResult } from './shared.ts';
type ScreenshotMetadata = NonNullable<BrowserScreenshotResult['metadata']>;

import * as browserPaneManagerCapturePage from './capture-page.ts';

export async function screenshot(transportOwner: BrowserPaneManager, id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const instance = transportOwner["requireAliveInstance"](id);
    // Hide native agent overlay so it doesn't appear in captures
    const suspendedOverlay = browserPaneManagerCapturePage.suspendOverlayForCapture(transportOwner, instance);
    try {
        // When annotating, force agent mode and gather refs from accessibility tree
        const annotate = !!options?.annotate;
        const mode = (annotate || options?.mode === 'agent') ? 'agent' : 'raw';
        if (mode === 'raw') {
            const viewport = await instance.cdp.getViewportMetrics();
            const captured = await transportOwner.capturePageWithRecovery(instance, {
                mode,
                errorPrefix: 'screenshot',
                dpr: viewport.dpr,
                ...(options?.format !== undefined ? { format: options?.format } : {}),
                ...(options?.jpegQuality !== undefined ? { jpegQuality: options?.jpegQuality } : {}),
            });
            return omitUndefined<BrowserScreenshotResult>({
                imageBuffer: captured.imageBuffer,
                imageFormat: captured.imageFormat,
                metadata: options?.includeMetadata
                    ? omitUndefined<ScreenshotMetadata>({
                        mode: 'raw',
                        warnings: captured.warnings.length > 0 ? captured.warnings : undefined,
                    })
                    : undefined,
            });
        }
        const warnings: string[] = [];
        const geometries: ElementGeometry[] = [];
        const MAX_ANNOTATED_REFS = 100;
        let refs = options?.refs ?? [];
        if (annotate) {
            try {
                const snapshot = await instance.cdp.getAccessibilitySnapshot();
                refs = snapshot.nodes.map((node) => node.ref).slice(0, MAX_ANNOTATED_REFS);
                if (snapshot.nodes.length > MAX_ANNOTATED_REFS) {
                    warnings.push(`Annotation capped at ${MAX_ANNOTATED_REFS} of ${snapshot.nodes.length} elements`);
                }
            }
            catch (error) {
                warnings.push(`Accessibility snapshot for annotation failed: ${error instanceof Error ? error.message : String(error)}`);
                refs = [];
            }
        }
        const settled = await Promise.allSettled(refs.map((ref) => instance.cdp.getElementGeometry(ref)));
        for (const [i, result] of settled.entries()) {
            if (result.status === 'fulfilled') {
                geometries.push(result.value);
            }
            else if (!annotate) {
                const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
                warnings.push(`Could not resolve ref ${refs[i]}: ${reason}`);
            }
        }
        if (options?.includeLastAction && instance.lastAction?.geometry) {
            geometries.push(instance.lastAction.geometry);
        }
        const metadataText = instance.lastAction
            ? `${instance.lastAction.tool} • ${instance.lastAction.status} • ${new Date(instance.lastAction.timestamp).toISOString()}`
            : `browser_screenshot • ${new Date().toISOString()}`;
        let annotationPartial = false;
        try {
            if (geometries.length > 0 || options?.includeMetadata) {
                await instance.cdp.renderTemporaryOverlay({
                    geometries,
                    includeMetadata: !!options?.includeMetadata,
                    metadataText,
                    includeClickPoints: true,
                });
            }
        }
        catch (error) {
            annotationPartial = true;
            warnings.push(`Annotation overlay failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
            const viewport = await instance.cdp.getViewportMetrics();
            const captured = await transportOwner.capturePageWithRecovery(instance, {
                mode,
                errorPrefix: 'screenshot',
                dpr: viewport.dpr,
                ...(options?.format !== undefined ? { format: options?.format } : {}),
                ...(options?.jpegQuality !== undefined ? { jpegQuality: options?.jpegQuality } : {}),
            });
            if (captured.warnings.length > 0) {
                warnings.push(...captured.warnings);
            }
            return {
                imageBuffer: captured.imageBuffer,
                imageFormat: captured.imageFormat,
                metadata: omitUndefined<ScreenshotMetadata>({
                    mode: 'agent',
                    viewport,
                    targets: geometries.map((g) => omitUndefined({
                        ref: g.ref,
                        role: g.role,
                        name: g.name,
                        box: g.box,
                        clickPoint: g.clickPoint,
                    })),
                    action: instance.lastAction
                        ? {
                            tool: instance.lastAction.tool,
                            ...(instance.lastAction.ref !== undefined ? { ref: instance.lastAction.ref } : {}),
                            status: instance.lastAction.status,
                            timestamp: instance.lastAction.timestamp,
                        }
                        : undefined,
                    annotationPartial,
                    warnings: warnings.length > 0 ? warnings : undefined,
                }),
            };
        }
        finally {
            try {
                await instance.cdp.clearTemporaryOverlay();
            }
            catch {
                // ignore cleanup errors
            }
        }
    }
    finally {
        transportOwner.restoreOverlayAfterCapture(instance, suspendedOverlay);
    }
}

export async function screenshotRegion(transportOwner: BrowserPaneManager, id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
    const instance = transportOwner["instances"].get(id);
    if (!instance)
        throw new Error(`Browser instance not found: ${id}`);
    if (target.source !== undefined) {
        if (target.source !== 'canvas' || typeof target.selector !== 'string' || !target.selector.trim()
            || Object.keys(target).some(key => !['source', 'selector', 'format'].includes(key))
            || (target.format !== undefined && target.format !== 'png')) {
            throw new Error('Canvas capture requires only source=canvas and a unique selector; PNG only, no padding, ref or coordinates');
        }
        const owner = instance.ownerSessionId, bound = instance.boundSessionId, workspace = instance.workspaceId;
        const current = () => transportOwner["instances"].get(id) === instance && !instance.window.isDestroyed()
            && !instance.pageView.webContents.isDestroyed() && instance.ownerSessionId === owner
            && instance.boundSessionId === bound && instance.workspaceId === workspace;
        const { receipt, png } = await instance.cdp.captureCanvasBitmap(target.selector, current);
        if (!current())
            throw new Error('Canvas capture ownership changed; no image was returned');
        const original = nativeImage.createFromBuffer(png);
        if (original.isEmpty() || original.getSize().width !== receipt.width || original.getSize().height !== receipt.height)
            throw new Error('Canvas capture bitmap decoding failed');
        const image = original.crop(receipt.sourceRect);
        const pixels = image.toBitmap();
        let hasVisiblePixel = false;
        for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] !== 0) {
                hasVisiblePixel = true;
                break;
            }
        }
        if (image.isEmpty() || !hasVisiblePixel)
            throw new Error('Canvas bitmap is empty or transparent; this does not prove that the remote screen is empty. No repaint was forced.');
        const imageBuffer = image.toPNG();
        if (!imageBuffer.length || imageBuffer.length > CANVAS_CAPTURE_LIMITS.pngBytes)
            throw new Error('Canvas capture output exceeds the image limit');
        return { imageBuffer, imageFormat: 'png', metadata: {
                source: 'canvas-bitmap', mode: 'canvas', viewport: receipt.viewport, region: receipt.region,
                canvasBox: receipt.canvasBox, intrinsicSize: { width: receipt.width, height: receipt.height },
                sourceRect: receipt.sourceRect, capturedAt: receipt.capturedAt,
                imageToViewport: { x: receipt.region.x, y: receipt.region.y,
                    scaleX: receipt.region.width / receipt.sourceRect.width, scaleY: receipt.region.height / receipt.sourceRect.height },
                warnings: ['Selected canvas bitmap only; DOM overlays, other canvas layers and composited CSS effects are excluded.', 'Sample time is not a remote execution acknowledgement or a guarantee of a fresh repaint.'],
            } };
    }
    const hasCoords = [target.x, target.y, target.width, target.height].every((v) => typeof v === 'number');
    const hasRef = typeof target.ref === 'string' && target.ref.length > 0;
    const hasSelector = typeof target.selector === 'string' && target.selector.length > 0;
    const modeCount = [hasCoords, hasRef, hasSelector].filter(Boolean).length;
    if (modeCount === 0) {
        throw new Error('Region screenshot requires either coordinates, ref, or selector');
    }
    if (modeCount > 1) {
        throw new Error('Region screenshot target is ambiguous. Provide only one of coordinates, ref, or selector');
    }
    const suspendedOverlay = browserPaneManagerCapturePage.suspendOverlayForCapture(transportOwner, instance);
    try {
        let box: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        if (hasRef) {
            const geometry = await instance.cdp.getElementGeometry(String(target.ref));
            box = { ...geometry.box };
        }
        else if (hasSelector) {
            const geometry = await instance.cdp.getElementGeometryBySelector(String(target.selector));
            box = { ...geometry.box };
        }
        else {
            box = {
                x: Number(target.x),
                y: Number(target.y),
                width: Number(target.width),
                height: Number(target.height),
            };
        }
        const padding = Math.max(0, Number(target.padding ?? 0));
        box = {
            x: box.x - padding,
            y: box.y - padding,
            width: box.width + padding * 2,
            height: box.height + padding * 2,
        };
        const viewport = await instance.cdp.getViewportMetrics();
        const clippedX = Math.max(0, Math.floor(box.x));
        const clippedY = Math.max(0, Math.floor(box.y));
        const maxWidth = Math.max(0, Math.floor(viewport.width - clippedX));
        const maxHeight = Math.max(0, Math.floor(viewport.height - clippedY));
        const clippedWidth = Math.min(Math.max(1, Math.floor(box.width)), maxWidth);
        const clippedHeight = Math.min(Math.max(1, Math.floor(box.height)), maxHeight);
        if (maxWidth <= 0 || maxHeight <= 0 || clippedWidth <= 0 || clippedHeight <= 0) {
            throw new Error('Resolved screenshot region is outside the current viewport');
        }
        const captured = await transportOwner.capturePageWithRecovery(instance, {
            mode: 'region',
            errorPrefix: 'region screenshot',
            rect: {
                x: clippedX,
                y: clippedY,
                width: clippedWidth,
                height: clippedHeight,
            },
            dpr: viewport.dpr,
            ...(target.format !== undefined ? { format: target.format } : {}),
            ...(target.jpegQuality !== undefined ? { jpegQuality: target.jpegQuality } : {}),
        });
        return {
            imageBuffer: captured.imageBuffer,
            imageFormat: captured.imageFormat,
            metadata: omitUndefined<ScreenshotMetadata>({
                mode: 'raw',
                viewport,
                region: {
                    x: clippedX,
                    y: clippedY,
                    width: clippedWidth,
                    height: clippedHeight,
                },
                targetMode: hasRef ? 'ref' : hasSelector ? 'selector' : 'coords',
                warnings: captured.warnings.length > 0 ? captured.warnings : undefined,
            }),
        };
    }
    finally {
        transportOwner.restoreOverlayAfterCapture(instance, suspendedOverlay);
    }
}

export function restoreOverlayAfterCapture(transportOwner: BrowserPaneManager, instance: BrowserInstance, suspended: boolean): void {
    if (!suspended)
        return;
    transportOwner["updateNativeOverlayState"](instance);
}

export async function waitForScreenshotReadiness(transportOwner: BrowserPaneManager, instanceId: string): Promise<void> {
    try {
        await transportOwner["waitFor"](instanceId, {
            kind: 'network-idle',
            timeoutMs: SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS,
            idleMs: SCREENSHOT_NETWORK_IDLE_MS,
        });
    }
    catch {
        // network-idle can fail on continuously active pages; still proceed after bounded delay
    }
    await transportOwner.sleep(SCREENSHOT_RETRY_DELAY_MS);
}
