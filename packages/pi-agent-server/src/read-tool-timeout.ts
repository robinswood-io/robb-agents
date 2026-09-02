export const DEFAULT_READ_TOOL_TIMEOUT_MS = 120_000;

const MIN_READ_TOOL_TIMEOUT_MS = 5_000;
const MAX_READ_TOOL_TIMEOUT_MS = 10 * 60_000;

export class ReadToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`${toolName} timed out after ${timeoutMs}ms. Narrow the read or use another read-only path; do not retry the same call unchanged.`);
    this.name = 'ReadToolTimeoutError';
  }
}

export function resolveReadToolTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_READ_TOOL_TIMEOUT_MS;
  return Math.min(MAX_READ_TOOL_TIMEOUT_MS, Math.max(MIN_READ_TOOL_TIMEOUT_MS, Math.floor(parsed)));
}

export async function withReadToolTimeout<T>(
  toolName: string,
  operation: Promise<T>,
  timeoutMs = DEFAULT_READ_TOOL_TIMEOUT_MS,
): Promise<T> {
  if (toolName !== 'Read') return operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new ReadToolTimeoutError(toolName, timeoutMs)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
