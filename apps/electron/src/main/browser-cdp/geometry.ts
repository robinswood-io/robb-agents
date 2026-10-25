import type { BrowserCDP } from '../browser-cdp.ts';
import type { SelectorGeometryReceipt } from './protocol.ts';
import type { ElementGeometry, ViewportMetrics } from './shared.ts';

export async function getElementGeometry(transportOwner: BrowserCDP, ref: string): Promise<ElementGeometry> {
    const backendNodeId = transportOwner["refMap"].get(ref);
    if (!backendNodeId) {
        throw new Error(`Element ${ref} not found. Run browser_snapshot first to get current element refs.`);
    }
    const { model } = await transportOwner["send"]('DOM.getBoxModel', { backendNodeId });
    const content = model.content as number[];
    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const clickX = (content[0] + content[2] + content[4] + content[6]) / 4;
    const clickY = (content[1] + content[3] + content[5] + content[7]) / 4;
    const details = transportOwner["refDetails"].get(ref);
    return {
        ref,
        role: details?.role,
        name: details?.name,
        box: {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
        },
        clickPoint: { x: clickX, y: clickY },
    };
}

export async function getElementGeometryBySelector(transportOwner: BrowserCDP, selector: string): Promise<ElementGeometry> {
    const result = await transportOwner["send"]('Runtime.evaluate', {
        expression: `(() => {
        const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        if (candidates.length === 0) return null;

        const isVisible = (el) => {
          if (!(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          if (Number(style.opacity || '1') === 0) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          return true;
        };

        const el = candidates.find(isVisible) || candidates[0];
        const rect = el.getBoundingClientRect();
        const tag = (el.tagName && typeof el.tagName === 'string') ? el.tagName.toLowerCase() : 'element';
        const text = (typeof el.textContent === 'string') ? el.textContent.slice(0, 120) : '';
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          cx: rect.left + rect.width / 2,
          cy: rect.top + rect.height / 2,
          tag,
          text,
        };
      })()`,
        returnByValue: true,
    });
    const value = result?.result?.value as SelectorGeometryReceipt | null | undefined;
    if (!value) {
        throw new Error(`No element found for selector "${selector}"`);
    }
    if (Number(value.width) <= 0 || Number(value.height) <= 0) {
        throw new Error(`Element found for selector "${selector}" has zero size`);
    }
    return {
        ref: `selector:${selector}`,
        role: String(value.tag || 'element'),
        name: String(value.text || '').trim(),
        box: {
            x: Number(value.x),
            y: Number(value.y),
            width: Number(value.width),
            height: Number(value.height),
        },
        clickPoint: {
            x: Number(value.cx),
            y: Number(value.cy),
        },
    };
}

export async function getViewportMetrics(transportOwner: BrowserCDP): Promise<ViewportMetrics> {
    const result = await transportOwner["send"]('Runtime.evaluate', {
        expression: `(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0
      }))()`,
        returnByValue: true,
    });
    const v = (result?.result?.value as Partial<ViewportMetrics> | undefined) ?? {};
    return {
        width: Number(v.width || 0),
        height: Number(v.height || 0),
        dpr: Number(v.dpr || 1),
        scrollX: Number(v.scrollX || 0),
        scrollY: Number(v.scrollY || 0),
    };
}

export async function renderTemporaryOverlay(transportOwner: BrowserCDP, params: {
    geometries: ElementGeometry[];
    includeMetadata?: boolean;
    metadataText?: string;
    includeClickPoints?: boolean;
}): Promise<void> {
    const payload = {
        geometries: params.geometries,
        includeMetadata: !!params.includeMetadata,
        metadataText: params.metadataText || '',
        includeClickPoints: params.includeClickPoints !== false,
    };
    await transportOwner["send"]('Runtime.evaluate', {
        expression: `(() => {
        const existing = document.getElementById('__craft_agent_screenshot_overlay__');
        if (existing) existing.remove();

        const root = document.createElement('div');
        root.id = '__craft_agent_screenshot_overlay__';
        root.style.position = 'fixed';
        root.style.inset = '0';
        root.style.pointerEvents = 'none';
        root.style.zIndex = '2147483647';

        const payload = ${JSON.stringify(payload)};

        for (const g of payload.geometries || []) {
          const box = document.createElement('div');
          box.style.position = 'fixed';
          box.style.left = g.box.x + 'px';
          box.style.top = g.box.y + 'px';
          box.style.width = g.box.width + 'px';
          box.style.height = g.box.height + 'px';
          box.style.border = '2px solid rgba(59, 130, 246, 0.95)';
          box.style.borderRadius = '6px';

          root.appendChild(box);

          const label = document.createElement('div');
          label.style.position = 'fixed';
          label.style.left = g.box.x + 'px';
          label.style.top = Math.max(4, g.box.y - 24) + 'px';
          label.style.padding = '2px 6px';
          label.style.borderRadius = '6px';
          label.style.font = '12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
          label.style.background = 'rgba(15, 23, 42, 0.92)';
          label.style.color = 'white';
          label.style.maxWidth = '70vw';
          label.style.whiteSpace = 'nowrap';
          label.style.overflow = 'hidden';
          label.style.textOverflow = 'ellipsis';
          const labelText = [g.ref, g.role, g.name].filter(Boolean).join(' • ');
          label.textContent = labelText;
          root.appendChild(label);

          if (payload.includeClickPoints && g.clickPoint) {
            const point = document.createElement('div');
            point.style.position = 'fixed';
            point.style.left = (g.clickPoint.x - 4) + 'px';
            point.style.top = (g.clickPoint.y - 4) + 'px';
            point.style.width = '8px';
            point.style.height = '8px';
            point.style.borderRadius = '999px';
            point.style.background = 'rgba(239, 68, 68, 0.98)';

            root.appendChild(point);
          }
        }

        if (payload.includeMetadata && payload.metadataText) {
          const meta = document.createElement('div');
          meta.style.position = 'fixed';
          meta.style.right = '8px';
          meta.style.bottom = '8px';
          meta.style.padding = '4px 8px';
          meta.style.borderRadius = '6px';
          meta.style.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
          meta.style.background = 'rgba(15, 23, 42, 0.92)';
          meta.style.color = 'white';
          meta.textContent = payload.metadataText;
          root.appendChild(meta);
        }

        document.documentElement.appendChild(root);
      })()`,
    });
}

export async function clearTemporaryOverlay(transportOwner: BrowserCDP): Promise<void> {
    await transportOwner["send"]('Runtime.evaluate', {
        expression: `(() => {
        const existing = document.getElementById('__craft_agent_screenshot_overlay__');
        if (existing) existing.remove();
      })()`,
    });
}
