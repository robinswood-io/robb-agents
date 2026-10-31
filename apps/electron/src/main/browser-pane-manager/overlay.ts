import type { AgentControlState } from './shared.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { mainLog } from "../logger";
import { getBrowserLiveFxCornerRadii } from "../../shared/browser-live-fx";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { TOOLBAR_HEIGHT } from './shared.ts';
import type { BrowserInstance } from './shared.ts';
import type { BrowserPaneSetAgentControlMetaPayload, BrowserPaneGetOrCreateForSessionAsyncOptionsPayload, BrowserPaneClearAgentControlForInstanceResult } from './protocol.ts';
import * as browserPaneManagerWindowState from './window-state.ts';

export function reapplyAgentControlVisual(transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    if (!transportOwner.isLiveInstance(instance))
        return;
    const active = !!instance.agentControl?.active;
    transportOwner["applyAgentControlLock"](instance, active);
    transportOwner["updateNativeOverlayState"](instance);
}

export async function loadNativeOverlayPage(transportOwner: BrowserPaneManager, instance: BrowserInstance): Promise<void> {
    const liveFxPlatform: Parameters<typeof getBrowserLiveFxCornerRadii>[0] = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
        ? process.platform
        : 'other';
    const cornerRadii = getBrowserLiveFxCornerRadii(liveFxPlatform);
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #overlay {
        position: fixed;
        inset: 0;
        border: 2px solid transparent;
        border-top-left-radius: ${cornerRadii.topLeft};
        border-top-right-radius: ${cornerRadii.topRight};
        border-bottom-left-radius: ${cornerRadii.bottomLeft};
        border-bottom-right-radius: ${cornerRadii.bottomRight};
        box-sizing: border-box;
        pointer-events: none;
      }
      #chip {
        position: fixed;
        top: 8px;
        right: 8px;
        padding: 4px 8px;
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.82);
        color: rgba(236, 254, 255, 0.95);
        font-size: 11px;
        line-height: 1.2;
        backdrop-filter: blur(4px);
        max-width: calc(100vw - 16px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #shield {
        position: fixed;
        inset: 0;
        pointer-events: none;
        cursor: default;
      }
    </style>
  </head>
  <body>
    <div id="overlay">
      <div id="shield"></div>
      <div id="chip">Agent is working…</div>
    </div>
  </body>
