import { mainLog } from "../logger";
import type { BrowserCDP } from '../browser-cdp.ts';
import { CDP_IDLE_DETACH_MS } from './shared.ts';

export async function ensureAttached(transportOwner: BrowserCDP): Promise<void> {
    if (transportOwner.attached)
        return;
    try {
        transportOwner["webContents"].debugger.attach('1.3');
        transportOwner.attached = true;
    }
    catch (err) {
        // May already be attached
        if (String(err).includes('Already attached')) {
            transportOwner.attached = true;
        }
        else {
            throw err;
        }
    }
    if (!transportOwner.detachListenerRegistered) {
        transportOwner.detachListenerRegistered = true;
        transportOwner["webContents"].debugger.on('detach', () => {
            transportOwner.attached = false;
        });
    }
}

export function resetIdleDetachTimer(transportOwner: BrowserCDP): void {
    if (transportOwner.idleDetachTimer) {
        clearTimeout(transportOwner.idleDetachTimer);
    }
    transportOwner.idleDetachTimer = setTimeout(() => {
        if (transportOwner.attached) {
            mainLog.info('[browser-cdp] idle detach — detaching debugger after inactivity');
            transportOwner["detach"]();
        }
    }, CDP_IDLE_DETACH_MS);
}

export function detach(transportOwner: BrowserCDP): void {
    if (transportOwner.idleDetachTimer) {
        clearTimeout(transportOwner.idleDetachTimer);
        transportOwner.idleDetachTimer = null;
    }
    if (transportOwner.attached) {
        try {
            transportOwner["webContents"].debugger.detach();
        }
        catch { /* ignore */ }
        transportOwner.attached = false;
    }
}
