import type { BrowserPaneFns } from "../browser-tools.ts";
import type { BrowserCommandResult } from './contracts.ts';
import { boundedBrowserCommandTimeout } from './execution-timeout.ts';
import { describeActive, getPageMetrics } from './page-summary.ts';

interface ParsedSelectCommand {
  ref: string;
  value: string;
  assertText?: string;
  assertValue?: string;
  timeoutMs: number;
}

function parseSelectCommand(parts: string[]): ParsedSelectCommand {
  const ref = parts[1];
  if (!ref) throw new Error('select requires ref and value. Example: select @e3 optionValue');

  const tokens = parts.slice(2);
  const valueTokens: string[] = [];
  let assertText: string | undefined;
  let assertValue: string | undefined;
  let timeoutMs = 2000;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '--assert-text') {
      const next = tokens[i + 1];
      if (!next) throw new Error('select --assert-text requires a value. Example: select @e3 CNAME --assert-text Target');
      assertText = next;
      i += 1;
      continue;
    }
    if (token === '--assert-value') {
      const next = tokens[i + 1];
      if (!next) throw new Error('select --assert-value requires a value. Example: select @e3 CNAME --assert-value CNAME');
      assertValue = next;
      i += 1;
      continue;
    }
    if (token === '--timeout') {
      const next = tokens[i + 1];
      if (!next) throw new Error('select --timeout requires milliseconds. Example: select @e3 CNAME --timeout 3000');
      timeoutMs = boundedBrowserCommandTimeout(next, 'select');
      i += 1;
      continue;
    }
    valueTokens.push(token);
  }

  const value = valueTokens.join(' ').trim();
  if (!value) throw new Error('select requires ref and value. Example: select @e3 optionValue');

  return { ref, value, assertText, assertValue, timeoutMs };
}

function includesNormalized(haystack: string | undefined, needle: string): boolean {
  const h = (haystack ?? '').trim().toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!h || !n) return false;
  return h.includes(n);
}

