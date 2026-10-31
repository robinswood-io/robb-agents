/// <reference path="../../types/incr-regex-package.d.ts" />
import { debug } from "../../utils/debug.ts";
import { type PermissionMode, parsePermissionMode } from "../mode-types.ts";
import type { ModeCallbacks, ModeState, PermissionModeChangedBy } from './contracts.ts';
import { assertCanonicalPermissionMode } from './contracts.ts';

// ============================================================
// Mode Manager Class
// ============================================================

/**
 * Manager for per-session permission mode state.
 * Each session has its own state - NO GLOBAL STATE.
 */
class ModeManager {
  private states: Map<string, ModeState> = new Map();
  private callbacks: Map<string, ModeCallbacks> = new Map();
  private subscribers: Map<string, Set<() => void>> = new Map();

  /**
   * Hydrate persisted transition context (previous mode) without mutating current mode/version.
   * Used on session restore so transition metadata can survive app restarts.
   */
  setPreviousPermissionMode(sessionId: string, previousPermissionMode?: PermissionMode): void {
    // Transition metadata grants no authority. Ignore unknown legacy values,
    // and normalize UI aliases before looking up their display labels.
    previousPermissionMode = typeof previousPermissionMode === 'string'
      ? parsePermissionMode(previousPermissionMode) ?? undefined
      : undefined;
    const existing = this.getState(sessionId);
    if (existing.previousPermissionMode === previousPermissionMode) {
      return;
    }

    const existingWithoutOverrides = { ...existing };
    delete existingWithoutOverrides.previousPermissionMode;
    const newState: ModeState = {
      ...existingWithoutOverrides,
      ...(previousPermissionMode !== undefined ? { previousPermissionMode } : {}),
    };
    this.states.set(sessionId, newState);
  }

  /**
   * Get or create state for a session
   */
  getState(sessionId: string): ModeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        permissionMode: 'ask', // Default to 'ask' until initialized
        modeVersion: 0,
        lastChangedAt: new Date().toISOString(),
        lastChangedBy: 'system',
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /**
   * Set permission mode for a session.
   * @returns true when state changed, false when mode was unchanged
   */
  setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
    metadata?: { changedBy?: PermissionModeChangedBy; changedAt?: string }
  ): boolean {
    assertCanonicalPermissionMode(mode);
    const existing = this.getState(sessionId);

    // No-op when mode is unchanged (prevents duplicate logs/events)
    if (existing.permissionMode === mode) {
      return false;
    }

    const changedAt = metadata?.changedAt ?? new Date().toISOString();
    const changedBy = metadata?.changedBy ?? 'unknown';

    const shouldTrackTransition = !(existing.modeVersion === 0 && changedBy === 'restore');

    const optionalPreviousPermissionMode = shouldTrackTransition ? existing.permissionMode : undefined;
    const existingWithoutOverrides2 = { ...existing };
    delete existingWithoutOverrides2.previousPermissionMode;
    const newState: ModeState = {
      ...existingWithoutOverrides2,
      ...(optionalPreviousPermissionMode !== undefined ? { previousPermissionMode: optionalPreviousPermissionMode } : {}),
      permissionMode: mode,
      modeVersion: existing.modeVersion + 1,
      lastChangedAt: changedAt,
      lastChangedBy: changedBy,
    };
    this.states.set(sessionId, newState);

    debug(`[Mode] Set permission mode to ${mode} for session ${sessionId} (changedBy=${changedBy}, modeVersion=${newState.modeVersion})`);

    // Notify callbacks (for CraftAgent internal sync)
    const callbacks = this.callbacks.get(sessionId);
    if (callbacks?.onStateChange) {
      callbacks.onStateChange(newState);
    }

    // Notify React subscribers (for useSyncExternalStore)
    this.subscribers.get(sessionId)?.forEach(cb => cb());
    return true;
  }

  /**
   * Mark the current user-origin mode change signal as consumed.
   * No-op unless the latest mode change was user-initiated.
   */
  consumeUserModeSignal(sessionId: string): void {
    const existing = this.getState(sessionId);
    if (existing.lastChangedBy !== 'user') {
      return;
    }

    if (existing.lastUserSignalConsumedModeVersion === existing.modeVersion) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      lastUserSignalConsumedModeVersion: existing.modeVersion,
    };
    this.states.set(sessionId, newState);
  }

  /**
   * Register callbacks for a session
   */
  registerCallbacks(sessionId: string, callbacks: ModeCallbacks): void {
    this.callbacks.set(sessionId, callbacks);
  }

  /**
   * Unregister callbacks for a session
   */
  unregisterCallbacks(sessionId: string): void {
    this.callbacks.delete(sessionId);
  }

  /**
   * Clean up a session's state
   */
  cleanupSession(sessionId: string): void {
    this.states.delete(sessionId);
    this.callbacks.delete(sessionId);
    this.subscribers.delete(sessionId);
  }

  /**
   * Subscribe to mode changes for a session (for React useSyncExternalStore)
   * Returns an unsubscribe function
   */
  subscribe(sessionId: string, callback: () => void): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.subscribers.get(sessionId)?.delete(callback);
    };
  }
}

// Singleton manager instance
export const modeManager = new ModeManager();
