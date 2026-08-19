import { describe, expect, it } from 'bun:test'
import { decideAutonomyRecovery, formatAutonomyContract } from './autonomy-decision.ts'

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

describe('formatAutonomyContract sensitive external action guard', () => {
  const contract = formatAutonomyContract()

  it('keeps permission modes separate from task-level authorization', () => {
    expect(contract).toContain('Apply safe, ask, and allow-all exactly as configured')
    expect(contract).toContain('No permission mode expands the task scope or supplies business authorization')
  })

  it('covers the observed sensitive external action categories', () => {
    expect(contract).toContain('secret or credential disclosure or transfer')
    expect(contract).toContain('git push or deployment')
    expect(contract).toContain('service restart')
    expect(contract).toContain('payment or financial submission')
    expect(contract).toContain('publication or sending to an external audience')
  })

  it('rejects ambiguous continuation without re-prompting explicit requests', () => {
    expect(contract).toContain('A generic continuation such as "continue", "proceed", or "poursuis" does not authorize')
    expect(contract).toContain('when the current request is already explicit, do not ask again')
  })

  it('preserves safe and reversible local work without extra confirmation', () => {
    expect(contract).toContain('Continue safe, reversible local edits and local verification without extra confirmation')
  })
})
