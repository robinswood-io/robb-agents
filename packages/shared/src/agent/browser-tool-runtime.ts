import { isUnknownArray } from '../utils/json.ts';
import { withBrowserToolExecutionWatchdog } from "./browser-tool-execution-watchdog.ts";

import type { BrowserPaneFns } from "./browser-tools.ts";
export {
  BROWSER_TOOL_TIMEOUT_GRACE_MS,
  BrowserToolExecutionTimeoutError,
  DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS,
  withBrowserToolExecutionWatchdog,
} from './browser-tool-execution-watchdog.ts';

import { executeGetClipboardBrowserCommand, executePasteBrowserCommand, executeScreenshotBrowserCommand, executeScreenshotRegionBrowserCommand, executeSetClipboardBrowserCommand } from './browser-tool-runtime/capture-clipboard.ts';
import { NAVIGATION_COMMANDS, splitBatchCommands, tokenizeCommand } from './browser-tool-runtime/command-syntax.ts';
import type { BrowserCommandExecutionArgs, BrowserCommandImage, BrowserCommandResult } from './browser-tool-runtime/contracts.ts';
import { resolveBrowserToolExecutionTimeoutMs } from './browser-tool-runtime/execution-timeout.ts';
import { executeConsoleBrowserCommand, executeDownloadsBrowserCommand, executeEvaluateBrowserCommand, executeFindBrowserCommand, executeNetworkBrowserCommand, executeSnapshotBrowserCommand, executeWaitBrowserCommand } from './browser-tool-runtime/inspection.ts';
import { executeClickAtBrowserCommand, executeClickBrowserCommand, executeDragBrowserCommand, executeFillBrowserCommand, executeSelectBrowserCommand, executeTypeBrowserCommand, executeTypeKeysBrowserCommand, executeUploadBrowserCommand } from './browser-tool-runtime/interaction.ts';
import { executeKeyBrowserCommand, executeScrollBrowserCommand } from './browser-tool-runtime/interaction-execute-key-browser-command.ts';
import { assertContextualGmailBrowserMutationAllowed } from './browser-tool-runtime/mutation-guard.ts';
import { executeBackBrowserCommand, executeCloseBrowserCommand, executeFocusBrowserCommand, executeForwardBrowserCommand, executeHideBrowserCommand, executeNavigateBrowserCommand, executeOpenBrowserCommand, executeReleaseBrowserCommand, executeResumeBrowserCommand, executeWindowResizeBrowserCommand, executeWindowsBrowserCommand } from './browser-tool-runtime/window-lifecycle.ts';

export function getBrowserToolHelp(): string {
  return [
    'browser_tool command help',
    '',
    'Usage:',
    '  --help',
    '  open [--foreground|-f]                         open browser (background by default)',
    '  navigate <url>',
    '  snapshot',
    '  find <query>                                   search elements by keyword (matches role, name, value)',
    '  click <ref> [none|navigation|network-idle] [timeoutMs]',
    '  click-at <x> <y>                               click at pixel coordinates (canvas elements)',
    '  drag <x1> <y1> <x2> <y2>                      drag from (x1,y1) to (x2,y2)',
    '  fill <ref> <value>',
    '  type <text>                                    insert into a focused visible DOM editor',
    '  type-keys <text>                               printable keyboard text for a focused canvas/RDP receiver (max 256; no Enter)',
    '  select <ref> <value> [--assert-text <text>] [--assert-value <value>] [--timeout <ms>]',
    '  upload <ref> <path> [path2...]                 attach local file(s) to a file input',
    '  set-clipboard <text>                           request clipboard write (fails when browser policy denies it)',
    '  get-clipboard                                  request clipboard read (denial is not an empty clipboard)',
    '  paste <text>                                   set clipboard + trigger Ctrl/Cmd+V',
    '  screenshot [--annotated|-a] [--png]            capture screenshot (JPEG default, --png for lossless)',
    '  screenshot-region <x> <y> <width> <height> [--png]',
    '  screenshot-region --ref <@eN> [--padding <px>] [--png]',
    '  screenshot-region --selector <css-selector> [--padding <px>] [--png]',
    '  screenshot-region --canvas --selector <unique-canvas-selector> (bitmap only; no DOM overlays)',
    '  console [limit] [level]',
    '  window-resize <width> <height>',
    '  network [limit] [status]',
    '  wait <selector|text|url|network-idle> <value?> [timeoutMs]',
    '  key <key> [modifiers]',
    '  downloads [list|wait] [limit|timeoutMs]',
    '  scroll <up|down|left|right> [amount]',
    '  back',
    '  forward',
    '  evaluate <expression>',
    '  focus [windowId]                               focus existing browser window (no new window)',
    '  windows',
    '  resume [timeoutMs]                            wait for manual security verification, then continue',
    '  release [windowId|all]                         dismiss agent overlay (user keeps browsing)',
    '  close [windowId]                               close & destroy the browser window',
    '  hide [windowId]                                hide the window (keeps state, "open" re-shows)',
    '',
    'Batching (string mode, semicolon-separated, stops after navigation commands):',
    '  fill @e1 user@example.com; fill @e2 password123; click @e3',
    '',
    'Array mode (JSON array input, no batch splitting/tokenization):',
    '  ["evaluate", "var x = 1; var y = 2; x + y"]',
    '  ["paste", "Name\\tAge\\nAlice\\t30"]',
    '  ["type-keys", "AZERTY éèàçù € @[]"]',
    '',
    'Examples:',
    '  navigate https://example.com',
    '  click @e12',
    '  click-at 350 200',
    '  drag 100 200 300 400',
    '  fill @e5 user@example.com',
    '  type Hello World',
    '  upload @e3 /path/to/file.pdf',
    '  set-clipboard Name\\tAge\\nAlice\\t30',
    '  get-clipboard',
    '  paste Name\\tAge\\nAlice\\t30',
    '  scroll down 800',
    '  evaluate document.title',
    '  screenshot --annotated',
    '  screenshot --png',
    '  screenshot-region --ref @e9 --padding 12',
    '  screenshot-region --selector div[data-testid="chart"]',
    '  console 100 warn',
    '  window-resize 1280 720',
    '  network 50 failed',
    '  wait network-idle 8000',
    '  key Enter',
    '  downloads wait 15000',
    '  focus',
    '  focus browser-1',
    '  windows',
  ].join('\n');
}

