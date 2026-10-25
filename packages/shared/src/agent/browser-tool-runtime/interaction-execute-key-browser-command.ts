import type { BrowserPaneFns } from "../browser-tools.ts";
import type { BrowserCommandResult } from './contracts.ts';
import { describeActive, getPageMetrics } from './page-summary.ts';

export async function executeKeyBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const key = parts[1];
    if (!key) throw new Error('key requires key value. Example: key Enter');
    const modifiers = (parts[2] ? parts[2].split('+') : []) as Array<'shift' | 'control' | 'alt' | 'meta'>;
    for (const m of modifiers) {
      if (!['shift', 'control', 'alt', 'meta'].includes(m)) {
        throw new Error(`Invalid key modifier "${m}". Use shift|control|alt|meta`);
      }
    }

    const before = await getPageMetrics(fns);
    await fns.sendKey({ key, modifiers });
    const after = await getPageMetrics(fns);

    return {
      output: [
        `Key sent: ${key}${modifiers.length ? ` (${modifiers.join('+')})` : ''}`,
        `Active element before: ${describeActive(before)}`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeScrollBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const direction = parts[1] as 'up' | 'down' | 'left' | 'right' | undefined;
    const amountRaw = parts[2];
    if (!direction || !['up', 'down', 'left', 'right'].includes(direction)) {
      throw new Error('scroll requires direction up|down|left|right. Example: scroll down 800');
    }
    const amount = amountRaw ? Number(amountRaw) : undefined;
    if (amountRaw && Number.isNaN(amount)) {
      throw new Error(`Invalid scroll amount "${amountRaw}". Expected a number.`);
    }

    const requested = amount ?? 500;
    const before = await getPageMetrics(fns);
    await fns.scroll(direction, amount);
    const after = await getPageMetrics(fns);

    if (!before || !after) {
      return { output: `Scrolled ${direction} by ${requested}px`, appendReleaseHint: true };
    }

    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
    const beforePos = axis === 'x' ? before.scrollX : before.scrollY;
    const afterPos = axis === 'x' ? after.scrollX : after.scrollY;
    const delta = Math.round(afterPos - beforePos);
    const max = axis === 'x' ? after.maxScrollX : after.maxScrollY;
    const progress = max > 0 ? `${((afterPos / max) * 100).toFixed(1)}%` : '0.0%';
    const atEdge = axis === 'x'
      ? (after.scrollX <= 0 || after.scrollX >= after.maxScrollX)
      : (after.scrollY <= 0 || after.scrollY >= after.maxScrollY);

    const lines = [
      `Scrolled ${direction} by ${requested}px (actual ${delta >= 0 ? '+' : ''}${delta}px)`,
      `${axis.toUpperCase()}: ${Math.round(beforePos)} → ${Math.round(afterPos)} / ${Math.round(max)} (${progress})`,
      `Viewport: ${after.viewportWidth}x${after.viewportHeight}, document: ${after.documentWidth}x${after.documentHeight}`,
      `Reached edge: ${atEdge}`,
    ];

    return { output: lines.join('\n'), appendReleaseHint: true };
  }
