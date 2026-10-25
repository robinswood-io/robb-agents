import { sessionLog } from './runtime-platform.ts';

/**
 * Feature flags for agent behavior
 */
export const AGENT_FLAGS = {
  /** Default modes enabled for new sessions */
  defaultModesEnabled: true,
} as const

export const RECOVERY_BUDGET_UNAVAILABLE_MESSAGE = 'Automatic recovery is paused because this older turn has no recoverable budget history. Completed work, tool receipts and unexecuted checkpoints were preserved. Use Retry to resume from the preserved work; previous automatic limits have not been reset.'

export const MAX_ADMIN_REMEMBER_MINUTES = 60

export class RetryTurnAlreadyRunningError extends Error {}

export class AutonomousAdmissionDeferredError extends Error {}

export class AutomaticRecoverySupersededError extends Error {}

export class SourceActivationSupersededError extends Error {}

export class InternalContinuationSupersededError extends Error {}

export class DelegatedDispatchSupersededError extends Error {}

export class CleanRecoveryDispatchAuthenticationError extends Error {}

export const MAX_ANNOTATIONS_PER_MESSAGE = 200

export const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

// Window during which fs.watch metadata-revert events from our own atomic write
// are ignored, so the watcher does not roll back the in-memory mutation we
// just persisted. See onSessionMetadataChange.
export const METADATA_WRITE_GUARD_MS = 5000

/**
 * Text sent to the session when a plan is approved from outside the desktop
 * UI (e.g. Telegram button). Mirrors the English `plan.approved` i18n key
 * used by the desktop flow at `plan-approval-message.ts`. Not localized —
 * the agent reads this, not the end user.
 */
export const PLAN_APPROVAL_MESSAGE = 'Plan approved, please execute.'

// validateSpawnAttachmentPath removed — use shared validateFilePath from @craft-agent/server-core/handlers

export const PI_TURN_ANCHORS_VERSION = 1

// Performance: Batch IPC delta events to reduce renderer load
export const DELTA_BATCH_INTERVAL_MS = 50

// Flush batched deltas every 50ms
const DEFAULT_SESSION_RUNTIME_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export const DELEGATED_TERMINAL_RESULT_PROTOCOL = '[host-delegated-terminal-result-v1]'

export const MIN_SESSION_RUNTIME_IDLE_TIMEOUT_MS = 60 * 1000

export const SESSION_RUNTIME_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export const SESSION_RUNTIME_DISPOSE_TIMEOUT_MS = 5_000

export const SESSION_RUNTIME_EVICTION_CONCURRENCY = 4

export async function withRuntimeDisposeTimeout(operation: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${SESSION_RUNTIME_DISPOSE_TIMEOUT_MS}ms`))
        }, SESSION_RUNTIME_DISPOSE_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function resolveSessionRuntimeIdleTimeoutMs(): number {
  const configured = process.env.CRAFT_SESSION_RUNTIME_IDLE_TIMEOUT_MS
  if (configured === '0') return 0
  if (!configured) return DEFAULT_SESSION_RUNTIME_IDLE_TIMEOUT_MS

  const parsed = Number(configured)
  if (Number.isFinite(parsed) && parsed >= MIN_SESSION_RUNTIME_IDLE_TIMEOUT_MS) {
    return Math.floor(parsed)
  }

  sessionLog.warn('Ignoring invalid CRAFT_SESSION_RUNTIME_IDLE_TIMEOUT_MS', {
    configured,
    minimumMs: MIN_SESSION_RUNTIME_IDLE_TIMEOUT_MS,
  })
  return DEFAULT_SESSION_RUNTIME_IDLE_TIMEOUT_MS
}

export interface PendingDelta {
  delta: string
  turnId?: string
}