export async function executeBrowserToolCommand(args: {
  command: string | string[];
  fns: BrowserPaneFns;
  sessionId: string;
  platform?: NodeJS.Platform;
}): Promise<BrowserCommandResult> {
  const controller = new AbortController();
  const guardedFns = abortAwareBrowserPaneFns(args.fns, controller.signal);
  return withBrowserToolExecutionWatchdog(
    executeBrowserToolCommandWithoutWatchdog({ ...args, fns: guardedFns, signal: controller.signal }),
    resolveBrowserToolExecutionTimeoutMs(args.command),
    error => controller.abort(error),
  );
}

function throwIfBrowserToolExecutionAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Browser operation was cancelled after its execution deadline.');
}

/**
 * A watchdog cannot undo an action already handed to Electron/CDP, but it must
 * fence every later callback. This prevents a delayed callback from continuing
 * a compound command (or the next command in a batch) after the caller already
 * received a timeout and may have started recovery.
 */
function abortAwareBrowserPaneFns(fns: BrowserPaneFns, signal: AbortSignal): BrowserPaneFns {
  return new Proxy(fns, {
    get(target, property, receiver: unknown) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...callbackArgs: unknown[]) => {
        throwIfBrowserToolExecutionAborted(signal);
        const result: unknown = Reflect.apply(value, target, callbackArgs);
        if (result !== null && (typeof result === 'object' || typeof result === 'function')
          && 'then' in result && typeof result.then === 'function') {
          return Promise.resolve(result).then(resolved => {
            throwIfBrowserToolExecutionAborted(signal);
            return resolved;
          });
        }
        throwIfBrowserToolExecutionAborted(signal);
        return result;
      };
    },
  }) as BrowserPaneFns;
}

async function executeBrowserToolCommandWithoutWatchdog(args: {
  command: string | string[];
  fns: BrowserPaneFns;
  sessionId: string;
  platform?: NodeJS.Platform;
  signal: AbortSignal;
}): Promise<BrowserCommandResult> {
  // Array mode: no batch splitting, pass directly to single command execution
  if (isUnknownArray(args.command)) {
    if (args.command.length === 0) {
      throw new Error('Missing command. Use "--help" to see supported browser_tool commands.');
    }
    return executeSingleCommand(args);
  }

  // String mode: existing behavior unchanged
  const trimmed = args.command.trim();
  if (!trimmed) {
    throw new Error('Missing command. Use "--help" to see supported browser_tool commands.');
  }

  const commands = splitBatchCommands(trimmed);
  if (commands.length > 1) {
    return executeBatchCommands({ ...args, commands });
  }

  return executeSingleCommand(args);
}

async function executeBatchCommands(args: {
  commands: string[];
  fns: BrowserPaneFns;
  sessionId: string;
  platform?: NodeJS.Platform;
  signal: AbortSignal;
}): Promise<BrowserCommandResult> {
  const outputs: string[] = [];
  let lastImage: BrowserCommandImage | undefined;
  let appendReleaseHint = false;

  for (let i = 0; i < args.commands.length; i++) {
    throwIfBrowserToolExecutionAborted(args.signal);
    const command = args.commands[i]!;
    const result = await executeSingleCommand({ ...args, command });
    throwIfBrowserToolExecutionAborted(args.signal);

    outputs.push(result.output);
    if (result.image) lastImage = result.image;
    if (result.appendReleaseHint) appendReleaseHint = true;

    const batchCmd = tokenizeCommand(command)[0]?.toLowerCase();
    if (batchCmd && NAVIGATION_COMMANDS.has(batchCmd) && i < args.commands.length - 1) {
      outputs.push(`(stopped batch after "${batchCmd}" — page may have changed, re-snapshot before continuing)`);
      break;
    }
  }

  return {
    output: outputs.join('\n'),
    appendReleaseHint,
    ...(lastImage !== undefined ? { image: lastImage } : {}),
  };
}

