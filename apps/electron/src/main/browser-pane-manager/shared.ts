import { BrowserWindow, WebContentsView } from "electron";
import { BrowserCDP, type ElementGeometry } from "../browser-cdp";

export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

export const TOOLBAR_LOAD_MAX_RETRIES = 4;

export const TOOLBAR_LOAD_RETRY_DELAY_MS = 500;

export const TOOLBAR_HEIGHT = 48;

export const MAX_CONSOLE_LOG_ENTRIES = 500;

export const MAX_NETWORK_LOG_ENTRIES = 500;

export const MAX_DOWNLOAD_LOG_ENTRIES = 200;

export const DEFAULT_WAIT_TIMEOUT_MS = 10000;

export const POLICY_MUTATION_CAPABILITY_METHODS = new Set([
    'clickElement',
    'clickAtCoordinates',
    'drag',
    'fillElement',
    'typeText',
    'selectOption',
    'sendKey',
    'evaluate',
    'setClipboard',
]);

export const DEFAULT_WAIT_POLL_MS = 100;

export const SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS = 3;

export const SCREENSHOT_RETRY_DELAY_MS = 120;

export const SCREENSHOT_RESCUE_PAINT_DELAY_MS = 180;

export const SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS = 1000;

export const SCREENSHOT_NETWORK_IDLE_MS = 300;

export const THEME_COLOR_SIGNAL_PREFIX = '__craft_theme_color__:';

export const THEME_COLOR_NULL_SENTINEL = '__NULL__';

export const THEME_OBSERVER_MIN_INTERVAL_MS = 120;

export const EARLY_THEME_EXTRACTION_DELAY_MS = 100;

export const BROWSER_EMPTY_STATE_PAGE = 'browser-empty-state.html';

export const CRAFT_DEEPLINK_SCHEME_PREFIX = `${process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'}://`;

export const THEME_COLOR_EXTRACTOR_FN = String.raw `
() => {
  const toHex = (r, g, b) => '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');

  const parseColor = (str) => {
    if (!str) return null;
    str = str.trim();
    const hm = /^#([0-9a-f]{3,8})$/i.exec(str);
    if (hm) {
      const h = hm[1];
      let r, g, b;
      if (h.length === 3) { r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16); }
      else if (h.length >= 6) { r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16); }
      else return null;
      return toHex(r, g, b);
    }
    const rm = str.match(/rgba?[\(]\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (rm) return toHex(+rm[1], +rm[2], +rm[3]);
    return null;
  };

  const parseBg = (el) => {
    if (!el) return null;
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return null;
    return parseColor(bg);
  };

  // 1. theme-color meta — respect media attribute for light/dark
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  for (const m of metas) {
    const media = m.getAttribute('media');
    if (media && !window.matchMedia(media).matches) continue;
    const c = parseColor(m.content);
    if (c) return c;
  }

  // 2. Safari-like approach: sample fixed/sticky elements at viewport top-center
  const els = document.elementsFromPoint(window.innerWidth / 2, 4);
  for (const el of els) {
    if (el === document.documentElement || el === document.body) continue;
    const style = getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.8) continue;
    const c = parseBg(el);
    if (c) return c;
  }

  // 3. Fallback: body then html
  return parseBg(document.body) || parseBg(document.documentElement) || null;
}
`;

/** IPC channels for the browser toolbar preload */
export const TOOLBAR_CHANNELS = {
    NAVIGATE: 'browser-toolbar:navigate',
    GO_BACK: 'browser-toolbar:go-back',
    GO_FORWARD: 'browser-toolbar:go-forward',
    RELOAD: 'browser-toolbar:reload',
    STOP: 'browser-toolbar:stop',
    MENU_GEOMETRY: 'browser-toolbar:menu-geometry',
    FORCE_CLOSE_MENU: 'browser-toolbar:force-close-menu',
    HIDE: 'browser-toolbar:hide',
    DESTROY: 'browser-toolbar:destroy',
    STATE_UPDATE: 'browser-toolbar:state-update',
    THEME_COLOR: 'browser-toolbar:theme-color',
} as const;

export const BROWSER_PANE_SESSION_PARTITION = 'persist:browser-pane';

export const SESSION_PARTITION = BROWSER_PANE_SESSION_PARTITION;

export interface AgentControlState {
    active: boolean;
    sessionId: string;
    displayName?: string;
    intent?: string;
}

export interface AgentControlLockState {
    active: boolean;
    previousResizable: boolean;
}

