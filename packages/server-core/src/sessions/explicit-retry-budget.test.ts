import { describe, expect, it } from 'bun:test'
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions'
import {
  advancePendingTurnRecovery, grantExplicitRetryAllowance, hasAvailableExplicitRetryAllowance,
  exhaustPendingTurnRecovery, DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS,
} from './turn-recovery'
import { explicitRetryProgressFingerprint } from './explicit-retry-progress'
import { turnProgressFingerprint } from './objective-contract'
import type { Message } from '@craft-agent/core/types'

const old = (): PendingTurnRecovery => ({ userMessageId: 'user', startedAt: 1, attempts: 2,
  exhaustedAt: 3, leaseExpiresAt: 10, stagnantAttempts: 2, lastProgressFingerprint: 'old', validationGaps: ['gap'] })
const grant = (pending = old(), nowMs = 100, id = 'grant-1') => grantExplicitRetryAllowance(pending, {
  id, objectiveId: 'objective', userMessageId: 'user', nowMs, maxAttempts: 8,
  progressFingerprint: 'gap', semanticProgressFingerprint: 'proof-0',
})
const advance = (pending: PendingTurnRecovery, progress: string, semantic = progress, cause: 'tool_checkpoint' | 'runtime_error' = 'tool_checkpoint', now = 200) =>
  advancePendingTurnRecovery(pending, cause, now, 8, progress, 2, undefined, undefined,
    { objectiveId: 'objective', semanticProgressFingerprint: semantic })

describe('prospective allowance bounds preserve historical counters', () => {
  it('preserves exhausted history and reuses remaining allowance instead of reallocating on Stop/Retry', () => {
    const before = old(); const pending = grant(before)
    expect({ ...pending, explicitRetryAllowances: undefined }).toEqual({ ...before, explicitRetryAllowances: undefined })
    const once = advance(pending, 'proof-1')!
    expect(once.attempts).toBe(3)
    expect(once.explicitRetryAllowances?.[0]?.attempts).toBe(1)
    expect(grant(once, 300, 'another-click')).toBe(once)
    expect(before).toEqual(old())
  })

  it('uses only the remaining attempts below the absolute cumulative ceiling', () => {
    let pending = grant()
    expect(pending.explicitRetryAllowances?.[0]?.maxAttempts).toBe(6)
    for (let i = 1; i <= 6; i++) pending = advance(pending, `proof-${i}`)!
    expect(pending.attempts).toBe(8)
    expect(advance(pending, 'proof-7')).toBeNull()
    const renewed = grant(exhaustPendingTurnRecovery(pending, 210), 300, 'grant-2')
    expect(renewed).toEqual(exhaustPendingTurnRecovery(pending, 210))
    expect(advance(renewed, 'proof-7', 'proof-7', 'tool_checkpoint', 400)).toBeNull()
  })

  it('keeps the absolute eight-attempt ceiling even when another user explicitly retries', () => {
    const pending = grant({ ...old(), attempts: 7 })
    expect(pending.explicitRetryAllowances?.[0]?.maxAttempts).toBe(1)
    const last = advance(pending, 'proof-1')!
    expect(last.attempts).toBe(8)
    expect(advance(last, 'proof-2')).toBeNull()
    expect(grant(last, 500)).toBe(last)
  })

  it.each([undefined, false])('does not allocate for a non-exhausted known budget (%s)', missing => {
    const pending = { userMessageId: 'user', startedAt: 1, attempts: 2, ...(missing === false ? { leaseExpiresAt: 500 } : {}) }
    expect(grant(pending)).toBe(pending)
  })

  it.each([NaN, Infinity, -1, 1.5, 8, 256])('never fabricates allowance for invalid/capped history%s', attempts => {
    const pending = { ...old(), attempts }
    expect(grant(pending)).toBe(pending)
  })

  it('preserves unknown history and refuses automatic admission', () => {
    const pending = { ...old(), budgetHistoryUnavailable: true }
    expect(grant(pending)).toBe(pending)
    expect(advance(pending, 'progress')).toBeNull()
  })

  it('preserves legacy rollback refusal when the new field is ignored', () => {
    const pending = grant()
    const { explicitRetryAllowances: _ignoredByOldHost, ...rollback } = pending
    expect(advancePendingTurnRecovery(rollback, 'app_restart', 200, 8, 'new-proof')).toBeNull()
    expect(rollback.exhaustedAt).toBe(3)
  })

  it('rejects expired, malformed and differently bound grants without renewing them', () => {
    const pending = grant()
    expect(hasAvailableExplicitRetryAllowance(pending, 'other', 200)).toBe(false)
    expect(advancePendingTurnRecovery(pending, 'app_restart', 200, 8, 'proof')).toBeNull()
    expect(advance(pending, 'proof', 'proof', 'runtime_error', 100 + DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS)).toBeNull()
    const malformed = structuredClone(pending);malformed.explicitRetryAllowances![0]!.attempts = -1
    expect(grant(malformed)).toBe(malformed)
    expect(advance(malformed, 'proof')).toBeNull()
  })

  it('refuses a no-progress checkpoint immediately and unchanged validation after two tries', () => {
    const pending = grant()
    expect(advance(pending, 'other', 'proof-0')).toBeNull()
    const once = advance(pending, 'gap', 'proof-1')!
    expect(once.explicitRetryAllowances?.[0]?.stagnantAttempts).toBe(1)
    expect(advance(once, 'gap', 'proof-2')).toBeNull()
    const failedOnce = advance(pending, 'gap', 'proof-0', 'runtime_error')!
    expect(advance(failedOnce, 'gap', 'proof-0', 'runtime_error')).toBeNull()
  })
})

describe('browser capture churn grants no extra checkpoint passage', () => {
  const user: Message = { id: 'user', role: 'user', content: 'Verify the target.', timestamp: 1 }
  function capture(index: number): Message[] {
    const path = `/fixture/browser-capture-${index}.jpg`
    return [
      { id: `capture-${index}`, role: 'tool', toolName: 'mcp__session__browser_tool', toolUseId: `c${index}`,
        toolInput: { command: 'screenshot-region 0 0 400 400' }, toolResult: `Region screenshot captured\nCapture time: ${index}ms\nSaved screenshot: ${path}`,
        content: 'Capture', toolExecuted: true, toolStatus: 'completed', timestamp: index + 2 },
      { id: `read-${index}`, role: 'tool', toolName: 'Read', toolUseId: `r${index}`, toolInput: { file_path: path },
        toolResult: `Image at ${path}`, content: 'Read', toolExecuted: true, toolStatus: 'completed', timestamp: index + 3 },
    ]
  }
  it.each(['string', 'array'] as const)('neutralizes changing screenshot filenames and their Read receipts (%s), without changing evidence', mode => {
    const initial = [user, ...capture(1)];const after = [...initial, ...capture(2), ...capture(3)]
    if (mode === 'array') for (const message of after) {
      if (message.toolName === 'mcp__session__browser_tool') message.toolInput!.command = ['screenshot-region', '0', '0', '400', '400']
    }
    const snapshot = structuredClone(after)
    expect(turnProgressFingerprint(initial, 'user')).not.toBe(turnProgressFingerprint(after, 'user'))
    expect(explicitRetryProgressFingerprint(initial, 'user')).toBe(explicitRetryProgressFingerprint(after, 'user'))
    expect(after).toEqual(snapshot)
  })
  it('keeps a non-capture image and a genuine target observation as progress', () => {
    const initial = [user, ...capture(1)]
    for (const path of ['/fixture/user-provided-chart.jpg', '/fixture/state.json']) {
      const after = [...initial, { id: 'real', role: 'tool' as const, toolName: 'Read', toolInput: { path },
        toolResult: 'Independent target observation', content: 'Read', toolStatus: 'completed' as const, toolExecuted: true, timestamp: 9 }]
      expect(explicitRetryProgressFingerprint(initial, 'user')).not.toBe(explicitRetryProgressFingerprint(after, 'user'))
    }
  })
})
