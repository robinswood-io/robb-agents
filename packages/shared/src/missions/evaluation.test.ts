import { describe, expect, it } from 'bun:test';
import {
  MissionAttemptTelemetrySchema,
  MissionEvaluationCorpusSchema,
} from './index.ts';

describe('Mission evaluation contracts', () => {
  it('accepts host telemetry and rejects negative cost or duration', () => {
    const telemetry = {
      durationMs: 250,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        contextTokens: 100,
        costUsd: 0.002,
      },
    };
    expect(MissionAttemptTelemetrySchema.parse(telemetry)).toEqual(telemetry);
    expect(MissionAttemptTelemetrySchema.safeParse({ ...telemetry, durationMs: -1 }).success).toBe(false);
    expect(MissionAttemptTelemetrySchema.safeParse({
      ...telemetry,
      tokenUsage: { ...telemetry.tokenUsage, costUsd: -0.01 },
    }).success).toBe(false);
    expect(MissionAttemptTelemetrySchema.safeParse({
      ...telemetry,
      tokenUsage: { ...telemetry.tokenUsage, totalTokens: 999 },
    }).success).toBe(false);
  });

  it('rejects duplicate scenario identities in a promotion corpus', () => {
    const scenario = {
      id: 'same-scenario',
      title: 'Scenario',
      category: 'quality',
      expectedStatus: 'completed',
      expectedCorrectionCycles: 0,
      faults: [],
    };
    const result = MissionEvaluationCorpusSchema.safeParse({
      schemaVersion: 1,
      promotionPolicy: {
        minScenarioPassRate: 1,
        minExpectedCompletionRate: 1,
        minCorrectionConvergenceRate: 1,
        minRecoveryFidelityRate: 1,
        minTelemetryCoverageRate: 1,
        maxGuardrailFailures: 0,
        maxFalseCompletions: 0,
        maxDuplicateDispatches: 0,
      },
      scenarios: [scenario, scenario],
    });
    expect(result.success).toBe(false);
  });
});
