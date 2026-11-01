import type { AgentEvent } from "@craft-agent/core/types";
import { DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS, MAX_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS, MIN_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS, TOOL_RESULT_GRACE_MS } from './contracts.ts';

/** Live turn events only: historical tool rows never extend a new wait. */
export function createAutomaticRecoveryToolDeadline(
  provider: string,
  inactivityTimeoutMs: number,
  now: () => number = () => performance.now(),
): { observe: (event: AgentEvent) => void; remainingMs: () => number } {
  const deadlines = new Map<string, number>();
  const seenStarts = new Set<string>();
  return {
    observe(event) {
      if (event.type === 'tool_result') {
        deadlines.delete(event.toolUseId);
        seenStarts.add(event.toolUseId);
      } else if (event.type === 'tool_start' && !seenStarts.has(event.toolUseId)) {
        seenStarts.add(event.toolUseId);
        // Pi's native Bash schema uses seconds. Do not guess units for other
        // providers or MCP tools that happen to expose a field named timeout.
        const seconds = event.input?.["timeout"];
        if (provider !== 'pi' || event.toolName !== 'Bash'
          || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
        const allowance = Math.min(MAX_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS,
          Math.max(inactivityTimeoutMs, seconds * 1000 + TOOL_RESULT_GRACE_MS));
        deadlines.set(event.toolUseId, now() + allowance);
      }
    },
    remainingMs() {
      if (!deadlines.size) return inactivityTimeoutMs;
      // A duplicate start, model text or another tool cannot renew an existing
      // call's lease. Its matching result is the only event that releases it.
      return Math.min(...deadlines.values()) - now();
    },
  };
}

export class AutomaticRecoveryStalledError extends Error {
  constructor(timeoutMs: number, toolDeadlineExpired = false) {
    super(toolDeadlineExpired
      ? 'Automatic turn recovery reached the bounded deadline for an outstanding tool result'
      : `Automatic turn recovery produced no activity for ${timeoutMs} ms`);
    this.name = 'AutomaticRecoveryStalledError';
  }
}

export function resolveAutomaticRecoveryInactivityTimeoutMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.min(
    Math.max(Math.floor(parsed), MIN_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS),
    MAX_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS,
  );
}

/**
 * Bound each wait for the next provider event during an automatic recovery.
 * A live tool may provide a separate absolute deadline. A stalled iterator is intentionally left
 * for SessionManager's error path to dispose with the complete runtime.
 */
export async function* withAutomaticRecoveryInactivityTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  remainingToolWaitMs?: () => number,
  remainingPermissionWaitMs?: () => number | undefined,
): AsyncGenerator<T> {
  if (timeoutMs <= 0) {
    yield* source;
    return;
  }

  const iterator = source[Symbol.asyncIterator]();
  let stalled = false;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = remainingToolWaitMs?.();
        const permissionRemaining = remainingPermissionWaitMs?.();
        const hasPermissionWait = typeof permissionRemaining === 'number'
          && Number.isFinite(permissionRemaining) && permissionRemaining > 0;
        // Refuse before next(): an already-resolved stream of unrelated events
        // must not win the timer race forever after a live tool's fixed deadline.
        // A live permission request gets a short, absolute extension so its
        // earlier TTL callback can record a denied/non-executed handoff first.
        if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining <= 0
          && !hasPermissionWait) {
          throw new AutomaticRecoveryStalledError(timeoutMs, true);
        }
        const baseWaitMs = typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0
          ? Math.min(Math.ceil(remaining), MAX_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS)
          : timeoutMs;
        const waitMs = hasPermissionWait
          ? Math.max(baseWaitMs, Math.ceil(permissionRemaining))
          : baseWaitMs;
        const next = await Promise.race([
          iterator.next(),
          new Promise<never>((_resolve, reject) => {
            const arm = (delayMs: number) => {
              timer = setTimeout(() => {
                // Permission can be requested after iterator.next() has
                // already armed the ordinary inactivity timer. Re-check only
                // this absolute extension; the normal inactivity allowance
                // must not renew itself without a provider event.
                const extension = remainingPermissionWaitMs?.();
                if (typeof extension === 'number' && Number.isFinite(extension) && extension > 0) {
                  arm(Math.ceil(extension));
                  return;
                }
                reject(new AutomaticRecoveryStalledError(waitMs));
              }, delayMs);
              timer.unref?.();
            };
            arm(waitMs);
          }),
        ]);
        if (next.done) return;
        yield next.value;
      } catch (error) {
        stalled = error instanceof AutomaticRecoveryStalledError;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } finally {
    if (!stalled && iterator.return) {
      await iterator.return();
    }
  }
}
