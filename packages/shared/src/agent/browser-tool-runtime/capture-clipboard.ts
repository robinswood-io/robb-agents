import type { BrowserPaneFns, BrowserScreenshotRegionArgs } from "../browser-tools.ts";
import type { BrowserCommandExecutionArgs, BrowserCommandResult } from './contracts.ts';
import { formatBytes } from './page-summary.ts';

export async function executeSetClipboardBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const text = parts.slice(1).join(' ');
    if (!text) throw new Error('set-clipboard requires text. Example: set-clipboard Hello World');
    await fns.setClipboard(text);

    const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    const tabCount = (text.match(/\t/g) ?? []).length;

    return {
      output: [
        `Clipboard set (${text.length} characters)`,
        `Lines: ${lineCount}, tabs: ${tabCount}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeGetClipboardBrowserCommand(fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const text = await fns.getClipboard();
    if (!text) {
      return { output: '(empty clipboard)', appendReleaseHint: true };
    }

    const lineCount = text.split(/\r?\n/).length;
    const tabCount = (text.match(/\t/g) ?? []).length;
    const preview = text.length > 800 ? `${text.slice(0, 800)}\n... (truncated preview)` : text;

    return {
      output: [
        `Clipboard content (${text.length} chars, ${lineCount} lines, ${tabCount} tabs):`,
        preview,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executePasteBrowserCommand(parts: string[], fns: BrowserPaneFns, args: BrowserCommandExecutionArgs): Promise<BrowserCommandResult> {
    const text = parts.slice(1).join(' ');
    if (!text) throw new Error('paste requires text. Example: paste Hello World');
    await fns.setClipboard(text);
    const platform = args.platform ?? process.platform;
    const isMac = platform === 'darwin';
    await fns.sendKey({ key: 'v', modifiers: [isMac ? 'meta' : 'control'] });

    const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    const tabCount = (text.match(/\t/g) ?? []).length;

    return {
      output: [
        `Clipboard write confirmed; paste shortcut dispatched for ${text.length} characters (page/remote receipt not verified)`,
        `Shortcut used: ${isMac ? 'Cmd+V' : 'Ctrl+V'}`,
        `Lines: ${lineCount}, tabs: ${tabCount}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeScreenshotBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const annotate = parts.includes('--annotated') || parts.includes('-a');
    const usePng = parts.includes('--png');
    const format = usePng ? 'png' as const : 'jpeg' as const;

    const started = Date.now();
    const result = await fns.screenshot({ annotate, format });
    const elapsedMs = Date.now() - started;
    const buf = result.imageBuffer;
    const base64 = buf.toString('base64');
    if (!buf || buf.length === 0 || !base64) {
      throw new Error('Screenshot capture returned empty image data. Try waiting for page load (browser_tool wait network-idle), then retry browser_tool screenshot.');
    }

    const ext = result.imageFormat === 'jpeg' ? 'JPG' : 'PNG';
    const mimeType = result.imageFormat === 'jpeg' ? 'image/jpeg' as const : 'image/png' as const;
    const lines = [
      annotate
        ? `Annotated screenshot captured (${formatBytes(buf.length)} ${ext}) — element refs (@eN) are overlaid on interactive elements`
        : `Screenshot captured (${formatBytes(buf.length)} ${ext})`,
      `Capture time: ${elapsedMs}ms`,
    ];
    const metadata = result.metadata as Record<string, unknown> | undefined;
    const viewport = metadata?.viewport as { width?: number; height?: number; dpr?: number } | undefined;
    if (viewport?.width && viewport?.height) {
      lines.push(`Viewport: ${viewport.width}x${viewport.height} @ DPR ${viewport.dpr ?? 1}`);
    }
    const targets = (metadata?.targets as Array<unknown> | undefined)?.length;
    if (typeof targets === 'number') {
      lines.push(`Annotated targets: ${targets}`);
    }
    if (result.metadata) {
      lines.push('', 'Metadata:', JSON.stringify(result.metadata, null, 2));
    }

    return {
      output: lines.join('\n'),
      appendReleaseHint: true,
      image: {
        data: base64,
        mimeType,
        sizeBytes: buf.length,
      },
    };
  }

export async function executeScreenshotRegionBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const rest = parts.slice(1);
    if (rest.length === 0) {
      throw new Error('screenshot-region requires either coordinates, --ref, or --selector.');
    }

    const canvasMode = rest.includes('--canvas');
    if (canvasMode) {
      const tokens = rest.filter(t => t !== '--canvas' && t !== '--png');
      if (rest.filter(t => t === '--canvas').length !== 1 || tokens.length !== 2 || tokens[0] !== '--selector' || !tokens[1]?.trim()) {
        throw new Error('Canvas capture requires --canvas --selector <one unique canvas selector>, with no coordinates, ref, padding or other options. Use array input for selectors containing spaces.');
      }
      const result = await fns.screenshotRegion({ source: 'canvas', selector: tokens[1], format: 'png' });
      const buf = result.imageBuffer;
      if (!buf?.length || buf.length > 4 * 1024 * 1024 || result.imageFormat !== 'png' || result.metadata?.source !== 'canvas-bitmap') {
        throw new Error('Canvas capture returned an invalid, empty or oversized image receipt. No page screenshot was substituted.');
      }
      return {
        output: ['Canvas bitmap captured (visible rectangular crop; intrinsic pixels).',
          'This is not a composited page screenshot: DOM overlays, other layers and CSS effects are excluded. It does not certify remote execution or a fresh application repaint.',
          `PNG: ${formatBytes(buf.length)}`, 'Metadata:', JSON.stringify(result.metadata, null, 2)].join('\n'),
        appendReleaseHint: true,
        image: { data: buf.toString('base64'), mimeType: 'image/png', sizeBytes: buf.length },
      };
    }
    const usePng = rest.includes('--png');
    const format = usePng ? 'png' as const : 'jpeg' as const;
    const filteredRest = rest.filter((t) => t !== '--png');

    const parsePadding = (tokens: string[]) => {
      const idx = tokens.findIndex((t) => t === '--padding');
      if (idx === -1) return { padding: undefined as number | undefined, cleaned: tokens };
      const raw = tokens[idx + 1];
      if (!raw) throw new Error('Missing value for --padding');
      const padding = Number(raw);
      if (Number.isNaN(padding)) throw new Error(`Invalid padding "${raw}". Expected a number.`);
      const cleaned = [...tokens.slice(0, idx), ...tokens.slice(idx + 2)];
      return { padding, cleaned };
    };

    const { padding, cleaned } = parsePadding(filteredRest);

    let screenshotArgs: BrowserScreenshotRegionArgs;
    let targetDescription = '';
    if (cleaned[0] === '--ref') {
      const ref = cleaned[1];
      if (!ref) throw new Error('screenshot-region --ref requires a ref value.');
      screenshotArgs = { ref, padding, format };
      targetDescription = `ref ${ref}`;
    } else if (cleaned[0] === '--selector') {
      const selector = cleaned.slice(1).join(' ').trim();
      if (!selector) throw new Error('screenshot-region --selector requires a CSS selector value.');
      screenshotArgs = { selector, padding, format };
      targetDescription = `selector ${selector}`;
    } else {
      if (cleaned.length < 4) {
        throw new Error('screenshot-region coordinates require: x y width height');
      }
      const [xRaw, yRaw, widthRaw, heightRaw] = cleaned;
      const x = Number(xRaw);
      const y = Number(yRaw);
      const width = Number(widthRaw);
      const height = Number(heightRaw);
      if ([x, y, width, height].some((n) => Number.isNaN(n))) {
        throw new Error('screenshot-region coordinates must be numbers.');
      }
      screenshotArgs = { x, y, width, height, padding, format };
      targetDescription = `box (${x}, ${y}, ${width}x${height})`;
    }

    const started = Date.now();
    const result = await fns.screenshotRegion(screenshotArgs);
    const elapsedMs = Date.now() - started;
    const buf = result.imageBuffer;
    const base64 = buf.toString('base64');
    if (!buf || buf.length === 0 || !base64) {
      throw new Error('Region screenshot capture returned empty image data. Try adjusting the region/selector or waiting for page load, then retry browser_tool screenshot-region.');
    }

    const ext = result.imageFormat === 'jpeg' ? 'JPG' : 'PNG';
    const mimeType = result.imageFormat === 'jpeg' ? 'image/jpeg' as const : 'image/png' as const;
    const lines = [
      `Region screenshot captured (${formatBytes(buf.length)} ${ext})`,
      `Target: ${targetDescription}${typeof padding === 'number' ? `, padding=${padding}` : ''}`,
      `Capture time: ${elapsedMs}ms`,
    ];
    if (result.metadata) {
      lines.push('', 'Metadata:', JSON.stringify(result.metadata, null, 2));
    }

    return {
      output: lines.join('\n'),
      appendReleaseHint: true,
      image: {
        data: base64,
        mimeType,
        sizeBytes: buf.length,
      },
    };
  }
