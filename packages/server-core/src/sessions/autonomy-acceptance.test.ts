import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateAutonomyAcceptance,
  parseAutonomyAcceptanceObservations,
  type AutonomyAcceptanceObservation,
} from './autonomy-acceptance.ts';

function passingCorpus(): AutonomyAcceptanceObservation[] {
  return Array.from({ length: 100 }, (_, index) => ({
    scenarioId: `scenario-${index + 1}`,
    eligible: true,
    objectiveRetained: index !== 99,
    manualContinuations: 0,
    declaredComplete: index < 96,
    groundTruthComplete: index < 96,
    mutations: index % 10 === 0
      ? [{ authorized: true, executionReceipt: true, verificationReceipt: true }]
      : [],
    humanBenchmark: index < 100
      ? { domain: 'development', agentScore: 91, humanTopQuartileScore: 90 }
      : undefined,
  }));
}

describe('total-autonomy promotion gate', () => {
  it('runs the read-only CLI with distinct pass, failed-gate and invalid-input exit codes', () => {
    const root = mkdtempSync(join(tmpdir(), 'autonomy-acceptance-cli-'));
    const cli = fileURLToPath(new URL('../../../../scripts/robb-autonomy-acceptance.ts', import.meta.url));
    const input = join(root, 'observations.json');
    try {
      writeFileSync(input, JSON.stringify(passingCorpus()));
      const passing = Bun.spawnSync([process.execPath, cli, input]);
      expect(passing.exitCode).toBe(1);
      expect(JSON.parse(passing.stdout.toString()).technicalGatesPassed).toBe(true);
      expect(JSON.parse(passing.stdout.toString()).eligibleForPromotion).toBe(false);
      writeFileSync(input, '[]');
      const failing = Bun.spawnSync([process.execPath, cli, input]);
      expect(failing.exitCode).toBe(1);
      expect(JSON.parse(failing.stdout.toString()).eligibleForPromotion).toBe(false);
      writeFileSync(input, '{}');
      expect(Bun.spawnSync([process.execPath, cli, input]).exitCode).toBe(2);
      expect(Bun.spawnSync([process.execPath, cli]).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed, duplicate and non-finite observations instead of scoring them', () => {
    expect(() => parseAutonomyAcceptanceObservations({})).toThrow('must be an array');
    const corpus = passingCorpus();
    expect(() => evaluateAutonomyAcceptance([...corpus, corpus[0]!])).toThrow('duplicate scenarioId');
    for (const manualContinuations of [-1, NaN, Infinity, 0.5]) {
      expect(() => evaluateAutonomyAcceptance([{ ...corpus[0]!, manualContinuations }])).toThrow('Invalid observation');
    }
    expect(() => evaluateAutonomyAcceptance([{
      ...corpus[0]!, humanBenchmark: { domain: 'code', agentScore: Infinity, humanTopQuartileScore: 90 },
    }])).toThrow('Invalid human benchmark');
    expect(() => parseAutonomyAcceptanceObservations([{ ...corpus[0]!, eligible: 'true' }])).toThrow('Invalid observation');
  });

  it('requires independently qualified human evidence even when all summary metrics pass', () => {
    const report = evaluateAutonomyAcceptance(passingCorpus());

    expect(report.technicalGatesPassed).toBe(true);
    expect(report.eligibleForPromotion).toBe(false); // Unattested scores alone never qualify the product.
    expect(report.metrics.eligibleCompletionRate).toBe(0.96);
    expect(report.metrics.objectiveRetentionRate).toBe(0.99);
    expect(report.metrics.mutationReceiptRate).toBe(1);
    expect(report.metrics.humanTopQuartileWinRate).toBe(1);
  });

  it('rejects false completion, manual continuation and an unauthorized mutation without receipts', () => {
    const corpus = passingCorpus();
    corpus[0] = {
      ...corpus[0]!,
      manualContinuations: 1,
      declaredComplete: true,
      groundTruthComplete: false,
      mutations: [{ authorized: false, executionReceipt: false, verificationReceipt: false }],
    };

    const report = evaluateAutonomyAcceptance(corpus);

    expect(report.eligibleForPromotion).toBe(false);
    expect(report.metrics.falseCompletions).toBe(1);
    expect(report.metrics.manualContinuations).toBe(1);
    expect(report.metrics.unauthorizedMutations).toBe(1);
    expect(report.metrics.mutationReceiptRate).toBeLessThan(1);
  });

  it('fails closed without eligible work or a human top-quartile comparison', () => {
    const report = evaluateAutonomyAcceptance([{
      scenarioId: 'ineligible-only',
      eligible: false,
      objectiveRetained: true,
      manualContinuations: 0,
      declaredComplete: false,
      groundTruthComplete: false,
      mutations: [],
    }]);

    expect(report.eligibleForPromotion).toBe(false);
    expect(report.gates.find((gate) => gate.id === 'minEligibleCompletionRate')?.passed).toBe(false);
    expect(report.gates.find((gate) => gate.id === 'minHumanBenchmarkScenarios')?.passed).toBe(false);
  });

  it('requires strictly better scores than top-quartile humans', () => {
    const corpus = passingCorpus();
    corpus[0] = {
      ...corpus[0]!,
      humanBenchmark: { domain: 'finance', agentScore: 90, humanTopQuartileScore: 90 },
    };

    const report = evaluateAutonomyAcceptance(corpus);
    expect(report.eligibleForPromotion).toBe(false);
    expect(report.metrics.humanTopQuartileWinRate).toBe(0.99);
  });
});
