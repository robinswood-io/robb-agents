import type { BrowserLifecycleActionResult, BrowserPaneFns } from "../browser-tools.ts";

interface BrowserPageMetrics {
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  maxScrollX: number;
  maxScrollY: number;
  activeElementTag?: string;
  activeElementRole?: string;
  activeElementId?: string;
  activeElementName?: string;
}

export function formatNodeLine(
  node: {
    ref: string;
    role: string;
    name: string;
    value?: string;
    description?: string;
    focused?: boolean;
    checked?: boolean;
    disabled?: boolean;
  },
  options?: { includeState?: boolean },
): string {
  let line = `  ${node.ref} [${node.role}] "${node.name}"`;
  if (node.value !== undefined) line += ` value="${node.value}"`;
  if (options?.includeState !== false) {
    if (node.focused) line += ' (focused)';
    if (node.checked) line += ' (checked)';
    if (node.disabled) line += ' (disabled)';
  }
  if (node.description) line += ` — ${node.description}`;
  return line;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function shortText(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

export function statusBucket(status: number): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

async function safeEvaluate<T>(fns: BrowserPaneFns, expression: string): Promise<T | null> {
  try {
    const value = await fns.evaluate(expression);
    return value as T;
  } catch {
    return null;
  }
}

export async function getPageMetrics(fns: BrowserPaneFns): Promise<BrowserPageMetrics | null> {
  return safeEvaluate<BrowserPageMetrics>(
    fns,
    `(() => {
      const doc = document.documentElement;
      const body = document.body;
      const scrollWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0, window.innerWidth || 0);
      const scrollHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0, window.innerHeight || 0);
      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      const scrollX = window.scrollX || window.pageXOffset || 0;
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const active = document.activeElement;
      return {
        url: window.location.href,
        title: document.title || '',
        viewportWidth,
        viewportHeight,
        documentWidth: scrollWidth,
        documentHeight: scrollHeight,
        scrollX,
        scrollY,
        maxScrollX: Math.max(0, scrollWidth - viewportWidth),
        maxScrollY: Math.max(0, scrollHeight - viewportHeight),
        activeElementTag: active?.tagName?.toLowerCase() || '',
        activeElementRole: active?.getAttribute?.('role') || '',
        activeElementId: active?.id || '',
        activeElementName: active?.getAttribute?.('name') || active?.getAttribute?.('aria-label') || active?.textContent?.trim?.().slice(0, 80) || '',
      };
    })()`
  );
}

export function describeActive(metrics: BrowserPageMetrics | null): string {
  if (!metrics) return 'unknown';
  const tag = metrics.activeElementTag || 'unknown';
  const id = metrics.activeElementId ? `#${metrics.activeElementId}` : '';
  const role = metrics.activeElementRole ? ` role=${metrics.activeElementRole}` : '';
  const name = metrics.activeElementName ? ` "${shortText(metrics.activeElementName, 60)}"` : '';
  return `${tag}${id}${role}${name}`;
}

const ACTIONABLE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'slider',
  'spinbutton',
  'listbox',
]);

export function countActionableNodes(nodes: Array<{ role: string; disabled?: boolean }>): number {
  return nodes.filter((node) => ACTIONABLE_AX_ROLES.has((node.role || '').toLowerCase()) && !node.disabled).length;
}

export function summarizeWindows(windows: Awaited<ReturnType<BrowserPaneFns['listWindows']>>): string {
  const visible = windows.filter((w) => w.isVisible).length;
  const locked = windows.filter((w) => !!w.boundSessionId).length;
  const withOverlay = windows.filter((w) => !!w.agentControlActive).length;
  return `total=${windows.length}, visible=${visible}, locked=${locked}, overlays=${withOverlay}`;
}

function getOpenVisibilitySettleTimeoutMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(100, override);
  }
  const envValue = Number(process.env["CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS"]);
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.max(100, envValue);
  }
  return 1500;
}

function getOpenVisibilitySettlePollMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(25, override);
  }
  const envValue = Number(process.env["CRAFT_BROWSER_OPEN_SETTLE_POLL_MS"]);
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.max(25, envValue);
  }
  return 100;
}

export async function waitForForegroundOpenVisibility(args: {
  fns: BrowserPaneFns;
  instanceId: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{
  windows: Awaited<ReturnType<BrowserPaneFns['listWindows']>>;
  win: Awaited<ReturnType<BrowserPaneFns['listWindows']>>[number] | undefined;
  settledByWait: boolean;
  usedFocusFallback: boolean;
}> {
  const timeoutMs = getOpenVisibilitySettleTimeoutMs(args.timeoutMs);
  const pollMs = getOpenVisibilitySettlePollMs(args.pollMs);
  const started = Date.now();

  const readWindowState = async () => {
    const windows = await args.fns.listWindows();
    const win = windows.find((w) => w.id === args.instanceId);
    return { windows, win };
  };

  let state = await readWindowState();
  while (Date.now() - started < timeoutMs) {
    if (!state.win || state.win.isVisible) {
      return {
        ...state,
        settledByWait: true,
        usedFocusFallback: false,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    state = await readWindowState();
  }

  let usedFocusFallback = false;
  if (state.win && !state.win.isVisible) {
    try {
      await args.fns.focusWindow(args.instanceId);
      usedFocusFallback = true;
      state = await readWindowState();
    } catch {
      // Keep existing state if focus fallback fails; caller output will surface visibility.
    }
  }

  return {
    ...state,
    settledByWait: false,
    usedFocusFallback,
  };
}

export function formatLifecycleResultLine(result: BrowserLifecycleActionResult): string {
  if (result.action === 'noop') {
    return [
      'No window state changed.',
      result.reason ? `Reason: ${result.reason}` : undefined,
      result.requestedInstanceId ? `Requested window: ${result.requestedInstanceId}` : undefined,
    ].filter(Boolean).join(' ');
  }

  const affected = result.affectedIds.length > 0 ? result.affectedIds.join(', ') : 'none';
  const resolved = result.resolvedInstanceId ?? 'none';
  return [
    `Action: ${result.action}`,
    `resolved=${resolved}`,
    `affected=[${affected}]`,
    result.requestedInstanceId ? `requested=${result.requestedInstanceId}` : undefined,
  ].filter(Boolean).join(', ');
}
