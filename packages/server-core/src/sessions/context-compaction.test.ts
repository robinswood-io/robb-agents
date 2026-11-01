import { describe, expect, test } from "bun:test";
import { COST_CONTROL_COMPACTION_INSTRUCTIONS, CONTEXT_COMPACTION_RETRY_COOLDOWN_MS, assessContextCompactionResult, captureProviderContextBaseline, decideContextProviderAdmission, shouldAttemptContextCompaction } from "./context-compaction";

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
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('## Goal')
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('## Constraints & Preferences')
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('## Progress')
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('## Key Decisions')
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('## Next Steps')
    expect(COST_CONTROL_COMPACTION_INSTRUCTIONS).toContain('## Critical Context')
  })

  test('accepts a measured compaction using prose operational handoff headings', () => {
    const operationalSummary = [
      '## Current Objective',
      'Complete the accounting reconciliation for April.',
      '## Decisions and User Constraints',
      '- Preserve verified entries and do not duplicate bank imports.',
      '## Verified State and Evidence',
      '- 42 invoices matched against bank lines.',
      '## Key Decisions',
      '- Use Inqom folder 1042.',
      '## Unresolved Work, Blockers',
      '1. Reconcile the remaining 3 supplier invoices.',
      '## Exact Paths, Identifiers',
      '- Folder ID: 1042.',
    ].join('\n')

    expect(assessContextCompactionResult({
      summary: operationalSummary,
      firstKeptEntryId: 'entry-42',
      tokensBefore: 110_000,
      estimatedTokensAfter: 24_000,
    })).toMatchObject({
      outcome: 'succeeded',
      issues: [],
    })
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
      ...(measured !== undefined ? { previous: measured } : {}),
    })).toBe(false)
    expect(shouldAttemptContextCompaction({
      contextTokens: 99_000,
      compactAtTokens: 80_000,
      objectiveRootId: 'objective-root',
      now: 2_000,
      ...(measured !== undefined ? { previous: measured } : {}),
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
});
