import { BrowserWindow } from "electron";
import { windowLog } from "../logger";
import { release } from "os";

// Vite dev server URL for hot reload
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/**
 * Get the appropriate background material for Windows transparency effects
 * - Windows 11 (build 22000+): Mica effect
 * - Windows 10 1809+ (build 17763+): Acrylic effect
 * - Older versions: No transparency
 */
export function getWindowsBackgroundMaterial(): 'mica' | 'acrylic' | undefined {
    if (process.platform !== 'win32')
        return undefined;
    // os.release() returns "10.0.xxxxx" where xxxxx is the build number
    const buildNumber = parseInt(release().split('.')[2] || '0', 10);
    if (buildNumber >= 22000) {
        windowLog.info('Windows 11 detected (build ' + buildNumber + '), using Mica');
        return 'mica';
    }
    else if (buildNumber >= 17763) {
        windowLog.info('Windows 10 1809+ detected (build ' + buildNumber + '), using Acrylic');
        return 'acrylic';
    }
    windowLog.info('Older Windows detected (build ' + buildNumber + '), no transparency');
    return undefined;
}

export interface ManagedWindow {
    window: BrowserWindow;
    workspaceId: string;
}

export interface CreateWindowOptions {
    /** The workspace to open (empty string for onboarding) */
    workspaceId: string;
    /** Whether to open in focused mode (smaller window, no sidebars) */
    focused?: boolean;
    /** Deep link URL to navigate to after window loads (without ?window= param) */
    initialDeepLink?: string;
    /** Full URL to restore from saved state (preserves route/query params) */
    restoreUrl?: string;
}