</html>`;
    try {
        await instance.nativeOverlayView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
        instance.nativeOverlayReady = true;
        mainLog.info(`[browser-pane] native overlay ready id=${instance.id} platform=${liveFxPlatform} corners=${cornerRadii.bottomLeft}/${cornerRadii.bottomRight}`);
        transportOwner["updateNativeOverlayState"](instance);
    }
    catch (error) {
        instance.nativeOverlayReady = false;
        mainLog.warn(`[browser-pane] native overlay load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function updateNativeOverlayState(transportOwner: BrowserPaneManager, instance: BrowserInstance): void {
    if (!browserPaneManagerWindowState.isBrowserWindowAlive(transportOwner, instance.window))
        return;
    try {
        if (instance.nativeOverlayView.webContents.isDestroyed())
            return;
    }
    catch {
        return;
    }
    const control = instance.agentControl;
    const agentActive = !!control?.active;
    const menuActive = !!instance.toolbarMenuOverlayActive;
    const shouldShow = agentActive || menuActive;
    if (!shouldShow || !instance.nativeOverlayReady) {
        instance.nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        transportOwner.bringToolbarToFront(instance);
        return;
    }
    const [width, height] = instance.window.getContentSize();
    if (width === undefined || height === undefined) throw new Error('Browser window content size unavailable');
    const overlayHeight = Math.max(100, height - TOOLBAR_HEIGHT);
    instance.nativeOverlayView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: overlayHeight });
    transportOwner.bringToolbarToFront(instance);
    if (agentActive) {
        const label = browserPaneManagerWindowState.getAgentControlLabel(transportOwner, control);
        const accent = browserPaneManagerWindowState.getResolvedAccentColor(transportOwner);
        void instance.nativeOverlayView.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('overlay');
        const chip = document.getElementById('chip');
        const shield = document.getElementById('shield');
        if (!overlay || !chip || !shield) return;

        overlay.style.borderColor = ${JSON.stringify(accent)};
        overlay.style.boxShadow = 'inset 0 0 0 1px color-mix(in oklab, ' + ${JSON.stringify(accent)} + ' 45%, transparent), inset 0 0 24px color-mix(in oklab, ' + ${JSON.stringify(accent)} + ' 28%, transparent)';
        chip.textContent = ${JSON.stringify(label)};
        chip.style.display = 'inline-flex';
        shield.style.pointerEvents = 'auto';
        shield.style.cursor = 'not-allowed';
        shield.style.background = 'rgba(2, 6, 23, 0.03)';
      })()`).catch(() => { });
        return;
    }
    // Menu mode: transparent full-page tap-catcher, no visuals
    void instance.nativeOverlayView.webContents.executeJavaScript(`(() => {
      const overlay = document.getElementById('overlay');
      const chip = document.getElementById('chip');
      const shield = document.getElementById('shield');
      if (!overlay || !chip || !shield) return;

      overlay.style.borderColor = 'transparent';
      overlay.style.boxShadow = 'none';
      chip.style.display = 'none';
      shield.style.pointerEvents = 'auto';
      shield.style.cursor = 'default';
      shield.style.background = 'rgba(0, 0, 0, 0.001)';
    })()`).catch(() => { });
}

export function applyAgentControlLock(transportOwner: BrowserPaneManager, instance: BrowserInstance, active: boolean): void {
    const wantsLock = active && !!instance.agentControl?.active;
    if (!browserPaneManagerWindowState.isBrowserWindowAlive(transportOwner, instance.window)) {
        instance.lockState.active = false;
        return;
    }
    if (wantsLock && !instance.lockState.active) {
        instance.lockState.previousResizable = browserPaneManagerWindowState.getWindowResizable(transportOwner, instance.window);
        instance.lockState.active = browserPaneManagerWindowState.setWindowResizable(transportOwner, instance.window, false);
        if (!instance.lockState.active)
            return;
        mainLog.info(`[browser-pane] interaction lock enabled id=${instance.id}`);
        return;
    }
    if (!wantsLock && instance.lockState.active) {
        browserPaneManagerWindowState.setWindowResizable(transportOwner, instance.window, instance.lockState.previousResizable);
        instance.lockState.active = false;
        mainLog.info(`[browser-pane] interaction lock released id=${instance.id}`);
    }
}

// ---------------------------------------------------------------------------
  // Agent Control — persistent overlay while agent is using the browser
  // ---------------------------------------------------------------------------

  /**
   * Activate or update the agent control overlay on the browser instance
   * bound to the given session. Called from sessions.ts on browser_* tool_start events.
   */
export function setAgentControl(transportOwner: BrowserPaneManager, sessionId: string, meta: BrowserPaneSetAgentControlMetaPayload, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): void {
    for (const instance of transportOwner["instances"].values()) {
        if (instance.boundSessionId === sessionId) {
            instance.agentControl = omitUndefined<AgentControlState>({
                active: true,
                sessionId,
                displayName: meta.displayName,
                intent: meta.intent,
            });
            // Backfill workspaceId for instances that were created before the
            // workspace was known (legacy callers / pre-workspaceId code paths).
            if (options?.workspaceId !== undefined && instance.workspaceId === null) {
                instance.workspaceId = options.workspaceId;
            }
            const label = browserPaneManagerWindowState.getAgentControlLabel(transportOwner, instance.agentControl);
            transportOwner.reapplyAgentControlVisual(instance);
            transportOwner["emitStateChange"](instance);
            mainLog.info(`[browser-pane] agent control activated session=${sessionId} label=${label}`);
            return;
        }
    }
}

/**
   * Clear the agent control overlay for the given session.
   * Called on explicit browser_tool release and session/window teardown.
   */
export function clearAgentControl(transportOwner: BrowserPaneManager, sessionId: string): void {
    for (const instance of transportOwner["instances"].values()) {
        if (instance.boundSessionId === sessionId && instance.agentControl?.active) {
            instance.agentControl = null;
            transportOwner["applyAgentControlLock"](instance, false);
            transportOwner["updateNativeOverlayState"](instance);
            transportOwner["emitStateChange"](instance);
            mainLog.info(`[browser-pane] agent control released session=${sessionId}`);
        }
    }
}

export function clearAgentControlForInstance(transportOwner: BrowserPaneManager, instanceId: string, sessionId?: string): BrowserPaneClearAgentControlForInstanceResult {
    const instance = transportOwner["instances"].get(instanceId);
    if (!instance) {
        return { released: false, reason: `Browser window "${instanceId}" not found.` };
    }
    if (sessionId) {
        if (instance.boundSessionId && instance.boundSessionId !== sessionId) {
            return { released: false, reason: `Browser window "${instanceId}" is locked to session ${instance.boundSessionId}.` };
        }
        if (!instance.boundSessionId && instance.ownerSessionId && instance.ownerSessionId !== sessionId) {
            return { released: false, reason: `Browser window "${instanceId}" is currently owned by session ${instance.ownerSessionId}.` };
        }
    }
    if (!instance.agentControl?.active) {
        return { released: false, reason: 'No active agent overlay on the target window.' };
    }
    instance.agentControl = null;
    transportOwner["applyAgentControlLock"](instance, false);
    transportOwner["updateNativeOverlayState"](instance);
    transportOwner["emitStateChange"](instance);
    mainLog.info(`[browser-pane] agent control released instance=${instanceId}${sessionId ? ` session=${sessionId}` : ''}`);
    return { released: true };
}
