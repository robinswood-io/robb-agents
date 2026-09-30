import { createHash } from 'node:crypto';
import type { WaitSessionSnapshot, WaitSessionsResult } from '@craft-agent/session-tools-core';

/** Stable across process restarts: a repeated completion is not a new event. */
export function sessionWaitCursor(snapshot: WaitSessionSnapshot): string {
  return createHash('sha256').update(JSON.stringify([
    snapshot.sessionId, snapshot.state, snapshot.status, snapshot.processingGeneration,
    snapshot.reason, snapshot.finalMessageId, snapshot.finalText, snapshot.needsAttention, snapshot.objectiveState, snapshot.diagnostic,
  ])).digest('hex');
}

/** Event-driven wait. Previously delivered targets cannot starve unfinished siblings. */
export async function waitForSessionChange(input: {
  snapshot: () => WaitSessionSnapshot[];
  previous?: Readonly<Record<string, string>>;
  timeoutMs: number;
  subscribe: (wake: () => void) => () => void;
  signal?: AbortSignal;
}): Promise<WaitSessionsResult> {
  const snapshot = () => input.snapshot().map(item => {
    const cursor = sessionWaitCursor(item);
    const changed = input.previous?.[item.sessionId] !== cursor;
    // Final text was already delivered with this cursor. Its stable message ID
    // remains available, without replaying large reports on every wait.
    const { finalText, diagnostic, ...rest } = item;
    // Keep diagnostic identity, but deliver the bounded report and gaps once.
    const { text, errorText, validationGaps, ...diagnosticIdentity } = diagnostic ?? {};
    return { ...rest, cursor, changed, ...(changed && finalText !== undefined ? { finalText } : {}),
      ...(diagnostic ? { diagnostic: changed ? diagnostic : diagnosticIdentity as typeof diagnostic } : {}) };
  });
  const hasNewCompletion = (items: WaitSessionSnapshot[]) => items.some(item =>
    item.changed && item.state !== 'active' && (item.state === 'missing' || item.needsAttention || !!item.reason || (item.processingGeneration ?? 0) > 0));
  const first = snapshot();
  if (hasNewCompletion(first)) return { outcome: 'completed', sessions: first };
  if (input.timeoutMs === 0 || input.signal?.aborted) return { outcome: 'timeout', sessions: first };
  return new Promise(resolve => {
    let settled = false;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: 'completed' | 'timeout') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      off?.();
      input.signal?.removeEventListener('abort', abort);
      resolve({ outcome, sessions: snapshot() });
    };
    const abort = () => finish('timeout');
    const wake = () => { if (hasNewCompletion(snapshot())) finish('completed'); };
    off = input.subscribe(wake);
    if (settled) off();
    else {
      timer = setTimeout(() => finish('timeout'), Math.min(60_000, Math.max(1, input.timeoutMs)));
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      else wake(); // close the snapshot -> subscription race
    }
  });
}
