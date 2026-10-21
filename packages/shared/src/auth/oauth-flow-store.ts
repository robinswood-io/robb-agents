/**
 * OAuthFlowStore — in-memory store for pending OAuth flows.
 *
 * Lives server-side. Never serialized, never sent to clients.
 * Keyed by `state` (CSRF token) for O(1) lookup on oauth:complete.
 * 5-minute TTL with lazy + periodic cleanup.
 */

import type { LoadedSource } from '../sources/types.ts';
import type { OAuthProvider } from './oauth-flow-types.ts';

const FLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // sweep every minute
const DEFAULT_MAX_FLOWS = 256;

export interface PendingOAuthFlow {
  flowId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  source: LoadedSource;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  provider: OAuthProvider;

  // Binding fields — validated on oauth:complete
  ownerClientId: string;
  workspaceId: string;
  sourceSlug: string;

  // Optional session binding (when initiated from auth request card)
  sessionId?: string;
  authRequestId?: string;

  createdAt: number;
  expiresAt: number;
}

export class OAuthFlowStore {
  private flows = new Map<string, PendingOAuthFlow>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxFlows: number;

  constructor(maxFlows = DEFAULT_MAX_FLOWS) {
    this.maxFlows = Math.max(1, maxFlows);
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  store(flow: PendingOAuthFlow): void {
    if (!flow.state || typeof flow.state !== 'string') {
      throw new Error('OAuth flow state is required');
    }
    if (this.flows.size >= this.maxFlows && !this.flows.has(flow.state)) {
      this.cleanup();
      while (this.flows.size >= this.maxFlows) {
        const oldestKey = this.flows.keys().next().value;
        if (oldestKey === undefined) break;
        this.flows.delete(oldestKey);
      }
    }
    this.flows.set(flow.state, flow);
  }

  getByState(state: string): PendingOAuthFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;

    // Check expiry lazily
    if (Date.now() > flow.expiresAt) {
      this.flows.delete(state);
      return null;
    }

    return flow;
  }

  /** Atomically retrieve and remove a pending flow by state (one-shot anti-replay). */
  consumeByState(state: string): PendingOAuthFlow | null {
    const flow = this.getByState(state);
    if (!flow) return null;
    this.flows.delete(state);
    return flow;
  }

  remove(state: string): void {
    this.flows.delete(state);
  }

  /** Prune expired entries. Called on interval + lazily on access. */
  cleanup(): void {
    const now = Date.now();
    for (const [state, flow] of this.flows) {
      if (now > flow.expiresAt) {
        this.flows.delete(state);
      }
    }
  }

  /** Stop the periodic cleanup timer (for graceful shutdown). */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.flows.clear();
  }

  /** Number of pending flows (for diagnostics). */
  get size(): number {
    return this.flows.size;
  }
}

/**
 * Create a PendingOAuthFlow with default TTL.
 * Convenience helper used by the oauth:start handler.
 */
export function createPendingFlow(
  params: Omit<PendingOAuthFlow, 'createdAt' | 'expiresAt'>
): PendingOAuthFlow {
  const now = Date.now();
  return {
    ...params,
    createdAt: now,
    expiresAt: now + FLOW_TTL_MS,
  };
}
