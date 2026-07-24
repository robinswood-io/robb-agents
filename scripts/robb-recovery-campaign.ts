#!/usr/bin/env bun

import {
  decideMutationRecovery,
  evaluateKillSwitch,
  type MutationCheckpoint,
  type MutationCheckpointStatus,
  type RecoveryAction,
} from '../packages/shared/src/tasks/durable-execution.ts';

interface CampaignOptions {
  runs: number;
  minimumSafeRate: number;
  maxP95DecisionLatencyMs: number;
}

interface RecoveryViolation {
  index: number;
  status: MutationCheckpointStatus;
  action: RecoveryAction;
  killSwitchActive: boolean;
}

interface CampaignReport {
  campaign: 'robb-durable-recovery';
  runs: number;
  safeDecisions: number;
  violations: number;
  safeRate: number;
  minimumSafeRate: number;
  p95DecisionLatencyMs: number;
  maxP95DecisionLatencyMs: number;
  passed: boolean;
  actionCounts: Record<RecoveryAction, number>;
  violationSamples: RecoveryViolation[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}"`);
  }
  return parsed;
}

function rate(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Expected a rate between 0 and 1, received "${value}"`);
  }
  return parsed;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, received "${value}"`);
  }
  return parsed;
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function runRecoveryCampaign(options: CampaignOptions): CampaignReport {
  const statuses: readonly MutationCheckpointStatus[] = ['confirmed', 'executing', 'prepared', 'failed'];
  const actionCounts: Record<RecoveryAction, number> = {
    retry: 0,
    'reuse-confirmed': 0,
    'require-approval': 0,
    blocked: 0,
  };
  const violationSamples: RecoveryViolation[] = [];
  const latenciesMs: number[] = [];
  let violations = 0;

  for (let index = 0; index < options.runs; index += 1) {
    const startedAt = performance.now();
    const status = statuses[index % statuses.length]!;
    const killSwitchActive = index % 19 === 0;
    const checkpoint: MutationCheckpoint = {
      idempotencyKey: `campaign:mission:node-${index}`,
      workspaceId: 'campaign-workspace',
      missionId: 'campaign-mission',
      nodeId: `node-${index}`,
      status,
      attempts: 1 + (index % 3),
      updatedAt: '2026-07-23T00:00:00.000Z',
      ...(status === 'confirmed' ? { proofHash: `proof-${index}` } : {}),
    };
    const killSwitch = evaluateKillSwitch(
      {
        global: killSwitchActive,
        workspaceIds: [],
        missionIds: [],
      },
      checkpoint.workspaceId,
      checkpoint.missionId,
    );
    const decision = decideMutationRecovery(checkpoint, killSwitch);
    latenciesMs.push(performance.now() - startedAt);
    actionCounts[decision.action] += 1;

    const unsafeReplay =
      decision.action === 'retry' && (status === 'confirmed' || status === 'executing');
    const ignoredKillSwitch = killSwitchActive && decision.action !== 'blocked';
    if (unsafeReplay || ignoredKillSwitch) {
      violations += 1;
      if (violationSamples.length < 10) {
        violationSamples.push({
          index,
          status,
          action: decision.action,
          killSwitchActive,
        });
      }
    }
  }

  const safeDecisions = options.runs - violations;
  const safeRate = safeDecisions / options.runs;
  const p95DecisionLatencyMs = percentile95(latenciesMs);
  return {
    campaign: 'robb-durable-recovery',
    runs: options.runs,
    safeDecisions,
    violations,
    safeRate,
    minimumSafeRate: options.minimumSafeRate,
    p95DecisionLatencyMs,
    maxP95DecisionLatencyMs: options.maxP95DecisionLatencyMs,
    passed: safeRate >= options.minimumSafeRate && p95DecisionLatencyMs <= options.maxP95DecisionLatencyMs,
    actionCounts,
    violationSamples,
  };
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

function main(args: readonly string[]): void {
  const options: CampaignOptions = {
    runs: positiveInteger(optionValue(args, '--runs'), 1_000),
    minimumSafeRate: rate(optionValue(args, '--min-safe-rate'), 0.99),
    maxP95DecisionLatencyMs: positiveNumber(optionValue(args, '--max-p95-ms'), 500),
  };
  const report = runRecoveryCampaign(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
