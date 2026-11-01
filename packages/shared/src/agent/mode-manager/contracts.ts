/// <reference path="../../types/incr-regex-package.d.ts" />
import { type PermissionMode } from "../mode-types.ts";

/**
 * State for a single session's permission mode
 */
export type PermissionModeChangedBy = 'user' | 'system' | 'restore' | 'automation' | 'unknown';

export interface ModeState {
  /** Session ID */
  sessionId: string;
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Previous permission mode (if any mode transition has occurred) */
  previousPermissionMode?: PermissionMode;
  /** Monotonic version incremented each time the mode changes */
  modeVersion: number;
  /** ISO timestamp for the last mode change */
  lastChangedAt: string;
  /** Actor that initiated the last mode change */
  lastChangedBy: PermissionModeChangedBy;
  /** Last user-mode modeVersion for which one-turn signal has been consumed */
  lastUserSignalConsumedModeVersion?: number;
  /** Callback when mode state changes */
  onStateChange?: (state: ModeState) => void;
}

/**
 * Callbacks for mode changes
 */
export interface ModeCallbacks {
  onStateChange?: (state: ModeState) => void;
}

export const INVALID_PERMISSION_MODE_MESSAGE = 'Invalid permission mode. Expected safe, ask, or allow-all. Correct the session configuration before retrying; no permissions were changed.';

export class InvalidPermissionModeError extends Error {
  readonly code = 'invalid_permission_mode';
  readonly retryable = false;
  constructor() { super(INVALID_PERMISSION_MODE_MESSAGE); this.name = 'InvalidPermissionModeError'; }
}

export function isCanonicalPermissionMode(value: unknown): value is PermissionMode {
  return value === 'safe' || value === 'ask' || value === 'allow-all';
}

export function assertCanonicalPermissionMode(value: unknown): asserts value is PermissionMode {
  if (!isCanonicalPermissionMode(value)) throw new InvalidPermissionModeError();
}

/**
 * Result type for tool permission checks
 */
export type ToolCheckResult =
  | { allowed: true; requiresPermission?: false }
  | { allowed: true; requiresPermission: true; description: string }
  | { allowed: false; reason: string };
