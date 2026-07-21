import { describe, expect, it } from 'bun:test'
import { automationExecutionKey, nextAutomationFailure, shouldStartAutomation, succeedAutomation, type AutomationExecutionRecord } from './execution-policy.ts'

const record: AutomationExecutionRecord = {
  key: automationExecutionKey('daily-intake', '2026-07-21T09:00:00+02:00'),
  automationId: 'daily-intake',
  scheduledFor: '2026-07-21T09:00:00+02:00',
  attempt: 1,
  status: 'running',
}

describe('automation execution policy', () => {
  it('creates a stable idempotency key and prevents duplicate starts', () => {
    expect(record.key).toBe('daily-intake:2026-07-21T09:00:00+02:00')
    expect(shouldStartAutomation({ ...record, status: 'running' }, Date.now())).toBeFalse()
    expect(shouldStartAutomation({ ...record, status: 'succeeded' }, Date.now())).toBeFalse()
  })

  it('schedules bounded exponential retry then dead-letters', () => {
    const retry = nextAutomationFailure(record, new Error('temporary outage'), 1_000, { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 })
    expect(retry).toMatchObject({ status: 'retry_scheduled', nextAttemptAt: 1_100 })
    expect(shouldStartAutomation(retry, 1_099)).toBeFalse()
    expect(shouldStartAutomation(retry, 1_100)).toBeTrue()
    expect(nextAutomationFailure({ ...retry, attempt: 2 }, 'still failing', 2_000, { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 }))
      .toMatchObject({ status: 'dead_letter', error: 'still failing' })
  })

  it('clears transient failure details on success', () => {
    expect(succeedAutomation({ ...record, status: 'retry_scheduled', error: 'temporary outage', nextAttemptAt: 2_000 }))
      .toMatchObject({ status: 'succeeded', error: undefined, nextAttemptAt: undefined })
  })
})
