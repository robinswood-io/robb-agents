import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import type { BrowserInstance } from './shared.ts';
import type { BrowserPaneCapturePageImageOptionsPayload, BrowserPaneCapturePageImageResult } from './protocol.ts';

export function suspendOverlayForCapture(_transportOwner: BrowserPaneManager, instance: BrowserInstance): boolean {
    const shouldSuspend = !!instance.agentControl?.active
        && instance.nativeOverlayReady;
    if (!shouldSuspend)
        return false;
    instance.nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return true;
}

export function isDisplaySurfaceUnavailableError(_transportOwner: BrowserPaneManager, error: unknown): boolean {
    if (!(error instanceof Error))
        return false;
    return error.message.toLowerCase().includes('current display surface not available for capture');
}

export async function capturePageImage(_transportOwner: BrowserPaneManager, instance: BrowserInstance, options: BrowserPaneCapturePageImageOptionsPayload): Promise<BrowserPaneCapturePageImageResult | null> {
    const captureOpts = options.useHiddenCaptureOptions
        ? { stayHidden: true, stayAwake: true }
        : undefined;
    let image = options.rect
        ? await instance.pageView.webContents.capturePage(options.rect, captureOpts)
        : await instance.pageView.webContents.capturePage(undefined, captureOpts);
    if (image.isEmpty()) {
        return null;
    }
    // Downscale from device pixels to CSS pixels so screenshot coordinates
    // match click-at viewport coordinates (uses Skia Lanczos via 'best')
    const dpr = options.dpr ?? 1;
    if (dpr > 1) {
        const size = image.getSize();
        image = image.resize({
            width: Math.round(size.width / dpr),
            height: Math.round(size.height / dpr),
            quality: 'best',
        });
    }
    const fmt = options.format ?? 'png';
    const encoded = fmt === 'jpeg'
        ? image.toJPEG(options.jpegQuality ?? 80)
        : image.toPNG();
    if (!encoded || encoded.length === 0) {
        return null;
    }
    return { buffer: encoded, format: fmt };
}