export interface BrowserInstance {
    id: string;
    window: BrowserWindow;
    toolbarView: WebContentsView;
    pageView: WebContentsView;
    /** Native wrappers may already be gone when Electron emits shutdown events. */
    pageWebContentsId: number;
    nativeOverlayView: WebContentsView;
    cdp: BrowserCDP;
    currentUrl: string;
    title: string;
    favicon: string | null;
    isLoading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    boundSessionId: string | null;
    ownerType: 'session' | 'manual';
    ownerSessionId: string | null;
    /**
     * Workspace this instance is associated with, or `null` for unbound manual
     * windows. Renderers in other workspaces filter such entries out of the tab
     * strip / status badge. Stamped at create-time (or first bind) — once non-null,
     * subsequent rebinds may overwrite it with the new binder's workspace.
     */
    workspaceId: string | null;
    isVisible: boolean;
    isHiding: boolean;
    keepAliveOnWindowClose: boolean;
    toolbarReady: boolean;
    toolbarMenuOpen: boolean;
    toolbarMenuHeight: number;
    toolbarMenuOverlayActive: boolean;
    showOnCreate: boolean;
    pendingShowOnReady: boolean;
    pendingShowToken: number;
    lastAction: LastBrowserAction | null;
    agentControl: AgentControlState | null;
    lockState: AgentControlLockState;
    nativeOverlayReady: boolean;
    themeColor: string | null;
    inPageThemeTimer: ReturnType<typeof setTimeout> | null;
    themeObserverToken: string | null;
    consoleLogs: BrowserConsoleEntry[];
    networkLogs: BrowserNetworkEntry[];
    downloads: BrowserDownloadEntry[];
    lastLaunchToken: string | null;
}

export interface CreateBrowserInstanceOptions {
    show?: boolean;
    ownerType?: 'session' | 'manual';
    ownerSessionId?: string;
    workspaceId?: string | null;
}

export interface BrowserPanePermissionAutonomyState {
    permissionMode?: string;
    externalActionPolicy?: string;
}

export type BrowserPanePermissionAutonomyResolver = (input: {
    sessionId: string;
    workspaceId: string;
}) => BrowserPanePermissionAutonomyState | null;

export interface BrowserScreenshotOptions {
    mode?: 'raw' | 'agent';
    refs?: string[];
    includeLastAction?: boolean;
    includeMetadata?: boolean;
    /** Annotate screenshot with @eN labels on all interactive elements from accessibility tree */
    annotate?: boolean;
    format?: 'png' | 'jpeg';
    jpegQuality?: number;
}

export interface BrowserConsoleEntry {
    timestamp: number;
    level: 'log' | 'info' | 'warn' | 'error';
    message: string;
}

export interface BrowserConsoleOptions {
    level?: 'all' | BrowserConsoleEntry['level'];
    limit?: number;
}

export interface BrowserScreenshotRegionTarget {
    source?: 'canvas';
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    ref?: string;
    selector?: string;
    padding?: number;
    format?: 'png' | 'jpeg';
    jpegQuality?: number;
}

export interface BrowserNetworkEntry {
    timestamp: number;
    method: string;
    url: string;
    status: number;
    resourceType: string;
    ok: boolean;
}

export interface BrowserNetworkOptions {
    limit?: number;
    status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx';
    method?: string;
    resourceType?: string;
}

export interface BrowserWaitArgs {
    kind: 'selector' | 'text' | 'url' | 'network-idle' | 'challenge-clear';
    value?: string;
    timeoutMs?: number;
    pollMs?: number;
    idleMs?: number;
}

export interface BrowserWaitResult {
    ok: true;
    kind: BrowserWaitArgs['kind'];
    elapsedMs: number;
    detail: string;
}

export interface BrowserKeyArgs {
    /** Explicit printable keyboard text (type-keys), never a clipboard operation. */
    text?: string;
    key: string;
    modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>;
}

export interface BrowserDownloadEntry {
    id: string;
    timestamp: number;
    url: string;
    filename: string;
    state: 'started' | 'completed' | 'interrupted' | 'cancelled';
    bytesReceived: number;
    totalBytes: number;
    mimeType: string;
    savePath?: string;
}

export interface BrowserDownloadOptions {
    action?: 'list' | 'wait';
    limit?: number;
    timeoutMs?: number;
}

export interface BrowserScreenshotResult {
    imageBuffer: Buffer;
    imageFormat: 'png' | 'jpeg';
    metadata?: {
        mode: 'raw' | 'agent' | 'canvas';
        source?: 'canvas-bitmap';
        canvasBox?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        sourceRect?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        intrinsicSize?: {
            width: number;
            height: number;
        };
        capturedAt?: number;
        imageToViewport?: {
            x: number;
            y: number;
            scaleX: number;
            scaleY: number;
        };
        viewport?: {
            width: number;
            height: number;
            dpr: number;
            scrollX: number;
            scrollY: number;
        };
        targets?: Array<{
            ref: string;
            role?: string;
            name?: string;
            box: {
                x: number;
                y: number;
                width: number;
                height: number;
            };
            clickPoint: {
                x: number;
                y: number;
            };
        }>;
        action?: {
            tool: string;
            ref?: string;
            status: 'succeeded' | 'failed';
            timestamp: number;
        };
        annotationPartial?: boolean;
        warnings?: string[];
        region?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        targetMode?: 'coords' | 'ref' | 'selector';
    };
}

export interface LastBrowserAction {
    tool: string;
    ref?: string;
    status: 'succeeded' | 'failed';
    geometry?: ElementGeometry;
    timestamp: number;
}
