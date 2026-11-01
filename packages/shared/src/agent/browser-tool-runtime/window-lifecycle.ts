import type { BrowserPaneFns } from "../browser-tools.ts";
import { MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS } from "../browser-tool-execution-watchdog.ts";
import type { BrowserCommandExecutionArgs, BrowserCommandResult } from './contracts.ts';
import { formatLifecycleResultLine, getPageMetrics, summarizeWindows, waitForForegroundOpenVisibility } from './page-summary.ts';

export async function executeOpenBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const foreground = parts.includes('--foreground') || parts.includes('-f');
    const windowsBefore = await fns.listWindows();
    const result = await fns.openPanel({ background: !foreground });

    let windowsAfter = await fns.listWindows();
    let win = windowsAfter.find((w) => w.id === result.instanceId);
    let settledByWait = true;
    let usedFocusFallback = false;

    if (foreground) {
      const visibilityResult = await waitForForegroundOpenVisibility({
        fns,
        instanceId: result.instanceId,
      });
      windowsAfter = visibilityResult.windows;
      win = visibilityResult.win;
      settledByWait = visibilityResult.settledByWait;
      usedFocusFallback = visibilityResult.usedFocusFallback;
    }

    const reused = windowsBefore.some((w) => w.id === result.instanceId);
    const mode = foreground ? 'foreground' : 'background';

    const lines = [
      `Opened in-app browser window in ${mode} (instance: ${result.instanceId})`,
      `Window state: ${reused ? 'reused existing window' : 'created new window'}`,
      `Session windows: ${summarizeWindows(windowsAfter)}`,
    ];
    if (foreground) {
      lines.push(`Visibility settle: ${settledByWait ? 'wait-loop' : 'timeout'}${usedFocusFallback ? ' + focus retry' : ''}`);
    }
    if (win) {
      lines.push(
        `Visible: ${win.isVisible}, ownerType: ${win.ownerType}, boundSessionId: ${win.boundSessionId ?? 'none'}`,
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeNavigateBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const url = parts.slice(1).join(' ').trim();
    if (!url) throw new Error('navigate requires a URL. Example: navigate https://example.com');

    const before = await getPageMetrics(fns);
    const started = Date.now();
    const result = await fns.navigate(url);
    const elapsedMs = Date.now() - started;
    const [after, failed, challenge] = await Promise.all([
      getPageMetrics(fns),
      fns.getNetworkLogs({ limit: 200, status: 'failed' }),
      fns.detectChallenge(),
    ]);
    if (challenge.detected) {
      await fns.releaseControl();
      return {
        output: [
          `Security verification detected (${challenge.provider}).`,
          `Signals: ${challenge.signals.join(', ')}`,
          `URL: ${result.url}`,
          '',
          'Browser shown — please complete the verification check.',
          'After verification, run "resume 120000"; it will wait without blocking your clicks.',
        ].join('\n'),
        appendReleaseHint: false,
      };
    }

    const lines = [
      `Navigated to: ${result.url}`,
      `Title: ${result.title}`,
      `Elapsed: ${elapsedMs}ms`,
      `URL changed: ${before ? before.url !== result.url : 'unknown'}`,
      `Recent failed requests: ${failed.length}`,
    ];
    if (after) {
      lines.push(`Viewport: ${after.viewportWidth}x${after.viewportHeight}, scroll=(${after.scrollX}, ${after.scrollY})`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeWindowResizeBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const widthRaw = parts[1];
    const heightRaw = parts[2];
    if (!widthRaw || !heightRaw) throw new Error('window-resize requires width and height. Example: window-resize 1280 720');
    const width = Number(widthRaw);
    const height = Number(heightRaw);
    if (Number.isNaN(width) || Number.isNaN(height)) {
      throw new Error('window-resize width and height must be numbers.');
    }

    const resized = await fns.windowResize({ width, height });
    const clamped = resized.width !== width || resized.height !== height;

    return {
      output: [
        `Window resized to ${resized.width}x${resized.height}`,
        `Requested: ${width}x${height}${clamped ? ' (adjusted by platform constraints)' : ''}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeResumeBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const timeoutRaw = parts[1];
    const requestedTimeout = timeoutRaw ? Number(timeoutRaw) : 120_000;
    if (!Number.isFinite(requestedTimeout)) {
      throw new Error(`Invalid resume timeout "${String(timeoutRaw)}". Expected a number.`);
    }
    const timeoutMs = Math.max(1_000, Math.min(MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS, requestedTimeout));
    const result = await fns.waitFor({ kind: 'challenge-clear', timeoutMs });

    return {
      output: [
        `Security verification cleared after ${result.elapsedMs}ms.`,
        'Run "snapshot" to refresh element refs and continue.',
      ].join('\n'),
      appendReleaseHint: false,
    };
  }

export async function executeBackBrowserCommand(fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const before = await getPageMetrics(fns);
    await fns.goBack();
    const after = await getPageMetrics(fns);

    const lines = ['Navigated back'];
    if (before && after) {
      lines.push(`URL: ${before.url} → ${after.url}`);
      lines.push(`Title: ${before.title || '(untitled)'} → ${after.title || '(untitled)'}`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeForwardBrowserCommand(fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const before = await getPageMetrics(fns);
    await fns.goForward();
    const after = await getPageMetrics(fns);

    const lines = ['Navigated forward'];
    if (before && after) {
      lines.push(`URL: ${before.url} → ${after.url}`);
      lines.push(`Title: ${before.title || '(untitled)'} → ${after.title || '(untitled)'}`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeFocusBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const instanceId = parts[1];
    const result = await fns.focusWindow(instanceId);
    const windows = await fns.listWindows();
    const target = windows.find((w) => w.id === result.instanceId);

    const lines = [
      `Focused browser window ${result.instanceId}`,
      `Title: ${result.title || 'New Tab'}`,
      `URL: ${result.url || 'about:blank'}`,
      `Session windows: ${summarizeWindows(windows)}`,
    ];
    if (target) {
      const lockState = target.boundSessionId ? `locked-session(${target.boundSessionId})` : 'unlocked';
      lines.push(`Lock state: ${lockState}, visible: ${target.isVisible}`);
    }

    return {
      output: lines.join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeWindowsBrowserCommand(fns: BrowserPaneFns, args: BrowserCommandExecutionArgs): Promise<BrowserCommandResult> {
    const windows = await fns.listWindows();
    const available = windows.filter((w) => !w.boundSessionId || w.boundSessionId === args.sessionId).length;
    const lines: string[] = [`Browser windows (${windows.length}) — ${summarizeWindows(windows)}, availableToSession=${available}`];

    for (const w of windows) {
      const lockState = w.boundSessionId ? `locked-session(${w.boundSessionId})` : 'unlocked';
      const availableToSession = !w.boundSessionId || w.boundSessionId === args.sessionId;
      lines.push(
        '',
        `- ${w.id}`,
        `  title: ${w.title || 'New Tab'}`,
        `  url: ${w.url || 'about:blank'}`,
        `  visible: ${w.isVisible}`,
        `  ownerType: ${w.ownerType}`,
        `  ownerSessionId: ${w.ownerSessionId ?? 'none'}`,
        `  boundSessionId: ${w.boundSessionId ?? 'none'}`,
        `  lockState: ${lockState}`,
        `  availableToSession: ${availableToSession}`,
        `  agentControlActive: ${!!w.agentControlActive}`,
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

export async function executeReleaseBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const targetArg = parts[1];
    if (parts.length > 2) {
      throw new Error('release accepts at most one optional argument: [windowId|all]');
    }

    const before = await fns.listWindows();
    const activeOverlays = before.filter((w) => !!w.agentControlActive).length;
    const lifecycle = await fns.releaseControl(targetArg);
    const after = await fns.listWindows();
    const activeAfter = after.filter((w) => !!w.agentControlActive).length;

    const title = lifecycle.action === 'released'
      ? 'Browser control released. Agent overlay dismissed.'
      : 'No browser overlay was released.';

    return {
      output: [
        title,
        formatLifecycleResultLine(lifecycle),
        `Overlays active: ${activeOverlays} → ${activeAfter}`,
      ].join('\n'),
      appendReleaseHint: false,
    };
  }

export async function executeCloseBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const targetArg = parts[1];
    if (parts.length > 2) {
      throw new Error('close accepts at most one optional argument: [windowId]');
    }

    const before = await fns.listWindows();
    const lifecycle = await fns.closeWindow(targetArg);
    const after = await fns.listWindows();

    const title = lifecycle.action === 'closed'
      ? 'Browser window closed and destroyed.'
      : 'No browser window was closed.';

    return {
      output: [
        title,
        formatLifecycleResultLine(lifecycle),
        `Session windows: ${summarizeWindows(before)} → ${summarizeWindows(after)}`,
      ].join('\n'),
      appendReleaseHint: false,
    };
  }

export async function executeHideBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const targetArg = parts[1];
    if (parts.length > 2) {
      throw new Error('hide accepts at most one optional argument: [windowId]');
    }

    const before = await fns.listWindows();
    const lifecycle = await fns.hideWindow(targetArg);
    const after = await fns.listWindows();

    const title = lifecycle.action === 'hidden'
      ? 'Browser window hidden. Use "open" to show it again.'
      : 'No browser window was hidden.';

    return {
      output: [
        title,
        formatLifecycleResultLine(lifecycle),
        `Session windows: ${summarizeWindows(before)} → ${summarizeWindows(after)}`,
      ].join('\n'),
      appendReleaseHint: false,
    };
  }
