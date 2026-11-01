import { mainLog } from "../logger";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { TOOLBAR_CHANNELS } from './shared.ts';
import type { BrowserInstance } from './shared.ts';

export async function loadToolbarFallback(_transportOwner: BrowserPaneManager, instance: BrowserInstance, reason: string): Promise<void> {
    const safeReason = reason.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] || ch));
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser Toolbar Error</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fafafb; color: #1f2937; }
      @media (prefers-color-scheme: dark) { html, body { background: #2b292e; color: #e5e7eb; } }
      .wrap { height: 100%; display: flex; align-items: center; justify-content: center; }
      .card { max-width: 640px; margin: 0 20px; padding: 14px 16px; border-radius: 10px; background: rgba(127,127,127,0.12); font-size: 12px; line-height: 1.45; }
      .title { font-weight: 600; margin-bottom: 6px; }
      .muted { opacity: 0.8; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="title">Browser toolbar failed to load</div>
        <div class="muted">The page area still works, but toolbar UI is unavailable. Try reopening the browser window.</div>
        <div class="muted" style="margin-top: 8px; word-break: break-word;">Reason: ${safeReason}</div>
      </div>
    </div>
  </body>
</html>`;
    try {
        await instance.toolbarView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
        mainLog.warn(`[browser-pane] Loaded toolbar fallback id=${instance.id}`);
    }
    catch (error) {
        mainLog.error(`[browser-pane] Failed to load toolbar fallback id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function pushToolbarState(_transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    if (instance.window.isDestroyed() || instance.toolbarView.webContents.isDestroyed())
        return;
    const state = {
        url: instance.currentUrl,
        title: instance.title,
        isLoading: instance.isLoading,
        canGoBack: instance.canGoBack,
        canGoForward: instance.canGoForward,
        themeColor: instance.themeColor,
    };
    instance.toolbarView.webContents.send(TOOLBAR_CHANNELS.STATE_UPDATE, state);
}
