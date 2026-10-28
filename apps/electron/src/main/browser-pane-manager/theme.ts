import type { BrowserPaneManager } from '../browser-pane-manager.ts';
import { THEME_COLOR_SIGNAL_PREFIX, THEME_COLOR_NULL_SENTINEL, THEME_OBSERVER_MIN_INTERVAL_MS, EARLY_THEME_EXTRACTION_DELAY_MS, THEME_COLOR_EXTRACTOR_FN, TOOLBAR_CHANNELS } from './shared.ts';
import type { BrowserInstance } from './shared.ts';

/**
   * Extract a theme color from the page using Safari 26-style heuristics.
   * Priority: media-aware theme-color meta → elementsFromPoint (fixed/sticky headers) → body/html bg.
   * All colors pass through (including white/black) — contrast is handled by the renderer.
   * Guards against stale extraction (URL change during async executeJavaScript).
   */
export async function extractThemeColor(transportOwner: BrowserPaneManager, instance: BrowserInstance): Promise<void> {
    if (instance.themeColor)
        return; // already set by did-change-theme-color or observer
    const urlAtStart = instance.currentUrl;
    try {
        const color: unknown = await instance.pageView.webContents.executeJavaScript(`(${THEME_COLOR_EXTRACTOR_FN})()`);
        // Guard: if user navigated away during extraction, discard stale result
        if (instance.currentUrl !== urlAtStart)
            return;
        if (typeof color === 'string' && color.length > 0) {
            transportOwner.applyThemeColor(instance, color);
        }
    }
    catch {
        // page destroyed or JS error — ignore
    }
}

export function applyThemeColor(transportOwner: BrowserPaneManager, instance: BrowserInstance, color: string | null): void {
    if (instance.themeColor === color)
        return;
    instance.themeColor = color;
    if (!instance.window.isDestroyed() && !instance.toolbarView.webContents.isDestroyed()) {
        instance.toolbarView.webContents.send(TOOLBAR_CHANNELS.THEME_COLOR, color);
    }
    transportOwner["emitStateChange"](instance);
}

export function installThemeObserver(transportOwner: BrowserPaneManager, instance: BrowserInstance, allowRetry: boolean): void {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const urlAtInstall = instance.currentUrl;
    instance.themeObserverToken = token;
    void instance.pageView.webContents.executeJavaScript(`
      (() => {
        const token = ${JSON.stringify(token)};
        const prefix = ${JSON.stringify(THEME_COLOR_SIGNAL_PREFIX)} + token + ':';
        const nullSentinel = ${JSON.stringify(THEME_COLOR_NULL_SENTINEL)};
        const extractThemeColor = ${THEME_COLOR_EXTRACTOR_FN};

        const w = window;
        const previousCleanup = w.__CRAFT_THEME_OBSERVER_CLEANUP__;
        if (typeof previousCleanup === 'function') {
          try { previousCleanup(); } catch {}
        }

        let lastColor = '__unset__';
        let rafId = 0;
        let timerId = 0;
        let lastRunAt = 0;
        const minIntervalMs = ${THEME_OBSERVER_MIN_INTERVAL_MS};

        const clearScheduled = () => {
          if (timerId) {
            clearTimeout(timerId);
            timerId = 0;
          }
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
        };

        const emit = (color) => {
          const normalized = typeof color === 'string' && color.length > 0 ? color : null;
          if (normalized === lastColor) return;
          lastColor = normalized;
          console.info(prefix + (normalized ?? nullSentinel));
        };

        const run = () => {
          rafId = 0;
          lastRunAt = Date.now();
          try {
            emit(extractThemeColor());
          } catch {}
        };

        const schedule = () => {
          if (rafId || timerId) return;
          const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRunAt));
          if (waitMs > 0) {
            timerId = setTimeout(() => {
              timerId = 0;
              rafId = requestAnimationFrame(run);
            }, waitMs);
            return;
          }
          rafId = requestAnimationFrame(run);
        };

        const onScroll = () => schedule();
        const onResize = () => schedule();
        const onMutation = () => schedule();

        const headObserver = new MutationObserver(onMutation);
        if (document.head) {
          headObserver.observe(document.head, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['name', 'content', 'media'],
          });
        }

        const rootObserver = new MutationObserver(onMutation);
        if (document.documentElement) {
          rootObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }
        if (document.body) {
          rootObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }

        w.addEventListener('scroll', onScroll, { passive: true });
        w.addEventListener('resize', onResize, { passive: true });

        const mql = w.matchMedia('(prefers-color-scheme: dark)');
        const onSchemeChange = () => schedule();
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSchemeChange);
        else if (typeof mql.addListener === 'function') mql.addListener(onSchemeChange);

        w.__CRAFT_THEME_OBSERVER_CLEANUP__ = () => {
          headObserver.disconnect();
          rootObserver.disconnect();
          w.removeEventListener('scroll', onScroll);
          w.removeEventListener('resize', onResize);
          if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onSchemeChange);
          else if (typeof mql.removeListener === 'function') mql.removeListener(onSchemeChange);
          clearScheduled();
        };

        // Fast first color for initial toolbar paint and after SPA route changes
        schedule();
      })()
    `).catch(() => {
        if (!allowRetry)
            return;
        setTimeout(() => {
            if (!transportOwner["instances"].has(instance.id))
                return;
            if (instance.currentUrl !== urlAtInstall)
                return;
            if (instance.themeObserverToken !== token)
                return;
            transportOwner.installThemeObserver(instance, false);
        }, 120);
    });
}

export function scheduleEarlyThemeExtraction(transportOwner: BrowserPaneManager, instance: BrowserInstance, urlAtSchedule: string): void {
    setTimeout(() => {
        if (!transportOwner["instances"].has(instance.id))
            return;
        if (instance.currentUrl !== urlAtSchedule)
            return;
        void transportOwner.extractThemeColor(instance);
    }, EARLY_THEME_EXTRACTION_DELAY_MS);
}
