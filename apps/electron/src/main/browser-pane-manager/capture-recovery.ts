import { mainLog } from "../logger";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS, SCREENSHOT_RESCUE_PAINT_DELAY_MS } from './shared.ts';
import type { BrowserInstance } from './shared.ts';
import type { BrowserPaneCapturePageWithRecoveryOptionsPayload, BrowserPaneCapturePageWithRecoveryResult } from './protocol.ts';
import * as browserPaneManagerCapturePage from './capture-page.ts';

export async function capturePageWithRecovery(transportOwner: BrowserPaneManager, instance: BrowserInstance, options: BrowserPaneCapturePageWithRecoveryOptionsPayload): Promise<BrowserPaneCapturePageWithRecoveryResult> {
    let rescueUsed = false;
    let sawDisplaySurfaceUnavailable = false;
    const warnings: string[] = [];
    const imageOpts = { dpr: options.dpr, format: options.format, jpegQuality: options.jpegQuality };
    for (let attempt = 1; attempt <= SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS; attempt += 1) {
        let result: {
            buffer: Buffer;
            format: 'png' | 'jpeg';
        } | null = null;
        try {
            result = await browserPaneManagerCapturePage.capturePageImage(transportOwner, instance, {
                rect: options.rect,
                useHiddenCaptureOptions: true,
                ...imageOpts,
            });
        }
        catch (error) {
            if (browserPaneManagerCapturePage.isDisplaySurfaceUnavailableError(transportOwner, error)) {
                sawDisplaySurfaceUnavailable = true;
                mainLog.warn(`[browser-pane] ${options.errorPrefix} display surface unavailable instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS} visible=${instance.isVisible} url=${instance.currentUrl}`);
            }
            else {
                throw error;
            }
        }
        if (result) {
            if (attempt > 1) {
                warnings.push(`Capture recovered after ${attempt} hidden attempt${attempt === 1 ? '' : 's'}.`);
            }
            return { imageBuffer: result.buffer, imageFormat: result.format, warnings };
        }
        mainLog.warn(`[browser-pane] ${options.errorPrefix} empty capture attempt instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS} visible=${instance.isVisible} isLoading=${instance.isLoading} url=${instance.currentUrl}`);
        if (attempt < SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS) {
            await transportOwner["waitForScreenshotReadiness"](instance.id);
        }
    }
    const window = instance.window;
    const wasVisible = instance.isVisible;
    if (!window.isDestroyed()) {
        try {
            if (!wasVisible) {
                if (window.isMinimized()) {
                    window.restore();
                }
                window.showInactive();
                instance.isVisible = true;
                transportOwner["emitStateChange"](instance);
                rescueUsed = true;
                await transportOwner["sleep"](SCREENSHOT_RESCUE_PAINT_DELAY_MS);
                await transportOwner["waitForScreenshotReadiness"](instance.id);
            }
            let rescueResult: {
                buffer: Buffer;
                format: 'png' | 'jpeg';
            } | null = null;
            try {
                rescueResult = await browserPaneManagerCapturePage.capturePageImage(transportOwner, instance, {
                    rect: options.rect,
                    useHiddenCaptureOptions: false,
                    ...imageOpts,
                });
            }
            catch (error) {
                if (browserPaneManagerCapturePage.isDisplaySurfaceUnavailableError(transportOwner, error)) {
                    sawDisplaySurfaceUnavailable = true;
                    mainLog.warn(`[browser-pane] ${options.errorPrefix} display surface unavailable during rescue instance=${instance.id} mode=${options.mode} visible=${instance.isVisible} url=${instance.currentUrl}`);
                }
                else {
                    throw error;
                }
            }
            if (rescueResult) {
                if (rescueUsed) {
                    warnings.push('Capture required temporary inactive reveal for rendering; browser visibility was restored immediately.');
                }
                return { imageBuffer: rescueResult.buffer, imageFormat: rescueResult.format, warnings };
            }
        }
        finally {
            if (!wasVisible && !window.isDestroyed()) {
                window.hide();
                instance.isVisible = false;
                transportOwner["emitStateChange"](instance);
            }
        }
    }
    mainLog.warn(`[browser-pane] ${options.errorPrefix} capture failed after recovery instance=${instance.id} mode=${options.mode} visible=${instance.isVisible} isLoading=${instance.isLoading} url=${instance.currentUrl} rescueUsed=${rescueUsed}`);
    if (sawDisplaySurfaceUnavailable) {
        throw new Error(`Failed to capture ${options.errorPrefix}: current display surface is unavailable. `
            + `Try focusing the browser window first ("focus ${instance.id}" or "open --foreground") and retry.`);
    }
    throw new Error(`Failed to capture ${options.errorPrefix}: empty image buffer`);
}
