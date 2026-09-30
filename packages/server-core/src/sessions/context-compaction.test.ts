import { describe, expect, test } from 'bun:test'
import {
  COST_CONTROL_COMPACTION_INSTRUCTIONS,
  CONTEXT_COMPACTION_RETRY_COOLDOWN_MS,
  assessContextCompactionResult,
  captureProviderContextBaseline,
  classifyContextCompactionFailure,
  consumeContextProviderBaselineAdmission,
  decideContextProviderAdmission,
  isHardLimitFollowUpContextCompaction,
  isHardLimitRecoveryContextCompaction,
  shouldAttemptContextCompaction,
} from './context-compaction'

describe('context compaction', () => {
  const validSummary = [
    '## Goal',
    'Finish the verified migration.',
    '## Constraints & Preferences',
    '- Do not replay external effects.',
    '## Progress',
    '### Done',
    '- [x] Backup verified.',
    '### In Progress',
    '- [ ] Validate staging.',
    '### Blocked',
    '- (none)',
    '## Key Decisions',
    '- Preserve the rollback bundle.',
    '## Next Steps',
    '1. Run the staging check.',
    '## Critical Context',
    '- Session id: session-42.',
  ].join('\n')

  test('requires a precise operational handoff', () => {
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('verified state and evidence')
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('exact paths, identifiers, values')
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('do not invent details')
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('pending approvals')
  })

  test('accepts a measured, effective compaction', () => {
    expect(assessContextCompactionResult({
      summary: validSummary,
      firstKeptEntryId: 'entry-42',
      tokensBefore: 100_000,
      estimatedTokensAfter: 22_000,
    })).toEqual({
      outcome: 'succeeded',
      issues: [],
      tokensBefore: 100_000,
      tokensAfter: 22_000,
      reclaimedTokens: 78_000,
      reductionRatio: 0.78,
    })
  })

  test('accepts a measured, effective compaction with French headings', () => {
    const frenchSummary = [
      '## Objectif',
      'Finaliser la migration vérifiée.',
      '## Contraintes & Préférences',
      '- Ne pas rejouer les effets externes.',
      '## Progrès',
      '### Fait',
      '- [x] Sauvegarde vérifiée.',
      '### En cours',
      '- [ ] Valider staging.',
      '## Décisions Clés',
      '- Conserver le bundle de rollback.',
      '## Prochaines Étapes',
      '1. Lancer la vérification sur staging.',
      '## Contexte Critique',
      '- ID de session: session-42.',
    ].join('\n')

    expect(assessContextCompactionResult({
      summary: frenchSummary,
      firstKeptEntryId: 'entry-42',
      tokensBefore: 100_000,
      estimatedTokensAfter: 22_000,
    })).toEqual({
      outcome: 'succeeded',
      issues: [],
      tokensBefore: 100_000,
      tokensAfter: 22_000,
      reclaimedTokens: 78_000,
      reductionRatio: 0.78,
    })
  })

  test('accepts the SDK split-turn summary schema', () => {
    const splitTurnSummary = [
      'No prior history.',
      '---',
      '**Turn Context (split turn):**',
      '## Original Request',
      'Finish the verified migration.',
      '## Early Progress',
      '- Backup verified and migration applied.',
      '## Context for Suffix',
      '- Validate staging without replaying external effects.',
    ].join('\n')

    expect(assessContextCompactionResult({
      summary: splitTurnSummary,
      firstKeptEntryId: 'entry-42',
      tokensBefore: 150_707,
      estimatedTokensAfter: 49_315,
    })).toEqual({
      outcome: 'succeeded',
      issues: [],
      tokensBefore: 150_707,
      tokensAfter: 49_315,
      reclaimedTokens: 101_392,
      reductionRatio: 101_392 / 150_707,
    })
  })

  test('does not claim success for a missing or malformed result', () => {
    expect(assessContextCompactionResult(null)).toEqual({
      outcome: 'unverified',
      issues: ['missing-result'],
    })
    expect(assessContextCompactionResult({
      summary: '',
      firstKeptEntryId: '',
      tokensBefore: 0,
      estimatedTokensAfter: Number.NaN,
    }).outcome).toBe('unverified')
  })

  test('reports a compaction that did not reclaim context', () => {
    const assessment = assessContextCompactionResult({
      summary: validSummary,
      firstKeptEntryId: 'entry-9',
      tokensBefore: 80_000,
      estimatedTokensAfter: 81_000,
    })
    expect(assessment.outcome).toBe('ineffective')
    expect(assessment.reclaimedTokens).toBe(0)
  })

  test('rejects a truncated or template-shaped handoff', () => {
    const assessment = assessContextCompactionResult({
      summary: '## Goal\n[What is the user trying to accomplish?]\n## Progress\n- Pending.',
      firstKeptEntryId: 'entry-9',
      tokensBefore: 80_000,
      estimatedTokensAfter: 20_000,
    })
    expect(assessment.outcome).toBe('unverified')
    expect(assessment.issues).toContain('missing-required-sections')
    expect(assessment.issues).toContain('unresolved-template-placeholders')
  })

  test('rejects partial split-turn headings without the SDK marker', () => {
    const assessment = assessContextCompactionResult({
      summary: '## Original Request\nFinish migration.\n## Early Progress\n- Backup verified.\n## Context for Suffix\n- Validate staging.',
      firstKeptEntryId: 'entry-9',
      tokensBefore: 80_000,
      estimatedTokensAfter: 20_000,
    })
    expect(assessment.outcome).toBe('unverified')
    expect(assessment.issues).toContain('missing-required-sections')
  })

  test('backs off failures until cooldown or material context growth', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 80_000,
      outcome: 'failed' as const,
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 81_000,
      compactAtTokens: 80_000,
      now: 2_000,
      previous,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 100_000,
      compactAtTokens: 80_000,
      now: 2_000,
      previous,
    })).toBe(true)
    expect(shouldAttemptContextCompaction({
      contextTokens: 81_000,
      compactAtTokens: 80_000,
      now: 1_000 + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS,
      previous,
    })).toBe(true)
  })

  test('locks a successful compaction until a provider baseline is captured', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 80_000,
      contextTokensAfter: 20_000,
      outcome: 'succeeded' as const,
      objectiveRootId: 'objective-root',
      awaitingProviderContextBaseline: true as const,
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 120_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 1_000 + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * 4,
      previous,
    })).toBe(false)
    expect(captureProviderContextBaseline(previous, 0)).toBe(previous)

    const measured = captureProviderContextBaseline(previous, 90_000)
    expect(measured).toMatchObject({
      attemptedAt: 1_000,
      contextTokensBefore: 80_000,
      contextTokensAfter: 20_000,
      outcome: 'succeeded',
      objectiveRootId: 'objective-root',
      providerContextBaselineTokens: 90_000,
    })
    expect(measured).not.toHaveProperty('awaitingProviderContextBaseline')
    expect(shouldAttemptContextCompaction({
      contextTokens: 98_999,
      compactAtTokens: 80_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      previous: measured,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 99_000,
      compactAtTokens: 80_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      previous: measured,
    })).toBe(true)
  })

  test('measures renewed growth only from the first provider context baseline', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 205_056,
      contextTokensAfter: 22_381,
      providerContextBaselineTokens: 160_000,
      outcome: 'succeeded' as const,
      hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true as const,
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 175_999,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      now: 2_000,
      previous,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 176_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      now: 2_000,
      previous,
    })).toBe(true)
  })

  test('keeps the provider wait lock across continuation ids and objective replacement', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 120_000,
      outcome: 'succeeded' as const,
      objectiveRootId: 'objective-root',
      awaitingProviderContextBaseline: true as const,
      hardLimitTokens: 100_000,
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 130_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 20_000,
      previous,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 130_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'genuinely-new-objective',
      now: 20_000,
      previous,
    })).toBe(false)
  })

  test('scopes failed-attempt cooldowns to the objective root', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 90_000,
      outcome: 'failed' as const,
      objectiveRootId: 'old-objective',
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 91_000,
      compactAtTokens: 80_000,
      objectiveRootId: 'old-objective',
      now: 2_000,
      previous,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 91_000,
      compactAtTokens: 80_000,
      objectiveRootId: 'new-objective',
      now: 2_000,
      previous,
    })).toBe(true)
  })

  test('does not retry an SDK not-needed result until context grows materially', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 80_000,
      outcome: 'skipped-not-needed' as const,
      issueCode: 'not-needed' as const,
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 81_000,
      compactAtTokens: 80_000,
      now: 1_000 + CONTEXT_COMPACTION_RETRY_COOLDOWN_MS * 4,
      previous,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 100_000,
      compactAtTokens: 80_000,
      now: 2_000,
      previous,
    })).toBe(true)
  })

  test('retries a not-needed result before the hard limit after meaningful growth', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 80_500,
      outcome: 'skipped-not-needed' as const,
      issueCode: 'not-needed' as const,
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 88_549,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      now: 2_000,
      previous,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 88_550,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      now: 2_000,
      previous,
    })).toBe(true)
  })

  test('never postpones a retry beyond the hard context limit', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 96_000,
      outcome: 'skipped-not-needed' as const,
      issueCode: 'not-needed' as const,
    }
    expect(shouldAttemptContextCompaction({
      contextTokens: 99_999,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      now: 2_000,
      previous,
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 100_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      now: 2_000,
      previous,
    })).toBe(true)
  })

  test('never treats a hard-limit compaction cooldown as provider admission', () => {
    const previous = {
      attemptedAt: 1_000,
      contextTokensBefore: 100_000,
      outcome: 'failed' as const,
      issueCode: 'timeout' as const,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
    }
    const decision = {
      contextTokens: 101_000,
      compactAtTokens: 80_000,
      hardLimitTokens: 100_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      previous,
    }
    expect(shouldAttemptContextCompaction(decision)).toBe(false)
    expect(decideContextProviderAdmission({
      ...decision,
      canCompactContext: true,
    })).toEqual({
      action: 'start-clean-continuation',
      reason: 'hard-limit-compaction-not-ready',
    })
  })

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
})
