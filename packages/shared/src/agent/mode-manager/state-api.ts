/// <reference path="../../types/incr-regex-package.d.ts" />
import { type PermissionMode, PERMISSION_MODE_ORDER, PERMISSION_MODE_CONFIG } from "../mode-types.ts";
import type { ModeCallbacks, ModeState, PermissionModeChangedBy } from './contracts.ts';
import { assertCanonicalPermissionMode, isCanonicalPermissionMode } from './contracts.ts';
import { modeManager } from './mode-state.ts';

// ============================================================
// Permission Mode API
// ============================================================

/**
 * Get the current permission mode for a session
 */
export function getPermissionMode(sessionId: string): PermissionMode {
  return modeManager.getState(sessionId).permissionMode;
}

/**
 * Set the permission mode for a session.
 * @returns true when state changed, false when mode was unchanged
 */
export function setPermissionMode(
  sessionId: string,
  mode: PermissionMode,
  metadata?: { changedBy?: PermissionModeChangedBy; changedAt?: string }
): boolean {
  return modeManager.setPermissionMode(sessionId, mode, metadata);
}

/**
 * Consume one-turn user mode-change signal for the current modeVersion.
 */
export function consumeUserModeSignal(sessionId: string): void {
  modeManager.consumeUserModeSignal(sessionId);
}

/**
 * Cycle to the next permission mode (for SHIFT+TAB)
 * @param sessionId - The session to cycle mode for
 * @param enabledModes - Optional list of enabled modes to cycle through (defaults to all 3)
 * Returns the new mode
 */
export function cyclePermissionMode(
  sessionId: string,
  enabledModes?: PermissionMode[]
): PermissionMode {
  const currentMode = getPermissionMode(sessionId);
  // Use provided modes or default to all modes
  const modes = enabledModes && enabledModes.length >= 2 ? enabledModes : PERMISSION_MODE_ORDER;
  const currentIndex = modes.indexOf(currentMode);

  // If current mode not in enabled list, jump to first enabled mode
  if (currentIndex === -1) {
    const nextMode = modes[0] ?? 'ask';
    setPermissionMode(sessionId, nextMode, { changedBy: 'user' });
    return nextMode;
  }

  const nextIndex = (currentIndex + 1) % modes.length;
  // Safe assertion: nextIndex is always valid due to modulo operation
  const nextMode = modes[nextIndex] as PermissionMode;
  setPermissionMode(sessionId, nextMode, { changedBy: 'user' });
  return nextMode;
}

/**
 * Subscribe to mode changes for a session (for React useSyncExternalStore)
 * Returns an unsubscribe function
 */
export function subscribeModeChanges(sessionId: string, callback: () => void): () => void {
  return modeManager.subscribe(sessionId, callback);
}

/**
 * Get mode state for a session
 */
export function getModeState(sessionId: string): ModeState {
  return modeManager.getState(sessionId);
}

/**
 * Hydrate persisted transition context for a session without changing current mode.
 */
export function hydratePreviousPermissionMode(sessionId: string, previousPermissionMode?: PermissionMode): void {
  modeManager.setPreviousPermissionMode(sessionId, previousPermissionMode);
}

/**
 * Lightweight diagnostics for permission denials and debugging.
 */
export function getPermissionModeDiagnostics(sessionId: string): {
  permissionMode: PermissionMode;
  previousPermissionMode?: PermissionMode;
  transitionDisplay?: string;
  modeVersion: number;
  lastChangedAt: string;
  lastChangedBy: PermissionModeChangedBy;
  userModeSignalPending: boolean;
} {
  const state = modeManager.getState(sessionId);
  assertCanonicalPermissionMode(state.permissionMode);
  const previousPermissionMode = isCanonicalPermissionMode(state.previousPermissionMode) ? state.previousPermissionMode : undefined;
  const transitionDisplay = previousPermissionMode
    ? `${PERMISSION_MODE_CONFIG[previousPermissionMode].displayName} -> ${PERMISSION_MODE_CONFIG[state.permissionMode].displayName}`
    : undefined;
  const userModeSignalPending =
    state.lastChangedBy === 'user' &&
    state.modeVersion > 0 &&
    state.lastUserSignalConsumedModeVersion !== state.modeVersion;

  return {
    permissionMode: state.permissionMode,
    previousPermissionMode,
    transitionDisplay,
    modeVersion: state.modeVersion,
    lastChangedAt: state.lastChangedAt,
    lastChangedBy: state.lastChangedBy,
    userModeSignalPending,
  };
}

/**
 * Initialize permission mode state for a session with callbacks
 */
export function initializeModeState(
  sessionId: string,
  initialMode: PermissionMode | { permissionMode?: PermissionMode },
  callbacks?: ModeCallbacks
): void {
  let mode: PermissionMode;

  if (typeof initialMode === 'string') {
    mode = initialMode;
  } else if ('permissionMode' in initialMode && initialMode.permissionMode) {
    mode = initialMode.permissionMode;
  } else {
    // Default to 'ask' if not specified
    mode = 'ask';
  }

  // IMPORTANT: Register callbacks BEFORE setting mode so the initial
  // state change triggers the callback.
  if (callbacks) {
    modeManager.registerCallbacks(sessionId, callbacks);
  }
  modeManager.setPermissionMode(sessionId, mode, { changedBy: 'restore' });
}

/**
 * Clean up mode state for a session
 */
export function cleanupModeState(sessionId: string): void {
  modeManager.cleanupSession(sessionId);
}
