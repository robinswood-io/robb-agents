import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import type { AgentError } from '../../errors.ts';

/**
 * Callbacks injected by ClaudeAgent for operations that depend on agent state.
 */
export interface ClaudeAdapterCallbacks {
  /** Debug logger — wired to ClaudeAgent.onDebug */
  onDebug?: (msg: string) => void;
  /** Maps SDK error codes to typed AgentErrors (depends on debug log parsing) */
  mapSDKError: (errorCode: SDKAssistantMessageError) => Promise<{ type: 'typed_error'; error: AgentError }>;
  /** Session directory for tool metadata (prevents cross-session race condition) */
  sessionDir?: string;
}

/**
 * Pure function: build a typed_error event for Windows SDK setup issues.
 * Returns null if the error doesn't match the pattern.
 */
export function buildWindowsSkillsDirError(errorText: string): { type: 'typed_error'; error: AgentError } | null {
  if (!errorText.includes('ENOENT') || !errorText.includes('skills')) {
    return null;
  }

  const pathMatch = errorText.match(/scandir\s+'([^']+)'/);
  const missingPath = pathMatch?.[1] || 'C:\\ProgramData\\ClaudeCode\\.claude\\skills';

  return {
    type: 'typed_error',
    error: {
      code: 'unknown_error',
      title: 'Windows Setup Required',
      message: `The SDK requires a directory that doesn't exist: ${missingPath} — Create this folder in File Explorer, then restart the app.`,
      details: [
        `PowerShell (run as Administrator):`,
        `New-Item -ItemType Directory -Force -Path "${missingPath}"`,
      ],
      actions: [],
      canRetry: true,
      originalError: errorText,
    },
  };
}

/**
 * Per-message usage snapshot for accurate context window display.
 * result.modelUsage is cumulative; we need per-message granularity.
 */
export interface AssistantUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Shape of the SDK's `task_notification` system message.
 * The SDK doesn't export a type for this, so we define it locally
 * and validate fields before use to catch silent breakage.
 */
export interface TaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status?: string;
  output_file?: string;
  summary?: string;
  session_id?: string;
}

/** Valid terminal statuses for background tasks */
export const VALID_TASK_STATUSES = ['completed', 'failed', 'stopped'] as const;

export type TaskStatus = typeof VALID_TASK_STATUSES[number];

