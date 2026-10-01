import { describe, expect, it } from 'bun:test'
import { shouldAutomaticallyRecoverClaudeProcessInterruption } from '../claude-agent.ts'

describe('Claude subprocess recovery classification', () => {
  it('recovers infrastructure interruptions that a clean process can resume', () => {
    expect(shouldAutomaticallyRecoverClaudeProcessInterruption('service_unavailable')).toBe(true)
    expect(shouldAutomaticallyRecoverClaudeProcessInterruption('mcp_unreachable')).toBe(true)
    expect(shouldAutomaticallyRecoverClaudeProcessInterruption('unknown_error')).toBe(true)
  })

  it('does not hot-retry failures that require time or human action', () => {
    expect(shouldAutomaticallyRecoverClaudeProcessInterruption('billing_error')).toBe(false)
    expect(shouldAutomaticallyRecoverClaudeProcessInterruption('invalid_credentials')).toBe(false)
    expect(shouldAutomaticallyRecoverClaudeProcessInterruption('token_expired')).toBe(false)
    expect(shouldAutomaticallyRecoverClaudeProcessInterruption('rate_limited')).toBe(false)
  })
})
