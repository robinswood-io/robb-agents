
/**
 * Session status (user-controlled, never automatic)
 *
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string;

/**
 * Built-in status IDs (for TypeScript consumers)
 * These are the default statuses but users can add/remove custom ones
 */
export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled';

/**
 * Session token usage tracking
 */
export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Model's context window size in tokens (from SDK modelUsage) */
  contextWindow?: number;
}

/**
 * App build that created or most recently persisted a session.
 * Optional on sessions written before build provenance was introduced.
 */
export interface SessionAppProvenance {
  appVersion: string;
  buildCommit?: string;
  buildChannel?: string;
  /** Whether uncommitted changes were present when this build was produced. */
  buildDirty?: boolean;
  isPackaged: boolean;
}
