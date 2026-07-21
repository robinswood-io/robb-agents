export type AutomationExecutionStatus = 'running' | 'succeeded' | 'retry_scheduled' | 'dead_letter'

export interface AutomationExecutionRecord {
  key: string
  automationId: string
  scheduledFor: string
  attempt: number
  status: AutomationExecutionStatus
  nextAttemptAt?: number
  error?: string
}

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
}

/** A stable key makes a scheduled run idempotent across process restarts. */
export function automationExecutionKey(automationId: string, scheduledFor: string): string {
  return `${automationId}:${scheduledFor}`
}

export function shouldStartAutomation(record: AutomationExecutionRecord | undefined, now: number): boolean {
  return !record
    || (record.status === 'retry_scheduled' && (record.nextAttemptAt ?? Infinity) <= now)
}

export function nextAutomationFailure(
  record: AutomationExecutionRecord,
  error: unknown,
  now: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): AutomationExecutionRecord {
  const message = error instanceof Error ? error.message : String(error)
  if (record.attempt >= policy.maxAttempts) {
    return { ...record, status: 'dead_letter', error: message, nextAttemptAt: undefined }
  }
  const delay = Math.min(policy.baseDelayMs * 2 ** Math.max(0, record.attempt - 1), policy.maxDelayMs)
  return { ...record, status: 'retry_scheduled', error: message, nextAttemptAt: now + delay }
}

export function succeedAutomation(record: AutomationExecutionRecord): AutomationExecutionRecord {
  return { ...record, status: 'succeeded', error: undefined, nextAttemptAt: undefined }
}
