import { mainLog } from "../logger";
import { type AccessibilitySnapshot } from "../browser-cdp";
import type { BrowserMutationUrlPolicy } from "@craft-agent/server-core/handlers";
import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { DEFAULT_WAIT_TIMEOUT_MS, DEFAULT_WAIT_POLL_MS } from './shared.ts';
import type { BrowserConsoleEntry, BrowserConsoleOptions, BrowserNetworkEntry, BrowserNetworkOptions, BrowserWaitArgs, BrowserWaitResult, BrowserDownloadEntry, BrowserDownloadOptions } from './shared.ts';
import type { BrowserPaneDetectSecurityChallengeResult } from './protocol.ts';

export async function getAccessibilitySnapshot(transportOwner: BrowserPaneManager, id: string): Promise<AccessibilitySnapshot> {
    const instance = transportOwner["requireAliveInstance"](id);
    return instance.cdp.getAccessibilitySnapshot();
}

export function getConsoleLogs(transportOwner: BrowserPaneManager, id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[] {
    const instance = transportOwner["requireAliveInstance"](id);
    const level = options?.level ?? 'all';
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)));
    const filtered = level === 'all'
        ? instance.consoleLogs
        : instance.consoleLogs.filter((entry) => entry.level === level);
    return filtered.slice(-limit);
}

export function getNetworkLogs(transportOwner: BrowserPaneManager, id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[] {
    const instance = transportOwner["requireAliveInstance"](id);
    const statusFilter = options?.status ?? 'all';
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)));
    const method = options?.method?.toUpperCase();
    const resourceType = options?.resourceType?.toLowerCase();
    const filtered = instance.networkLogs.filter((entry) => {
        if (method && entry.method !== method)
            return false;
        if (resourceType && entry.resourceType.toLowerCase() !== resourceType)
            return false;
        if (statusFilter === 'all')
            return true;
        if (statusFilter === 'failed')
            return !entry.ok;
        if (statusFilter === '2xx')
            return entry.status >= 200 && entry.status < 300;
        if (statusFilter === '3xx')
            return entry.status >= 300 && entry.status < 400;
        if (statusFilter === '4xx')
            return entry.status >= 400 && entry.status < 500;
        if (statusFilter === '5xx')
            return entry.status >= 500 && entry.status < 600;
        return true;
    });
    return filtered.slice(-limit);
}

