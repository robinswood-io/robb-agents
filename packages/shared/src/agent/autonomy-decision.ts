import type { HumanEscalationReason } from '@craft-agent/core/types'

export type AutonomyDecision =
  | { kind: 'fallback_browser' }
  | { kind: 'escalate'; reason: HumanEscalationReason }
  | { kind: 'none' }

export interface AutonomyDecisionInput {
  toolName: string
  result: string
  browserEnabled: boolean
  fallbackAlreadyAttempted: boolean
}

/**
 * Decide the next autonomous recovery action for a failed tool result.
 * This is deliberately pure: SessionManager owns persistence, prompts and UI.
 */
export function decideAutonomyRecovery(input: AutonomyDecisionInput): AutonomyDecision {
  const text = input.result.toLowerCase()
  const isBrowserTool = /browser_tool|browser:|\bbrowser\b/i.test(input.toolName)

  if (/\boauth\b|\bmfa\b|multi.factor|two.factor/.test(text)) {
    return { kind: 'escalate', reason: 'oauth_or_mfa' }
  }
  if (/credential|api key|access token|token.*expired|unauthori[sz]ed/.test(text)) {
    return { kind: 'escalate', reason: 'credential_required' }
  }
  if (isBrowserTool || !input.browserEnabled) {
    return { kind: 'escalate', reason: 'access_unavailable_after_fallback' }
  }
  if (input.fallbackAlreadyAttempted) return { kind: 'none' }
  return { kind: 'fallback_browser' }
}
