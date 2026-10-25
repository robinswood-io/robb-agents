import { describe, expect, test } from "bun:test";
import { CONTEXT_COMPACTION_RETRY_COOLDOWN_MS, captureProviderContextBaseline, classifyContextCompactionFailure, consumeContextProviderBaselineAdmission, decideContextProviderAdmission, isHardLimitFollowUpContextCompaction, isHardLimitRecoveryContextCompaction, shouldAttemptContextCompaction } from "./context-compaction";

describe('context compaction', () => {

  test('requires compaction before the first provider call at the hard limit', () => {
    expect(decideContextProviderAdmission({
      contextTokens: 100_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      canCompactContext: true,
    })).toEqual({
      action: 'compact-first',
      reason: 'hard-limit-uncompacted',
    })
    expect(decideContextProviderAdmission({
      contextTokens: 100_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      canCompactContext: false,
    })).toEqual({
      action: 'start-clean-continuation',
      reason: 'compaction-unavailable',
    })
  })

  test('admits exactly the provider measurement after a successful compaction', () => {
    const awaitingProviderBaseline = {
      attemptedAt: 1_000,
      contextTokensBefore: 90_000,
      contextTokensAfter: 20_000,
      outcome: 'succeeded' as const,
      awaitingProviderContextBaseline: true as const,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
    }
    expect(decideContextProviderAdmission({
      contextTokens: 120_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      previous: awaitingProviderBaseline,
      canCompactContext: true,
    })).toEqual({
      action: 'allow-provider',
      reason: 'compacted-context-awaiting-provider-baseline',
    })

    const consumed = consumeContextProviderBaselineAdmission(awaitingProviderBaseline, 2_001)!
    expect(consumed.providerBaselineAdmissionDispatchedAt).toBe(2_001)
    expect(decideContextProviderAdmission({
      contextTokens: 120_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 2_002,
      previous: consumed,
      canCompactContext: true,
    })).toEqual({
      action: 'start-clean-continuation',
      reason: 'hard-limit-compaction-not-ready',
    })

    expect(decideContextProviderAdmission({
      contextTokens: 120_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 2_002,
      previous: { ...awaitingProviderBaseline, awaitingProviderContextBaseline: undefined },
      canCompactContext: true,
    })).toEqual({
      action: 'start-clean-continuation',
      reason: 'hard-limit-compaction-not-ready',
    })

    const measuredAboveLimit = captureProviderContextBaseline(
      awaitingProviderBaseline,
      120_000,
    )!
    expect(decideContextProviderAdmission({
      contextTokens: 120_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      previous: measuredAboveLimit,
      canCompactContext: true,
    })).toEqual({
      action: 'compact-first',
      reason: 'hard-limit-retry-ready',
    })
  })

  test('allows ordinary provider dispatch only below the hard limit', () => {
    expect(decideContextProviderAdmission({
      contextTokens: 99_999,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      now: 2_000,
      canCompactContext: false,
    })).toEqual({ action: 'allow-provider', reason: 'below-hard-limit' })
  })

  test('covers an already-exceeded hard limit once and materializes the anti-loop guard', () => {
    const legacyAttemptAboveLimit = {
      attemptedAt: 1_000,
      contextTokensBefore: 400_000,
      outcome: 'skipped-not-needed' as const,
      issueCode: 'not-needed' as const,
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 360_000,
      compactAtTokens: 300_000,
      hardLimitTokens: 350_000,
      now: 2_000,
      previous: legacyAttemptAboveLimit,
    })).toBe(true)

    expect(shouldAttemptContextCompaction({
      contextTokens: 360_000,
      compactAtTokens: 300_000,
      hardLimitTokens: 350_000,
      now: 1_000 + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * 4,
      previous: {
        ...legacyAttemptAboveLimit,
        contextTokensBefore: 360_000,
        hardLimitTokens: 350_000,
      },
    })).toBe(false)
  })

  test('allows exactly one immediate follow-up when a successful compaction remains above the hard limit', () => {
    const successfulAttemptAboveLimit = {
      attemptedAt: 1_000,
      contextTokensBefore: 400_000,
      outcome: 'succeeded' as const,
      providerContextBaselineTokens: 360_000,
      hardLimitTokens: 350_000,
    }
    const followUpDecision = {
      contextTokens: 360_000,
      compactAtTokens: 300_000,
      hardLimitTokens: 350_000,
      now: 2_000,
      previous: successfulAttemptAboveLimit,
    }
    expect(isHardLimitFollowUpContextCompaction(followUpDecision)).toBe(true)
    expect(shouldAttemptContextCompaction(followUpDecision)).toBe(true)

    const consumedFollowUpDecision = {
      ...followUpDecision,
      contextTokens: 355_000,
      now: 1_000 + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS - 1,
      previous: {
        ...successfulAttemptAboveLimit,
        contextTokensBefore: 360_000,
        hardLimitFollowUpAttempted: true as const,
      },
    }
    expect(isHardLimitFollowUpContextCompaction(consumedFollowUpDecision)).toBe(false)
    expect(shouldAttemptContextCompaction(consumedFollowUpDecision)).toBe(false)
  })

  test('spends one delayed hard-limit recovery then stays closed across every later cooldown', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 178_844,
      contextTokensAfter: 23_555,
      providerContextBaselineTokens: 171_095,
      outcome: 'succeeded' as const,
      hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true as const,
    }
    const decision = {
      contextTokens: 131_451,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      previous,
    }

    expect(shouldAttemptContextCompaction({
      ...decision,
      now: 1_000 + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS - 1,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      ...decision,
      now: 1_000 + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS,
    })).toBe(true)

    const retryAt = 1_000 + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS
    expect(isHardLimitRecoveryContextCompaction({ ...decision, now: retryAt })).toBe(true)
    const successfulRetryReceipt = {
      attemptedAt: retryAt,
      contextTokensBefore: decision.contextTokens,
      providerContextBaselineTokens: 125_000,
      outcome: 'succeeded' as const,
      hardLimitTokens: decision.hardLimitTokens,
      hardLimitFollowUpAttempted: true as const,
      hardLimitRecoveryAttempted: true as const,
    }
    const nextDecision = {
      ...decision,
      // The provider remains above the hard limit after the retry, without
      // enough new growth to justify another independent compaction.
      contextTokens: 131_451,
      previous: successfulRetryReceipt,
    }
    expect(isHardLimitFollowUpContextCompaction({ ...nextDecision, now: retryAt + 1 })).toBe(false)
    expect(isHardLimitRecoveryContextCompaction({ ...nextDecision, now: retryAt + 1 })).toBe(false)
    expect(shouldAttemptContextCompaction({ ...nextDecision, now: retryAt + 1 })).toBe(false)
    for (const cooldowns of [1, 2, 8]) {
      expect(shouldAttemptContextCompaction({
        ...nextDecision,
        now: retryAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * cooldowns,
      })).toBe(false)
    }

    expect(shouldAttemptContextCompaction({
      ...nextDecision,
      contextTokens: 137_500,
      now: retryAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * 8,
    })).toBe(true)
    expect(shouldAttemptContextCompaction({
      ...nextDecision,
      hardLimitTokens: 120_000,
      now: retryAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * 8,
    })).toBe(true)
  })

  test.each(['backend-error', 'authentication', 'timeout'] as const)(
    'spends one delayed hard-limit recovery after an initial %s failure',
    (issueCode) => {
      const attemptedAt = 1_000
      const previous = {
        attemptedAt,
        contextTokensBefore: 131_451,
        outcome: 'failed' as const,
        objectiveRootId: 'objective-root',
        hardLimitTokens: 100_000,
        issueCode,
      }
      const decision = {
        contextTokens: 131_451,
        compactAtTokens: 80_000,
        hardLimitTokens: 100_000,
        objectiveRootId: 'objective-root',
        previous,
      }
      expect(shouldAttemptContextCompaction({
        ...decision,
        now: attemptedAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS - 1,
      })).toBe(false)

      const retryAt = attemptedAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS
      expect(shouldAttemptContextCompaction({ ...decision, now: retryAt })).toBe(true)
      expect(isHardLimitRecoveryContextCompaction({ ...decision, now: retryAt })).toBe(true)

      const consumed = {
        ...decision,
        previous: {
          ...previous,
          attemptedAt: retryAt,
          hardLimitRecoveryAttempted: true as const,
        },
      }
      for (const cooldowns of [1, 2, 8]) {
        expect(isHardLimitRecoveryContextCompaction({
          ...consumed,
          now: retryAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * cooldowns,
        })).toBe(false)
        expect(shouldAttemptContextCompaction({
          ...consumed,
          now: retryAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * cooldowns,
        })).toBe(false)
      }

      expect(shouldAttemptContextCompaction({
        ...consumed,
        contextTokens: 145_000,
        now: retryAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * 8,
      })).toBe(true)
      expect(shouldAttemptContextCompaction({
        ...consumed,
        hardLimitTokens: 120_000,
        now: retryAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * 8,
      })).toBe(true)
      expect(shouldAttemptContextCompaction({
        ...consumed,
        objectiveRootId: 'new-objective',
        now: retryAt + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * 8,
      })).toBe(true)
    },
  )

  test('does not use the hard-limit follow-up before a provider measurement', () => {
    const decision = {
      contextTokens: 360_000,
      compactAtTokens: 300_000,
      hardLimitTokens: 350_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      previous: {
        attemptedAt: 1_000,
        contextTokensBefore: 400_000,
        contextTokensAfter: 90_000,
        outcome: 'succeeded' as const,
        objectiveRootId: 'objective-root',
        awaitingProviderContextBaseline: true as const,
        hardLimitTokens: 350_000,
      },
    }
    expect(isHardLimitFollowUpContextCompaction(decision)).toBe(false)
    expect(shouldAttemptContextCompaction(decision)).toBe(false)
  })

  test('classifies failures without persisting provider error text', () => {
    expect(classifyContextCompactionFailure(new Error('compact timed out after 300s'))).toBe('timeout')
    expect(classifyContextCompactionFailure(new Error('Already compacted'))).toBe('not-needed')
    expect(classifyContextCompactionFailure(new Error('credential expired'))).toBe('authentication')
    expect(classifyContextCompactionFailure(new Error('unexpected response'))).toBe('backend-error')
  })
});
