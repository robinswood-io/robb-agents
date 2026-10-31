import { BrowserWindow, nativeTheme } from "electron";
import { DEFAULT_THEME, loadAppTheme } from "@craft-agent/shared/config";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { TOOLBAR_HEIGHT } from './shared.ts';
import type { AgentControlState, BrowserInstance } from './shared.ts';

export function findInstanceByPageWebContentsId(transportOwner: BrowserPaneManager, senderWebContentsId: number): BrowserInstance | undefined {
    for (const instance of transportOwner["instances"].values()) {
        if (instance.pageView.webContents.id === senderWebContentsId) {
            return instance;
        }
    }
    return undefined;
}

/**
   * Pick an unbound window that the caller's workspace is allowed to adopt.
   *
   * Why workspace filtering matters: when a session ends, its window stays
   * alive and becomes `ownerType='manual'` so the next turn of the **same**
   * session can re-bind it. But the window keeps its original `workspaceId`.
   * Without filtering, a session in workspace B would grab a window left
   * behind by workspace A — moving the window across workspaces, which is
   * exactly the leak this whole workspace-isolation work is fixing.
   *
   * Rule: adoption is allowed if the unbound window has `workspaceId === null`
   * (truly user-opened, no workspace context) OR matches the caller's
   * `workspaceId`. Same-workspace reuse covers the legitimate "turn ended,
   * next turn re-binds" case as well as any future turn of any session in
   * that workspace.
   */
export function findReusableUnboundInstance(transportOwner: BrowserPaneManager, workspaceId: string | null): BrowserInstance | null {
    const candidates = Array.from(transportOwner["instances"].values()).filter((i) => i.boundSessionId === null &&
        i.ownerType === 'manual' &&
        (i.workspaceId === null || i.workspaceId === workspaceId));
    if (candidates.length === 0)
        return null;
    // Prefer visible windows first, then fall back to first available.
    return candidates.find((i) => i.isVisible) ?? candidates[0] ?? null;
}

export function getAgentControlLabel(_transportOwner: BrowserPaneManager, agentControl: Pick<AgentControlState, 'displayName' | 'intent'> | null | undefined): string {
    if (agentControl?.intent) {
        return `${agentControl.displayName ?? 'Agent'} — ${agentControl.intent}`;
    }
    return agentControl?.displayName ?? 'Agent is working…';
}

export function isBrowserWindowAlive(_transportOwner: BrowserPaneManager, window: BrowserWindow): boolean {
    try {
        return !window.isDestroyed();
    }
    catch {
        return false;
    }
}

/** Resolve the app's current accent color as a concrete CSS value (not a var reference). */
export function getResolvedAccentColor(_transportOwner: BrowserPaneManager): string {
    const isDark = nativeTheme.shouldUseDarkColors;
    const userTheme = loadAppTheme();
    const accent = isDark
        ? (userTheme?.dark?.accent ?? userTheme?.accent ?? DEFAULT_THEME.dark!.accent!)
        : (userTheme?.accent ?? DEFAULT_THEME.accent!);
    return accent;
}

export function getToolbarEffectiveHeight(_transportOwner: BrowserPaneManager, instance: BrowserInstance): number {
    if (!instance.toolbarMenuOpen)
        return TOOLBAR_HEIGHT;
    const [, contentHeight] = instance.window.getContentSize();
    return Math.max(TOOLBAR_HEIGHT, contentHeight ?? TOOLBAR_HEIGHT);
}

export function getWindowResizable(_transportOwner: BrowserPaneManager, window: BrowserWindow): boolean {
    try {
        return typeof window.isResizable === 'function' ? window.isResizable() : true;
    }
    catch {
        return true;
    }
}

export function setWindowResizable(_transportOwner: BrowserPaneManager, window: BrowserWindow, value: boolean): boolean {
    try {
        if (typeof window.setResizable === 'function') {
            window.setResizable(value);
        }
        return true;
    }
    catch {
        return false;
    }
}