export async function waitFor(transportOwner: BrowserPaneManager, id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
    const instance = transportOwner["requireAliveInstance"](id);
    const timeoutMs = Math.max(100, args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const pollMs = Math.max(25, args.pollMs ?? DEFAULT_WAIT_POLL_MS);
    const idleMs = Math.max(100, args.idleMs ?? 700);
    const started = Date.now();
    const until = async (predicate: () => Promise<boolean>, detail: string): Promise<BrowserWaitResult> => {
        while (Date.now() - started <= timeoutMs) {
            if (await predicate()) {
                return {
                    ok: true,
                    kind: args.kind,
                    elapsedMs: Date.now() - started,
                    detail,
                };
            }
            await transportOwner.sleep(pollMs);
        }
        throw new Error(`Wait timed out after ${timeoutMs}ms (${args.kind})`);
    };
    if (args.kind === 'challenge-clear') {
        return until(async () => {
            const challenge = await transportOwner["detectSecurityChallenge"](id);
            return !challenge.detected;
        }, 'security challenge cleared');
    }
    if (args.kind === 'selector') {
        const selector = args.value?.trim();
        if (!selector)
            throw new Error('browser_wait selector requires value');
        return until(async () => {
            const exists: unknown = await instance.pageView.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
            return Boolean(exists);
        }, `selector matched: ${selector}`);
    }
    if (args.kind === 'text') {
        const text = args.value?.trim();
        if (!text)
            throw new Error('browser_wait text requires value');
        return until(async () => {
            const found: unknown = await instance.pageView.webContents.executeJavaScript(`document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(text)})`);
            return Boolean(found);
        }, `text found: ${text}`);
    }
    if (args.kind === 'url') {
        const needle = args.value?.trim();
        if (!needle)
            throw new Error('browser_wait url requires value');
        return until(async () => {
            return instance.currentUrl.includes(needle);
        }, `url matched: ${needle}`);
    }
    if (args.kind === 'network-idle') {
        const wcId = instance.pageView.webContents.id;
        return until(async () => {
            const inflight = transportOwner["inFlightRequestsByWebContentsId"].get(wcId) ?? 0;
            const last = transportOwner["lastNetworkActivityByWebContentsId"].get(wcId) ?? started;
            return inflight === 0 && (Date.now() - last) >= idleMs;
        }, `network idle for ${idleMs}ms`);
    }
    throw new Error(`Unknown wait kind: ${args.kind}`);
}

export async function getDownloads(transportOwner: BrowserPaneManager, id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
    const instance = transportOwner["requireAliveInstance"](id);
    const action = options?.action ?? 'list';
    const limit = Math.max(1, Math.min(200, Number(options?.limit ?? 20)));
    if (action === 'wait') {
        const timeoutMs = Math.max(100, Number(options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
        const started = Date.now();
        while (Date.now() - started <= timeoutMs) {
            const hasTerminal = instance.downloads.some((d) => d.state === 'completed' || d.state === 'interrupted' || d.state === 'cancelled');
            if (hasTerminal)
                break;
            await transportOwner.sleep(100);
        }
    }
    return instance.downloads.slice(-limit);
}

export async function evaluate(transportOwner: BrowserPaneManager, id: string, expression: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<unknown> {
    return transportOwner["runSerializedBrowserOperation"](id, () => transportOwner.evaluateAtCurrentUrl(id, expression, mutationPolicy));
}

export async function evaluateAtCurrentUrl(transportOwner: BrowserPaneManager, id: string, expression: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<unknown> {
    const instance = transportOwner["requireAliveInstance"](id);
    transportOwner.assertMutationUrlAllowed(instance, mutationPolicy);
    return instance.pageView.webContents.executeJavaScript(expression);
}

export async function detectSecurityChallenge(transportOwner: BrowserPaneManager, id: string): Promise<BrowserPaneDetectSecurityChallengeResult> {
    const instance = transportOwner["instances"].get(id);
    if (!instance || instance.window.isDestroyed())
        return { detected: false, provider: 'none', signals: [] };
    const signals: string[] = [];
    const title = instance.title || '';
    const url = instance.currentUrl || '';
    // Title-based detection
    if (/^Just a moment/i.test(title)) {
        signals.push('title:just-a-moment');
    }
    // URL-based detection
    if (url.includes('/cdn-cgi/challenge-platform/')) {
        signals.push('url:cdn-cgi-challenge');
    }
    // DOM-based detection via JS evaluation
    try {
        const domSignals = await instance.pageView.webContents.executeJavaScript(`(() => {
        const signals = [];
        const bodyText = (document.body?.innerText || '').slice(0, 2000);
        if (/Verify you are human/i.test(bodyText)) signals.push('text:verify-human');
        if (/Checking (if the site connection is secure|your browser)/i.test(bodyText)) signals.push('text:checking-browser');
        if (/Performing security verification/i.test(bodyText)) signals.push('text:security-verification');
        if (document.querySelector('#challenge-form')) signals.push('dom:challenge-form');
        if (document.querySelector('#turnstile-wrapper')) signals.push('dom:turnstile-wrapper');
        if (document.querySelector('.cf-turnstile')) signals.push('dom:cf-turnstile');
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) signals.push('dom:cf-challenge-iframe');
        if (document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]')) signals.push('dom:hcaptcha');
        if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]')) signals.push('dom:recaptcha');
        if (document.querySelector('iframe[src*="captcha-delivery.com"], [data-captcha-provider="datadome"]')) signals.push('dom:datadome');
        if (document.querySelector('iframe[src*="arkoselabs.com"], [data-callback*="arkose"]')) signals.push('dom:arkose');
        return signals;
      })()`) as string[];
        if (Array.isArray(domSignals)) {
            signals.push(...domSignals);
        }
    }
    catch {
        // JS evaluation can fail if page is in a weird state — don't block on it
    }
    // Sparse pages are common in normal applications. Only pay for an AX snapshot
    // after a strong title/URL/DOM signal, and use sparsity as supporting evidence.
    if (signals.length > 0) {
        try {
            const snapshot = await instance.cdp.getAccessibilitySnapshot();
            const actionableRoles = new Set([
                'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
                'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'spinbutton', 'listbox',
            ]);
            const actionableCount = snapshot.nodes.filter((node) => {
                const role = (node.role || '').toLowerCase();
                return actionableRoles.has(role) && !node.disabled;
            }).length;
            if (snapshot.nodes.length > 0 && actionableCount <= 2) {
                signals.push(`ax:near-empty(${actionableCount}/${snapshot.nodes.length})`);
            }
        }
        catch {
            // AX snapshot can fail transiently during navigation; ignore
        }
    }
    const detected = signals.length > 0;
    const provider = !detected
        ? 'none'
        : signals.some(signal => /(?:cf-|cloudflare|turnstile|cdn-cgi|just-a-moment)/i.test(signal))
            ? 'cloudflare'
            : signals.some(signal => /hcaptcha/i.test(signal))
                ? 'hcaptcha'
                : signals.some(signal => /recaptcha/i.test(signal))
                    ? 'recaptcha'
                    : signals.some(signal => /datadome|captcha-delivery/i.test(signal))
                        ? 'datadome'
                        : signals.some(signal => /arkose/i.test(signal))
                            ? 'arkose'
                            : 'unknown';
    if (detected) {
        mainLog.info(`[browser-pane] security challenge detected id=${id} provider=${provider} signals=[${signals.join(', ')}]`);
    }
    return { detected, provider, signals };
}