async function executeSingleCommand(args: BrowserCommandExecutionArgs): Promise<BrowserCommandResult> {
  throwIfBrowserToolExecutionAborted(args.signal);
  // Array mode: use parts directly, no parsing needed
  const parts = isUnknownArray(args.command)
    ? args.command
    : tokenizeCommand(args.command.trim());
  const cmd = parts[0]?.toLowerCase();

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    return { output: getBrowserToolHelp(), appendReleaseHint: false };
  }

  const { fns } = args;
  await assertContextualGmailBrowserMutationAllowed({
    commandParts: parts,
    fns,
    sessionId: args.sessionId,
  });

  if (cmd === 'open') {
    return await executeOpenBrowserCommand(parts, fns);
  }

  if (cmd === 'navigate') {
    return await executeNavigateBrowserCommand(parts, fns);
  }

  if (cmd === 'snapshot') {
    return await executeSnapshotBrowserCommand(fns);
  }

  if (cmd === 'find') {
    return await executeFindBrowserCommand(parts, fns);
  }

  if (cmd === 'click') {
    return await executeClickBrowserCommand(parts, fns);
  }

  if (cmd === 'click-at') {
    return await executeClickAtBrowserCommand(parts, fns);
  }

  if (cmd === 'drag') {
    return await executeDragBrowserCommand(parts, fns);
  }

  if (cmd === 'fill') {
    return await executeFillBrowserCommand(parts, fns);
  }

  if (cmd === 'type-keys') {
    return await executeTypeKeysBrowserCommand(parts, fns);
  }

  if (cmd === 'type') {
    return await executeTypeBrowserCommand(parts, fns);
  }

  if (cmd === 'select') {
    return await executeSelectBrowserCommand(parts, fns);
  }

  if (cmd === 'upload') {
    return await executeUploadBrowserCommand(parts, fns);
  }

  if (cmd === 'set-clipboard') {
    return await executeSetClipboardBrowserCommand(parts, fns);
  }

  if (cmd === 'get-clipboard') {
    return await executeGetClipboardBrowserCommand(fns);
  }

  if (cmd === 'paste') {
    return await executePasteBrowserCommand(parts, fns, args);
  }

  if (cmd === 'screenshot') {
    return await executeScreenshotBrowserCommand(parts, fns);
  }

  if (cmd === 'screenshot-region') {
    return await executeScreenshotRegionBrowserCommand(parts, fns);
  }

  if (cmd === 'console') {
    return await executeConsoleBrowserCommand(parts, fns);
  }

  if (cmd === 'window-resize') {
    return await executeWindowResizeBrowserCommand(parts, fns);
  }

  if (cmd === 'network') {
    return await executeNetworkBrowserCommand(parts, fns);
  }

  if (cmd === 'wait') {
    return await executeWaitBrowserCommand(parts, fns);
  }

  if (cmd === 'resume') {
    return await executeResumeBrowserCommand(parts, fns);
  }

  if (cmd === 'key') {
    return await executeKeyBrowserCommand(parts, fns);
  }

  if (cmd === 'downloads') {
    return await executeDownloadsBrowserCommand(parts, fns);
  }

  if (cmd === 'scroll') {
    return await executeScrollBrowserCommand(parts, fns);
  }

  if (cmd === 'back') {
    return await executeBackBrowserCommand(fns);
  }

  if (cmd === 'forward') {
    return await executeForwardBrowserCommand(fns);
  }

  if (cmd === 'evaluate') {
    return await executeEvaluateBrowserCommand(parts, fns);
  }

  if (cmd === 'focus') {
    return await executeFocusBrowserCommand(parts, fns);
  }

  if (cmd === 'windows') {
    return await executeWindowsBrowserCommand(fns, args);
  }

  if (cmd === 'release') {
    return await executeReleaseBrowserCommand(parts, fns);
  }

  if (cmd === 'close') {
    return await executeCloseBrowserCommand(parts, fns);
  }

  if (cmd === 'hide') {
    return await executeHideBrowserCommand(parts, fns);
  }

  throw new Error(`Unknown browser_tool command "${cmd}". Use "--help" to see supported commands.`);
}
export type { BrowserCommandImage, BrowserCommandResult } from './browser-tool-runtime/contracts.ts';
export { setContextualGmailBrowserMutationGuard, isContextualGmailBrowserMutationGuardEnabled, assertContextualGmailBrowserMutationTargetAllowed } from './browser-tool-runtime/mutation-guard.ts';
export { containsBrowserKeyboardText, isObservationalBrowserCommand } from './browser-tool-runtime/command-syntax.ts';
export { resolveBrowserToolExecutionTimeoutMs } from './browser-tool-runtime/execution-timeout.ts';
