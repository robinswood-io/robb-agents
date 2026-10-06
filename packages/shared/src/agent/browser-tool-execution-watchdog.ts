/**
 * Browser callbacks cross Electron/CDP and, for remote sessions, WebSocket RPC
 * boundaries. A lost execution-context reply must not keep the provider turn
 * (and its usage accounting) open indefinitely.
 */
export const DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS = 300_000;
export const BROWSER_TOOL_TIMEOUT_GRACE_MS = 15_000;
export const MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS =
  MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS + BROWSER_TOOL_TIMEOUT_GRACE_MS;

export class BrowserToolExecutionTimeoutError extends Error {
  readonly code = 'BROWSER_TOOL_EXECUTION_TIMEOUT';
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Browser operation timed out after ${Math.ceil(timeoutMs / 1000)}s. ` +
      'The operation may have completed even though its result was not received. ' +
      'Inspect the current browser state before retrying; do not repeat a mutation solely because this receipt is missing.',
    );
    this.name = 'BrowserToolExecutionTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export async function withBrowserToolExecutionWatchdog<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: (error: BrowserToolExecutionTimeoutError) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new BrowserToolExecutionTimeoutError(timeoutMs);
          onTimeout?.(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
