export const COST_CONTROL_COMPACTION_INSTRUCTIONS = [
  'Create a precise, fact-preserving operational handoff for the current task.',
  'Use concise sections for: current objective; verified state and evidence; decisions and user constraints;',
  'exact paths, identifiers, values, and external effects; unresolved work, blockers, and the next safe action.',
  'Distinguish verified facts from hypotheses, preserve negative findings and pending approvals, and do not invent details.',
  'Remove raw tool output, repeated progress chatter, acknowledgements, and superseded attempts.',
].join(' ')

export type AgentContextCompactionResult = {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter?: number
}

export type ContextCompactionOutcome = 'succeeded' | 'ineffective' | 'unverified' | 'failed'

export interface ContextCompactionAssessment {
  outcome: Exclude<ContextCompactionOutcome, 'failed'>
  issues: string[]
  tokensBefore?: number
  tokensAfter?: number
  reclaimedTokens?: number
  reductionRatio?: number
}

export interface ContextCompactionAttemptState {
  attemptedAt: number
  contextTokensBefore: number
  outcome: ContextCompactionOutcome
}

export const CONTEXT_COMPACTION_RETRY_COOLDOWN_MS = 10 * 60 * 1_000
const MIN_VERIFIABLE_SUMMARY_CHARS = 40
const MATERIAL_CONTEXT_GROWTH_RATIO = 1.25
const REQUIRED_SUMMARY_SECTIONS = [
  '## Goal',
  '## Constraints & Preferences',
  '## Progress',
  '## Key Decisions',
  '## Next Steps',
  '## Critical Context',
] as const
const UNRESOLVED_TEMPLATE_PATTERN = /\[(?:What is the user trying|Any constraints|Completed tasks|Current work|Issues preventing|Decision|Ordered list|Any data)/i

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/**
 * Verify the provider's post-compaction measurements before using them for
 * routing or cost telemetry. The SDK has already applied the compaction when
 * this runs, so malformed results are reported as unverified, never retried
 * immediately in a loop.
 */
export function assessContextCompactionResult(
  result: AgentContextCompactionResult | null,
): ContextCompactionAssessment {
  if (!result) {
    return { outcome: 'unverified', issues: ['missing-result'] }
  }

  const issues: string[] = []
  const summary = typeof result.summary === 'string' ? result.summary.trim() : ''
  const firstKeptEntryId = typeof result.firstKeptEntryId === 'string'
    ? result.firstKeptEntryId.trim()
    : ''
  const tokensBefore = finiteNonNegativeInteger(result.tokensBefore)
  const tokensAfter = finiteNonNegativeInteger(result.estimatedTokensAfter)

  if (summary.length < MIN_VERIFIABLE_SUMMARY_CHARS) issues.push('summary-too-short')
  if (!REQUIRED_SUMMARY_SECTIONS.every(section => summary.includes(section))) {
    issues.push('missing-required-sections')
  }
  if (UNRESOLVED_TEMPLATE_PATTERN.test(summary)) issues.push('unresolved-template-placeholders')
  if (!firstKeptEntryId) issues.push('missing-kept-entry')
  if (tokensBefore === undefined || tokensBefore === 0) issues.push('invalid-tokens-before')
  if (tokensAfter === undefined) issues.push('invalid-tokens-after')

  if (issues.length > 0 || tokensBefore === undefined || tokensAfter === undefined) {
    return { outcome: 'unverified', issues, tokensBefore, tokensAfter }
  }

  const reclaimedTokens = Math.max(0, tokensBefore - tokensAfter)
  const reductionRatio = tokensBefore > 0 ? reclaimedTokens / tokensBefore : 0
  if (tokensAfter >= tokensBefore) {
    return {
      outcome: 'ineffective',
      issues: ['no-token-reduction'],
      tokensBefore,
      tokensAfter,
      reclaimedTokens,
      reductionRatio,
    }
  }

  return {
    outcome: 'succeeded',
    issues: [],
    tokensBefore,
    tokensAfter,
    reclaimedTokens,
    reductionRatio,
  }
}

/** Prevent an unsuccessful or ineffective compaction from being billed again on every queued turn. */
export function shouldAttemptContextCompaction(input: {
  contextTokens: number
  compactAtTokens: number
  now: number
  previous?: ContextCompactionAttemptState
}): boolean {
  if (input.contextTokens < input.compactAtTokens) return false
  if (!input.previous || input.previous.outcome === 'succeeded') return true

  const cooldownElapsed = input.now - input.previous.attemptedAt >= CONTEXT_COMPACTION_RETRY_COOLDOWN_MS
  const contextGrewMaterially = input.contextTokens >= Math.ceil(
    input.previous.contextTokensBefore * MATERIAL_CONTEXT_GROWTH_RATIO,
  )
  return cooldownElapsed || contextGrewMaterially
}

export function classifyContextCompactionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed? out|timeout|did not settle|did not finish/i.test(message)) return 'timeout'
  if (/already compacted|nothing to compact|too small/i.test(message)) return 'not-needed'
  if (/auth|credential|unauthori[sz]ed|forbidden/i.test(message)) return 'authentication'
  if (/abort|cancel/i.test(message)) return 'aborted'
  return 'backend-error'
}
