type StructuredStream<Message> = {
  readable: ReadableStream<Message>;
  writable: WritableStream<Message>;
};

interface PromptWriteReservation {
  turnId: string;
  matches?: (request: Record<string, unknown>) => boolean;
  bound: boolean;
  cancelled: boolean;
}

export interface CorrelatedProviderPromptStream<Message> {
  stream: StructuredStream<Message>;
  reserve(
    turnId: string,
    matches?: (request: Record<string, unknown>) => boolean,
  ): { cancel: () => boolean };
  cancelPending(): void;
}

const MAX_SEEN_PROVIDER_PROMPT_REQUESTS = 256;

function providerPromptRequests(message: unknown): Array<{
  key: string;
  request: Record<string, unknown>;
}> {
  const messages = Array.isArray(message) ? message : [message];
  const requests: Array<{ key: string; request: Record<string, unknown> }> = [];
  for (const candidate of messages) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (record.method !== 'session/prompt') continue;
    const id = record.id;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    requests.push({ key: `${typeof id}:${String(id)}`, request: record });
  }
  return requests;
}

/**
 * Observe the structured ACP stream and acknowledge only after the exact
 * `session/prompt` frame has crossed the underlying writable successfully.
 *
 * Vibe's `ActiveSession.prompt()` returns a response promise before its
 * internal JSON-RPC write queue runs, so invocation alone is not a handoff.
 * Reservations are FIFO because the bridge serializes prompt turns. Request
 * IDs tombstone duplicate/stale frames so they cannot consume a later turn.
 */
export function createCorrelatedProviderPromptStream<Message>(
  source: StructuredStream<Message>,
  acknowledge: (turnId: string) => void,
): CorrelatedProviderPromptStream<Message> {
  const pending: PromptWriteReservation[] = [];
  const seenRequestIds = new Set<string>();
  const seenRequestOrder: string[] = [];

  const rememberRequest = (requestId: string): boolean => {
    if (seenRequestIds.has(requestId)) return false;
    seenRequestIds.add(requestId);
    seenRequestOrder.push(requestId);
    if (seenRequestOrder.length > MAX_SEEN_PROVIDER_PROMPT_REQUESTS) {
      const expired = seenRequestOrder.shift();
      if (expired) seenRequestIds.delete(expired);
    }
    return true;
  };

  const writable = new WritableStream<Message>({
    async write(message) {
      const claimed: PromptWriteReservation[] = [];
      for (const { key, request } of providerPromptRequests(message)) {
        if (!rememberRequest(key)) continue;
        const reservation = pending[0];
        if (!reservation || (reservation.matches && !reservation.matches(request))) continue;
        pending.shift();
        reservation.bound = true;
        claimed.push(reservation);
      }

      const writer = source.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }

      for (const reservation of claimed) {
        if (!reservation.cancelled) acknowledge(reservation.turnId);
      }
    },
    async close() {
      const writer = source.writable.getWriter();
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    },
    async abort(reason) {
      const writer = source.writable.getWriter();
      try {
        await writer.abort(reason);
      } finally {
        writer.releaseLock();
      }
    },
  });

  return {
    stream: { readable: source.readable, writable },
    reserve(turnId, matches) {
      const reservation: PromptWriteReservation = {
        turnId,
        matches,
        bound: false,
        cancelled: false,
      };
      pending.push(reservation);
      return {
        cancel() {
          if (reservation.bound || reservation.cancelled) return false;
          reservation.cancelled = true;
          const index = pending.indexOf(reservation);
          if (index >= 0) pending.splice(index, 1);
          return true;
        },
      };
    },
    cancelPending() {
      for (const reservation of pending.splice(0)) {
        reservation.cancelled = true;
      }
    },
  };
}

/**
 * Convert a callback-based runtime write into the same post-write handoff
 * boundary. Duplicate callbacks settle once, callback errors do not
 * acknowledge, and a stale runtime identity can veto the acknowledgement.
 * The caller still decides whether an error is proven pre-write or ambiguous.
 */
export async function writeProviderPromptWithHandoff(
  write: (done: (error?: Error | null) => void) => void,
  acknowledge: () => void,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      write(done);
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });

  if (!isCurrent()) return false;
  acknowledge();
  return true;
}

/**
 * Adapt Pi AgentSession's preflight callback to the host handoff protocol.
 * Pi reports `false` for every local validation/setup failure and `true` only
 * after those checks, immediately before its provider loop (or after a native
 * follow-up has been accepted into Pi's own queue). Duplicate callbacks are
 * harmless and never acknowledge more than once.
 */
export function createProviderHandoffPreflight(
  acknowledge: () => void,
): (ready: boolean) => void {
  let acknowledged = false;
  return ready => {
    if (!ready || acknowledged) return;
    acknowledged = true;
    acknowledge();
  };
}