async function verifySelectResult(args: {
  fns: BrowserPaneFns;
  ref: string;
  selectedValue: string;
  assertText?: string;
  assertValue?: string;
  timeoutMs: number;
}): Promise<{
  selectedRefMatched: boolean;
  assertTextMatched: boolean;
  assertValueMatched: boolean;
  elapsedMs: number;
}> {
  const { fns, ref, selectedValue, assertText, assertValue, timeoutMs } = args;
  const started = Date.now();
  const pollMs = 120;

  let selectedRefMatched = false;
  let assertTextMatched = false;
  let assertValueMatched = false;

  while (Date.now() - started <= timeoutMs) {
    const snapshot = await fns.snapshot();
    const selectedNode = snapshot.nodes.find((n) => n.ref === ref);

    selectedRefMatched = !!selectedNode
      && (
        includesNormalized(selectedNode.value, selectedValue)
        || includesNormalized(selectedNode.name, selectedValue)
      );

    if (assertText) {
      assertTextMatched = snapshot.nodes.some((n) =>
        includesNormalized(n.name, assertText)
        || includesNormalized(n.value, assertText)
        || includesNormalized(n.description, assertText)
      );
    } else {
      assertTextMatched = true;
    }

    if (assertValue) {
      const selectedNodeMatches = !!selectedNode
        && (
          includesNormalized(selectedNode.value, assertValue)
          || includesNormalized(selectedNode.name, assertValue)
          || includesNormalized(selectedNode.description, assertValue)
        );

      const anyNodeMatches = snapshot.nodes.some((n) =>
        includesNormalized(n.value, assertValue)
        || includesNormalized(n.name, assertValue)
        || includesNormalized(n.description, assertValue)
      );

      assertValueMatched = selectedNodeMatches || anyNodeMatches;
    } else {
      assertValueMatched = true;
    }

    const strongMatch = selectedRefMatched || assertValueMatched;
    const assertionsOk = assertTextMatched && assertValueMatched;
    if (strongMatch && assertionsOk) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return {
    selectedRefMatched,
    assertTextMatched,
    assertValueMatched,
    elapsedMs: Date.now() - started,
  };
}

export async function executeClickBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const ref = parts[1];
    if (!ref) throw new Error('click requires a ref. Example: click @e1');
    const waitForRaw = parts[2] as 'none' | 'navigation' | 'network-idle' | undefined;
    const timeoutRaw = parts[3];
    const waitFor = waitForRaw && ['none', 'navigation', 'network-idle'].includes(waitForRaw)
      ? waitForRaw
      : undefined;
    if (waitForRaw && !waitFor) {
      throw new Error('click waitFor must be one of: none, navigation, network-idle');
    }
    const timeoutMs = timeoutRaw ? boundedBrowserCommandTimeout(timeoutRaw, 'click') : undefined;

    const before = await getPageMetrics(fns);
    const started = Date.now();
    await fns.click(ref, { waitFor, timeoutMs });
    const elapsedMs = Date.now() - started;
    const [after, challenge] = await Promise.all([
      getPageMetrics(fns),
      fns.detectChallenge(),
    ]);

    const urlChanged = before && after ? before.url !== after.url : false;

    if (challenge.detected) {
      await fns.releaseControl();
      return {
        output: [
          `Clicked element ${ref} — security challenge detected (${challenge.provider}).`,
          `URL changed: ${urlChanged}`,
          `Signals: ${challenge.signals.join(', ')}`,
          '',
          'Browser shown — please complete the verification check.',
          'After verification, run "resume 120000"; it will wait without blocking your clicks.',
        ].join('\n'),
        appendReleaseHint: false,
      };
    }

    const lines = [
      `Clicked element ${ref}${waitFor ? ` (waitFor=${waitFor})` : ''}`,
      `Elapsed: ${elapsedMs}ms`,
      `URL changed: ${urlChanged}`,
      `Active element: ${describeActive(after)}`,
    ];
    if (before && after) {
      lines.push(`Scroll Y: ${Math.round(before.scrollY)} → ${Math.round(after.scrollY)}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeClickAtBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const xRaw = parts[1];
    const yRaw = parts[2];
    if (!xRaw || !yRaw) throw new Error('click-at requires x and y coordinates. Example: click-at 350 200');
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      throw new Error('click-at coordinates must be numbers. Example: click-at 350 200');
    }

    const before = await getPageMetrics(fns);
    const started = Date.now();
    await fns.clickAt(x, y);
    const elapsedMs = Date.now() - started;
    const after = await getPageMetrics(fns);

    const lines = [
      `Clicked at coordinates (${x}, ${y})`,
      `Elapsed: ${elapsedMs}ms`,
      `Within viewport: ${before ? x >= 0 && y >= 0 && x <= before.viewportWidth && y <= before.viewportHeight : 'unknown'}`,
      `Active element: ${describeActive(after)}`,
    ];
    if (before && after) {
      lines.push(`Scroll Y: ${Math.round(before.scrollY)} → ${Math.round(after.scrollY)}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeDragBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const x1Raw = parts[1];
    const y1Raw = parts[2];
    const x2Raw = parts[3];
    const y2Raw = parts[4];
    if (!x1Raw || !y1Raw || !x2Raw || !y2Raw) {
      throw new Error('drag requires 4 coordinates: x1 y1 x2 y2. Example: drag 100 200 300 400');
    }
    const x1 = Number(x1Raw);
    const y1 = Number(y1Raw);
    const x2 = Number(x2Raw);
    const y2 = Number(y2Raw);
    if (Number.isNaN(x1) || Number.isNaN(y1) || Number.isNaN(x2) || Number.isNaN(y2)) {
      throw new Error('drag coordinates must be numbers. Example: drag 100 200 300 400');
    }

    const before = await getPageMetrics(fns);
    const started = Date.now();
    await fns.drag(x1, y1, x2, y2);
    const elapsedMs = Date.now() - started;
    const after = await getPageMetrics(fns);

    const distance = Math.round(Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2));
    const lines = [
      `Dragged from (${x1}, ${y1}) to (${x2}, ${y2})`,
      `Distance: ${distance}px`,
      `Elapsed: ${elapsedMs}ms`,
      `Active element: ${describeActive(after)}`,
    ];
    if (before && after) {
      lines.push(`Scroll Y: ${Math.round(before.scrollY)} → ${Math.round(after.scrollY)}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeFillBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const ref = parts[1];
    const value = parts.slice(2).join(' ');
    if (!ref || value === undefined) throw new Error('fill requires ref and value. Example: fill @e5 hello world');

    const before = await getPageMetrics(fns);
    await fns.fill(ref, value);
    const after = await getPageMetrics(fns);

    return {
      output: [
        `Filled element ${ref} with "${value}"`,
        `Value length: ${value.length} characters`,
        `Active element before: ${describeActive(before)}`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeTypeKeysBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const text = parts.slice(1).join(' ');
    if (!text) throw new Error('type-keys requires printable text. Prefer array input to preserve punctuation and spaces.');
    await fns.sendKey({ key: 'Unidentified', text });
    return {
      output: `Dispatched ${text.length} characters as keyboard events to the focused receiver. No clipboard or Enter was used. Remote text and application effects are not verified: inspect once before a separate submit action. If the receiver did not accept the text, change the authorized route instead of repeating it.`,
      appendReleaseHint: true,
    };
  }

export async function executeTypeBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const text = parts.slice(1).join(' ');
    if (!text) throw new Error('type requires text. Example: type Hello World');

    const before = await getPageMetrics(fns);
    await fns.type(text);
    const after = await getPageMetrics(fns);

    return {
      output: [
        `Requested insertion of ${text.length} characters into the focused editor; application state is not verified`,
        `Active element before: ${describeActive(before)}`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeSelectBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const parsed = parseSelectCommand(parts);
    const { ref, value, assertText, assertValue, timeoutMs } = parsed;

    await fns.select(ref, value);
    const after = await getPageMetrics(fns);
    const verification = await verifySelectResult({
      fns,
      ref,
      selectedValue: value,
      assertText,
      assertValue,
      timeoutMs,
    });

    const warnings: string[] = [];
    if (!verification.selectedRefMatched) {
      warnings.push('selected control did not reflect requested value in accessibility snapshot');
    }
    if (assertText && !verification.assertTextMatched) {
      warnings.push(`assert-text did not match: "${assertText}"`);
    }
    if (assertValue && !verification.assertValueMatched) {
      warnings.push(`assert-value did not match: "${assertValue}"`);
    }

    const verificationStatus = warnings.length === 0 ? 'verified' : 'warning';

    return {
      output: [
        `Selected "${value}" in element ${ref} (${verificationStatus})`,
        `Verification: selectedRefMatched=${verification.selectedRefMatched}, assertTextMatched=${verification.assertTextMatched}, assertValueMatched=${verification.assertValueMatched}`,
        `Verification time: ${verification.elapsedMs}ms (timeout=${timeoutMs}ms)`,
        ...(warnings.length > 0
          ? [
            `Warning: select interaction succeeded but effective form state could not be fully verified.`,
            ...warnings.map((warning) => `- ${warning}`),
            'Tip: retry with --assert-text and/or --assert-value targeting downstream field changes.',
          ]
          : []),
        `Value length: ${value.length} characters`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeUploadBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const ref = parts[1];
    const filePaths = parts.slice(2);
    if (!ref || filePaths.length === 0) {
      throw new Error('upload requires ref and file path(s). Example: upload @e3 /path/to/file.pdf');
    }

    await fns.upload(ref, filePaths);
    const after = await getPageMetrics(fns);
    const fileList = filePaths.length === 1
      ? filePaths[0]
      : `${filePaths.length} files:\n${filePaths.map((p) => `  - ${p}`).join('\n')}`;

    return {
      output: [
        `Uploaded ${fileList} to element ${ref}`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }
