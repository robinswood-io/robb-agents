import { describe, expect, it } from 'bun:test'
import { decideAutonomyRecovery } from './autonomy-decision.ts'

const sourceFailure = { toolName: 'mcp__crm__lookup', result: 'HTTP 503 service unavailable', browserEnabled: true, fallbackAlreadyAttempted: false }

describe('decideAutonomyRecovery', () => {
  it('uses the browser as the first safe alternative for a source failure', () => {
    expect(decideAutonomyRecovery(sourceFailure)).toEqual({ kind: 'fallback_browser' })
  })

  it('escalates OAuth and MFA without trying the browser', () => {
    expect(decideAutonomyRecovery({ ...sourceFailure, result: 'OAuth token expired; MFA required' }))
      .toEqual({ kind: 'escalate', reason: 'oauth_or_mfa' })
  })

  it('escalates missing credentials without trying the browser', () => {
    expect(decideAutonomyRecovery({ ...sourceFailure, result: 'Unauthorized: API key is required' }))
      .toEqual({ kind: 'escalate', reason: 'credential_required' })
  })

  it('does not loop after a browser fallback was attempted', () => {
    expect(decideAutonomyRecovery({ ...sourceFailure, fallbackAlreadyAttempted: true })).toEqual({ kind: 'none' })
  })

  it('escalates a browser failure as unavailable access', () => {
    expect(decideAutonomyRecovery({ ...sourceFailure, toolName: 'mcp__session__browser_tool' }))
      .toEqual({ kind: 'escalate', reason: 'access_unavailable_after_fallback' })
  })

  it('uses structured provider status before legacy text parsing', () => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      result: 'generic failure',
      httpStatus: 401,
    })).toEqual({ kind: 'escalate', reason: 'credential_required' })
  })

  it('does not waste a browser fallback on invalid input', () => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      result: 'generic failure',
      errorCode: 'INVALID_ARGUMENT',
    })).toEqual({ kind: 'none' })
  })
})
