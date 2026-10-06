import type {
  ContextCompactionAttemptState as PersistedContextCompactionAttemptState,
  ContextCompactionIssueCode,
  ContextCompactionOutcome as PersistedContextCompactionOutcome,
} from '@craft-agent/shared/sessions'

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

export type ContextCompactionOutcome = PersistedContextCompactionOutcome

export interface ContextCompactionAssessment {
  outcome: 'succeeded' | 'ineffective' | 'unverified'
  issues: string[]
  tokensBefore?: number
  tokensAfter?: number
  reclaimedTokens?: number
  reductionRatio?: number
}

export type ContextCompactionAttemptState = PersistedContextCompactionAttemptState

export const CONTEXT_COMPACTION_RETRY_COOLDOWN_MS = 10 * 60 * 1_000
const MIN_VERIFIABLE_SUMMARY_CHARS = 40
const MATERIAL_CONTEXT_GROWTH_PERCENT = 10
const MIN_MATERIAL_CONTEXT_GROWTH_TOKENS = 4_096
const REQUIRED_SUMMARY_SECTIONS = [
  '## Goal',
  '## Constraints & Preferences',
  '## Progress',
  '## Key Decisions',
  '## Next Steps',
  '## Critical Context',
] as const
const REQUIRED_SPLIT_TURN_SUMMARY_SECTIONS = [
  '## Original Request',
  '## Early Progress',
  '## Context for Suffix',
] as const
const SPLIT_TURN_SUMMARY_MARKER = '**Turn Context (split turn):**'
const UNRESOLVED_TEMPLATE_PATTERN = /\[(?:What is the user trying|Any constraints|Completed tasks|Current work|Issues preventing|Decision|Ordered list|Any data)/i

const BILINGUAL_REQUIRED_SUMMARY_SECTION_PATTERNS = [
  /(?:^|\n)#{1,3}\s*(?:Goal|Objectif|But)\b/iu,
  /(?:^|\n)#{1,3}\s*(?:Constraints(?:\s*(?:&|and)\s*Preferences)?|Contraintes(?:\s*(?:&|et)\s*Pr[ée]f[ée]rences)?)\b/iu,
  /(?:^|\n)#{1,3}\s*(?:Progress|Progr[èe]s|Avancement)\b/iu,
  /(?:^|\n)#{1,3}\s*(?:(?:Key\s+)?Decisions?|D[ée]cisions?(?:\s+Cl[ée]s?)?)\b/iu,
  /(?:^|\n)#{1,3}\s*(?:Next\s+Steps?|Prochaines?\s+[ée]tapes?|[ée]tapes?\s+suivantes?)\b/iu,
  /(?:^|\n)#{1,3}\s*(?:Critical\s+Context|Contexte(?:\s+critique)?)\b/iu,
] as const

const BILINGUAL_SPLIT_TURN_SECTION_PATTERNS = [
  /(?:^|\n)#{1,3}\s*(?:Original\s+Request|Demande\s+initiale|Requ[êe]te\s+initiale)\b/iu,
  /(?:^|\n)#{1,3}\s*(?:Early\s+Progress|Premiers\s+progr[èe]s|Avancement\s+initial)\b/iu,
  /(?:^|\n)#{1,3}\s*(?:Context\s+for\s+Suffix|Contexte\s+pour\s+la\s+suite)\b/iu,
] as const

const BILINGUAL_SPLIT_TURN_MARKER_PATTERN = /\*\*(?:Turn Context \(split turn\)|Contexte de tour \(tour divisé\)):\*\*/iu

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function hasRequiredSummarySections(summary: string): boolean {
  const hasExactEnglish = REQUIRED_SUMMARY_SECTIONS.every(section => summary.includes(section))
  if (hasExactEnglish) return true

  const hasBilingualSections = BILINGUAL_REQUIRED_SUMMARY_SECTION_PATTERNS.every(pattern => pattern.test(summary))
  if (hasBilingualSections) return true

  // The pi SDK deliberately uses a different schema when compaction cuts
  // inside an oversized turn. Its prefix summary is merged with the retained
  // suffix and cannot honor the normal history-summary headings.
  const hasSplitTurnMarker = summary.includes(SPLIT_TURN_SUMMARY_MARKER) || BILINGUAL_SPLIT_TURN_MARKER_PATTERN.test(summary)
  if (hasSplitTurnMarker) {
    const hasSplitEnglish = REQUIRED_SPLIT_TURN_SUMMARY_SECTIONS.every(section => summary.includes(section))
    if (hasSplitEnglish) return true
    return BILINGUAL_SPLIT_TURN_SECTION_PATTERNS.every(pattern => pattern.test(summary))
  }

  return false
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
  if (!hasRequiredSummarySections(summary)) {
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

export type ContextCompactionDecisionInput = {
  contextTokens: number
  compactAtTokens: number
  hardLimitTokens?: number
  objectiveRootId?: string
  now: number
  previous?: ContextCompactionAttemptState
}

export type ContextProviderAdmissionDecision =
  | {
      action: 'allow-provider'
      reason: 'below-hard-limit' | 'compacted-context-awaiting-provider-baseline'
    }
  | {
      action: 'compact-first'
      reason: 'hard-limit-uncompacted' | 'hard-limit-retry-ready'
    }
  | {
      action: 'start-clean-continuation'
      reason: 'compaction-unavailable' | 'hard-limit-compaction-not-ready'
    }

function belongsToSameObjective(input: ContextCompactionDecisionInput): boolean {
  const previousObjectiveRootId = input.previous?.objectiveRootId
  return previousObjectiveRootId === undefined
    || input.objectiveRootId === undefined
    || previousObjectiveRootId === input.objectiveRootId
}

/** Capture the first provider-scale context measurement after host compaction. */
export function captureProviderContextBaseline(
  previous: ContextCompactionAttemptState | undefined,
  contextTokens: unknown,
): ContextCompactionAttemptState | undefined {
  if (!previous || previous.outcome !== 'succeeded'
    || previous.providerContextBaselineTokens !== undefined) return previous
  const providerContextBaselineTokens = finiteNonNegativeInteger(contextTokens)
  if (providerContextBaselineTokens === undefined || providerContextBaselineTokens === 0) return previous
  const captured = {
    ...previous,
    providerContextBaselineTokens,
  }
  delete captured.awaitingProviderContextBaseline
  delete captured.providerBaselineAdmissionDispatchedAt
  return captured
}

/** Consume the sole provider admission opened by a successful hard-limit
 * compaction. The returned marker must be fsynced before provider handoff. */
export function consumeContextProviderBaselineAdmission(
  previous: ContextCompactionAttemptState | undefined,
  now: number,
): ContextCompactionAttemptState | undefined {
  if (!previous || previous.outcome !== 'succeeded'
    || previous.awaitingProviderContextBaseline !== true
    || previous.providerContextBaselineTokens !== undefined
    || previous.providerBaselineAdmissionDispatchedAt !== undefined
    || !Number.isSafeInteger(now) || now < 0) return undefined
  return { ...previous, providerBaselineAdmissionDispatchedAt: now }
}

/** Identify the one follow-up pass allowed after a successful above-limit compaction. */
export function isHardLimitFollowUpContextCompaction(
  input: ContextCompactionDecisionInput,
): boolean {
  const previous = input.previous
  const hardLimitTokens = input.hardLimitTokens
  return previous !== undefined
    && hardLimitTokens !== undefined
    && input.contextTokens >= hardLimitTokens
    && previous.outcome === 'succeeded'
    && finiteNonNegativeInteger(previous.providerContextBaselineTokens) !== undefined
    && previous.hardLimitTokens === hardLimitTokens
    && previous.contextTokensBefore >= hardLimitTokens
    && previous.hardLimitFollowUpAttempted !== true
}

function isCoveredHardLimitContextCompaction(
  input: ContextCompactionDecisionInput,
): boolean {
  const previous = input.previous
  const hardLimitTokens = input.hardLimitTokens
  return previous !== undefined
    && hardLimitTokens !== undefined
    && input.contextTokens >= hardLimitTokens
    && previous.hardLimitTokens === hardLimitTokens
    && previous.contextTokensBefore >= hardLimitTokens
    && previous.hardLimitFollowUpAttempted === true
    && previous.hardLimitRecoveryAttempted !== true
}

function isRetryableFailedHardLimitContextCompaction(
  input: ContextCompactionDecisionInput,
): boolean {
  const previous = input.previous
  const hardLimitTokens = input.hardLimitTokens
  return previous !== undefined
    && hardLimitTokens !== undefined
    && input.contextTokens >= hardLimitTokens
    && previous.outcome === 'failed'
    && previous.hardLimitTokens === hardLimitTokens
    && previous.contextTokensBefore >= hardLimitTokens
    && previous.hardLimitRecoveryAttempted !== true
}

/** Identify any above-limit recovery whose receipt must retain the consumed
 * follow-up marker: either the immediate follow-up or the single delayed retry
 * opened after it. */
export function isHardLimitRecoveryContextCompaction(
  input: ContextCompactionDecisionInput,
): boolean {
  return isHardLimitFollowUpContextCompaction(input)
    || (isCoveredHardLimitContextCompaction(input)
      || isRetryableFailedHardLimitContextCompaction(input))
      && input.now - input.previous!.attemptedAt >= CONTEXT_COMPACTION_RETRY_COOLDOWN_MS
}

/** Prevent the same context from being compacted and billed again on every queued turn. */
export function shouldAttemptContextCompaction(input: ContextCompactionDecisionInput): boolean {
  if (input.contextTokens < input.compactAtTokens) return false
  if (!input.previous) return true

  const previousContextTokensBefore = input.previous.contextTokensBefore
  const providerContextBaselineTokens = finiteNonNegativeInteger(
    input.previous.providerContextBaselineTokens,
  )
  // A successful compaction receipt is a durable lock until the next actual
  // provider measurement. The SDK's estimatedTokensAfter counts retained
  // messages on a different scale and must never unlock growth or hard-limit
  // recovery, including after a cold restart.
  if (input.previous.outcome === 'succeeded' && providerContextBaselineTokens === undefined) {
    return false
  }
  // A successful compaction changes the session-global provider context, so
  // its measured baseline remains authoritative even if a user replaces the
  // objective. Failure/no-op cooldowns stay scoped to the stable objective
  // root, allowing a genuinely different task to make a fresh decision.
  if (input.previous.outcome !== 'succeeded' && !belongsToSameObjective(input)) return true
  const previousGrowthBaseline = input.previous.outcome === 'succeeded'
    ? providerContextBaselineTokens!
    : previousContextTokensBefore
  const materialGrowthTokens = Math.max(
    MIN_MATERIAL_CONTEXT_GROWTH_TOKENS,
    Math.ceil(previousGrowthBaseline * MATERIAL_CONTEXT_GROWTH_PERCENT / 100),
  )
  const contextGrewMaterially = input.contextTokens >= previousGrowthBaseline + materialGrowthTokens
  const cooldownElapsed = input.now - input.previous.attemptedAt >= CONTEXT_COMPACTION_RETRY_COOLDOWN_MS
  // Legacy attempts did not record which hard limit they had covered. Allow
  // one immediate attempt whenever the current context is still above that
  // boundary, even if the estimate shrank from an even larger value. The next
  // attempt persists hardLimitTokens, which makes this exception one-shot.
  const reachedUncoveredHardLimit = input.hardLimitTokens !== undefined
    && input.contextTokens >= input.hardLimitTokens
    && !(
      input.previous.hardLimitTokens === input.hardLimitTokens
      && previousContextTokensBefore >= input.hardLimitTokens
    )
  const needsHardLimitFollowUp = isHardLimitFollowUpContextCompaction(input)
  // Once the immediate hard-limit follow-up has been consumed, allow one
  // delayed recovery. Its distinct persisted marker closes the budget across
  // later cooldowns and cold restarts regardless of that recovery's outcome.
  const coveredHardLimit = isCoveredHardLimitContextCompaction(input)
  const needsCoveredHardLimitRetry = coveredHardLimit && cooldownElapsed
  const coveredRecoveryBudgetConsumed = input.previous.hardLimitRecoveryAttempted === true
  if (coveredRecoveryBudgetConsumed) {
    return reachedUncoveredHardLimit || contextGrewMaterially
  }
  // A successful compaction already handled the context available at that
  // point. One explicit follow-up is still allowed when it left the current
  // context above the same hard limit, followed by one delayed recovery whose
  // persisted marker permanently closes this budget for unchanged context.
  if (input.previous.outcome === 'succeeded') {
    return needsHardLimitFollowUp
      || needsCoveredHardLimitRetry
      || reachedUncoveredHardLimit
      || contextGrewMaterially
  }
  // The SDK can know that the retained history is not compactable even when
  // our conservative token estimate crosses the threshold. Time alone does
  // not change that fact, so avoid paying for the same no-op every cooldown.
  if (input.previous.outcome === 'skipped-not-needed' || input.previous.issueCode === 'not-needed') {
    return needsCoveredHardLimitRetry || reachedUncoveredHardLimit || contextGrewMaterially
  }

  return needsCoveredHardLimitRetry || reachedUncoveredHardLimit || cooldownElapsed || contextGrewMaterially
}

/**
 * Fail-closed provider admission at the effective hard context limit.
 *
 * `shouldAttemptContextCompaction` intentionally applies cooldowns to avoid
 * repeatedly billing the same failed compaction. A cooldown is not permission
 * to send the oversized history to a provider: once the hard boundary is
 * reached the host must either compact first or create a fresh continuation.
 * The sole exception is the first provider call after a successful persisted
 * compaction, which is needed to capture the like-for-like provider baseline.
 */
export function decideContextProviderAdmission(
  input: ContextCompactionDecisionInput & { canCompactContext: boolean },
): ContextProviderAdmissionDecision {
  if (input.hardLimitTokens === undefined || input.contextTokens < input.hardLimitTokens) {
    return { action: 'allow-provider', reason: 'below-hard-limit' }
  }

  const previous = input.previous
  const successfulCompactionAwaitingProvider = previous?.outcome === 'succeeded'
    && previous.awaitingProviderContextBaseline === true
    && previous.hardLimitTokens === input.hardLimitTokens
    && finiteNonNegativeInteger(previous.providerContextBaselineTokens) === undefined
    && finiteNonNegativeInteger(previous.providerBaselineAdmissionDispatchedAt) === undefined
  if (successfulCompactionAwaitingProvider) {
    return {
      action: 'allow-provider',
      reason: 'compacted-context-awaiting-provider-baseline',
    }
  }

  if (!input.canCompactContext) {
    return { action: 'start-clean-continuation', reason: 'compaction-unavailable' }
  }

  if (shouldAttemptContextCompaction(input)) {
    return {
      action: 'compact-first',
      reason: previous ? 'hard-limit-retry-ready' : 'hard-limit-uncompacted',
    }
  }

  return {
    action: 'start-clean-continuation',
    reason: 'hard-limit-compaction-not-ready',
  }
}

export function classifyContextCompactionFailure(error: unknown): ContextCompactionIssueCode {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed? out|timeout|did not settle|did not finish/i.test(message)) return 'timeout'
  if (/already compacted|nothing to compact|too small/i.test(message)) return 'not-needed'
  if (/auth|credential|unauthori[sz]ed|forbidden/i.test(message)) return 'authentication'
  if (/abort|cancel/i.test(message)) return 'aborted'
  return 'backend-error'
}
