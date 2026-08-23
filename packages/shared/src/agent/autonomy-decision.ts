import type { HumanEscalationReason } from '@craft-agent/core/types'
import {
  classifyAgentFailure,
  type AgentFailureSignal,
} from './failure-taxonomy.ts'

export type AutonomyDecision =
  | { kind: 'fallback_browser' }
  | { kind: 'reconnect_runtime' }
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
 * Stable operating contract injected into every agent session.
 *
 * Runtime guards remain authoritative. This block aligns model behavior with
 * those guards so routine failures are recovered autonomously instead of being
 * surfaced as premature questions or repeated unchanged attempts.
 */
export function formatAutonomyContract(
  externalActionPolicy: 'confirm' | 'allow-in-execute' = 'confirm',
): string {
  const externalActionAuthorization = externalActionPolicy === 'allow-in-execute'
    ? 'The workspace owner has explicitly configured Execute (allow-all) as standing authorization for in-scope sensitive external actions. In effective allow-all, do not request an additional confirmation solely because an action is sensitive; keep the exact requested scope and target. Ask and Safe remain confirmation-bound.'
    : 'No permission mode expands the task scope or supplies business authorization.'
  return [
    '<autonomy_contract>',
    'Continue through all safe, reversible, in-scope work until the requested outcome is complete and verified.',
    'Make routine implementation choices from repository evidence; ask only when a missing choice would materially change the result or requires new authority.',
    `Apply safe, ask, and allow-all exactly as configured for tool execution. ${externalActionAuthorization}`,
    'Treat secret or credential disclosure or transfer, git push or deployment, service restart, payment or financial submission, and publication or sending to an external audience as sensitive external actions.',
    externalActionPolicy === 'allow-in-execute'
      ? 'In Execute, act on sensitive external actions without another prompt when they are within the user-requested scope and have a concrete target. A generic continuation does not create authority for a new action, target, audience, or broader scope.'
      : 'Before the first sensitive external action, require an explicit user instruction that identifies the action and target or audience well enough to remove material ambiguity. A generic continuation such as "continue", "proceed", or "poursuis" does not authorize a new sensitive external action; when the current request is already explicit, do not ask again.',
    'Continue safe, reversible local edits and local verification without extra confirmation.',
    'After a failure, inspect and classify the exact cause. Never repeat the same action unchanged.',
    'Preserve concrete verifier feedback and observable evidence across attempts; use them to form a materially different next hypothesis.',
    'At every retry checkpoint, compare the observable result with prior attempts. Stop a bounded loop when it is not producing new evidence or progress.',
    'Recovery order: repair invalid input or local configuration; retry transient read-only work with bounded backoff; use a policy-authorized provider or tool fallback; use the integrated browser only for an equivalent safe access path.',
    'Never broaden permissions, bypass policy, expose secrets, or automatically replay an external mutation whose outcome is ambiguous.',
    'Escalate only for interactive authentication or MFA, missing credentials, an external authorization, a material business decision, a destructive action outside the request, or exhausted safe recovery paths.',
    'Completion requires executed verification. Report exact evidence and name every remaining unverified item or blocker.',
    '</autonomy_contract>',
  ].join('\n')
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
  if (failure.recovery === 'runtime-reconnect') {
    return { kind: 'reconnect_runtime' }
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
