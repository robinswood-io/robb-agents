import {
  BrowserToolExecutionTimeoutError,
  DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
} from '../../shared/src/agent/browser-tool-execution-watchdog.ts';
import { resolveBrowserToolExecutionTimeoutMs } from '../../shared/src/agent/browser-tool-runtime.ts';

export interface ProxyToolResult {
  content: string;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface PendingProxyToolExecution {
  resolve: (result: ProxyToolResult) => void;
}

/** The subprocess gives the main-process browser watchdog time to reply first. */
export const PI_BROWSER_TOOL_RESPONSE_GRACE_MS = 5_000;

function isBrowserTool(toolName: string): boolean {
  return toolName.replace(/^(?:mcp__session__|session__)/, '') === 'browser_tool';
}

function browserCommand(args: Record<string, unknown> | undefined): string | string[] | undefined {
  const command = args?.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.length > 0
    && command.every(part => typeof part === 'string')) return command;
  return undefined;
}

/** Keep the subprocess deadline just outside the matching main-process budget. */
export function resolveProxyToolResponseWatchdogTimeoutMs(
  toolName: string,
  args?: Record<string, unknown>,
): number | undefined {
  if (!isBrowserTool(toolName)) return undefined;
  const command = browserCommand(args);
  const executionTimeoutMs = command === undefined
    ? DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS
    : resolveBrowserToolExecutionTimeoutMs(command);
  return executionTimeoutMs + PI_BROWSER_TOOL_RESPONSE_GRACE_MS;
}

/**
 * Register before dispatching so a very fast main-process response cannot be
 * lost. Browser requests also have an independent subprocess deadline: this
 * keeps the Pi SDK tool promise and `pendingToolExecutions` bounded even when
 * the main process never sends a response.
 */
export function waitForProxyToolResponse(input: {
  pending: Map<string, PendingProxyToolExecution>;
  requestId: string;
  toolName: string;
  args?: Record<string, unknown>;
  dispatch: () => void;
  /** Test seam only; production derives a bounded deadline from browser args. */
  watchdogTimeoutMs?: number;
}): Promise<ProxyToolResult> {
  const responseWatchdogTimeoutMs = resolveProxyToolResponseWatchdogTimeoutMs(input.toolName, input.args);
  const browserExecutionTimeoutMs = responseWatchdogTimeoutMs === undefined
    ? undefined
    : responseWatchdogTimeoutMs - PI_BROWSER_TOOL_RESPONSE_GRACE_MS;
  const watchdogTimeoutMs = input.watchdogTimeoutMs
    ?? responseWatchdogTimeoutMs;

  return new Promise<ProxyToolResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: ProxyToolResult) => {
      const registered = input.pending.get(input.requestId);
      if (registered?.resolve !== settle) return;
      input.pending.delete(input.requestId);
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    input.pending.set(input.requestId, { resolve: settle });

    if (watchdogTimeoutMs !== undefined) {
      timer = setTimeout(() => {
        settle({
          content: new BrowserToolExecutionTimeoutError(
            browserExecutionTimeoutMs ?? watchdogTimeoutMs,
          ).message,
          isError: true,
        });
      }, watchdogTimeoutMs);
      timer.unref?.();
    }

    try {
      input.dispatch();
    } catch (error) {
      input.pending.delete(input.requestId);
      if (timer) clearTimeout(timer);
      reject(error);
    }
  });
}
