import { describe, expect, test } from 'bun:test';
import { runRecoveryCampaign } from './robb-recovery-campaign';

describe('robb recovery campaign', () => {
  test('passes the 1,000 run safe-recovery and p95 latency SLO', () => {
    const report = runRecoveryCampaign({
      runs: 1_000,
      minimumSafeRate: 0.99,
      maxP95DecisionLatencyMs: 500,
    });

    expect(report.passed).toBe(true);
    expect(report.safeDecisions).toBe(1_000);
    expect(report.violations).toBe(0);
    expect(report.safeRate).toBeGreaterThanOrEqual(0.99);
    expect(report.p95DecisionLatencyMs).toBeLessThanOrEqual(500);
  });
});
