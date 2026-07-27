import type { HumanEscalationReason } from '@craft-agent/core/types'
import {
  classifyAgentFailure,
  type AgentFailureSignal,
} from './failure-taxonomy.ts'

export type AutonomyDecision =
  | { kind: 'fallback_browser' }
  | { kind: 'escalate'; reason: HumanEscalationReason }
  | { kind: 'none' }

export interface AutonomyDecisionInput {
  toolName: string
  result: string
  browserEnabled: boolean
  fallbackAlreadyAttempted: boolean
  /** Structured provider/MCP fields. Prefer these over parsing result text. */
  errorCode?: string
  httpStatus?: number
  retryAfterMs?: number
}

/**
 * Decide the next autonomous recovery action for a failed tool result.
 * This is deliberately pure: SessionManager owns persistence, prompts and UI.
 */
export function decideAutonomyRecovery(input: AutonomyDecisionInput): AutonomyDecision {
  const isBrowserTool = /browser_tool|browser:|\bbrowser\b/i.test(input.toolName)
  const signal: AgentFailureSignal = {
    toolName: input.toolName,
    message: input.result,
    ...(input.errorCode ? { code: input.errorCode } : {}),
    ...(typeof input.httpStatus === 'number' ? { httpStatus: input.httpStatus } : {}),
    ...(typeof input.retryAfterMs === 'number' ? { retryAfterMs: input.retryAfterMs } : {}),
  }
  const failure = classifyAgentFailure(signal)

  if (failure.failureClass === 'interactive-auth-required') {
    return { kind: 'escalate', reason: 'oauth_or_mfa' }
  }
  if (failure.failureClass === 'credential-required') {
    return { kind: 'escalate', reason: 'credential_required' }
  }
  if (isBrowserTool || !input.browserEnabled) {
    return { kind: 'escalate', reason: 'access_unavailable_after_fallback' }
  }
  if (
    failure.recovery === 'fix-input'
    || failure.recovery === 'request-authorization'
    || failure.recovery === 'stop'
  ) {
    return { kind: 'none' }
  }
  if (input.fallbackAlreadyAttempted) return { kind: 'none' }
  return { kind: 'fallback_browser' }
}
