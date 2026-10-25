import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { saveTaskSpec, readRunLog } from "@craft-agent/shared/tasks";
import { TaskRunner } from "./TaskRunner";
import type { SubagentAutonomyContext } from "../subagents/autonomy-inheritance.ts";
import { MockHost, inactiveKillSwitch, specOf, tick, tu, waitUntil } from "./testing/TaskRunner-fixture.ts";

describe('TaskRunner (Conductor)', () => {
  let root: string;

  let host: MockHost;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
    host = new MockHost();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeRunner(
    executionProofIssuer?: ExecutionProofIssuer,
    autonomyContext: SubagentAutonomyContext = {
      workspacePermissionMode: 'allow-all',
      externalActionPolicy: 'confirm',
    },
    nowMs?: () => number,
  ) {
    return new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      now: () => '2026-06-07T00:00:00.000Z',
      nowMs,
      resolveSubagentAutonomyContext: () => autonomyContext,
      ...(executionProofIssuer ? {
        verifyExecutionProof: (proof, binding) => executionProofIssuer.verifyForTask(proof, binding),
      } : {}),
    });
  }

  it('re-arms node timeouts longer than the platform timer ceiling instead of overflowing', async () => {
    saveTaskSpec(root, specOf({
      id: 'long-worker-timeout', title: 'Long worker timeout', goal: 'g',
      execution: { timeout_ms: 2_147_483_648 },
      nodes: [{ id: 'a', prompt: 'long work' }],
    }));
    const runner = makeRunner();
    runner.run('long-worker-timeout', { runId: 'r1', verifyOnComplete: false });
    await Bun.sleep(20);

    expect(host.cancelled).toEqual([]);
    expect(runner.getRunState('long-worker-timeout', 'r1')?.status).toBe('running');
    await runner.stop('long-worker-timeout', 'r1');
  });

  it('uses the host execution guard as the authoritative admission boundary', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'admission',
        title: 'Admission',
        goal: 'g',
        execution: { max_cpu_percent: 50, max_memory_mb: 256 },
        nodes: [{ id: 'a', prompt: 'a' }],
      }),
    );
    const observed: number[] = [];
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      executionGuard: (context) => {
        observed.push(context.policy.maxCpuPercent, context.policy.maxMemoryMb);
        return { allowed: false, reason: 'sandbox unavailable' };
      },
    });
    runner.run('admission', { runId: 'r1' });
    await tick();

    expect(observed).toEqual([50, 256]);
    expect(host.created).toHaveLength(0);
    expect(runner.getRunState('admission', 'r1')?.status).toBe('failed');
  });

  it('applies retry backoff before dispatching the next attempt', async () => {
    let clockMs = Date.now();
    saveTaskSpec(
      root,
      specOf({
        id: 'backoff',
        title: 'Backoff',
        goal: 'g',
        nodes: [{
          id: 'a',
          prompt: 'a',
          retry: { limit: 1, backoff: { base: 30, factor: 2, max: 100 } },
        }],
      }),
    );
    const runner = new TaskRunner({
      host, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
      nowMs: () => clockMs,
    });
    runner.run('backoff', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();

    expect(host.created.filter((entry) => entry.options.name === 'a')).toHaveLength(1);
    const retry = readRunLog(root, 'backoff', 'r1').find((entry) => entry.kind === 'node-retry');
    expect(retry).toMatchObject({ kind: 'node-retry', delayMs: 30 });

    clockMs += 31;
    await waitUntil(() => host.created.filter((entry) => entry.options.name === 'a').length === 2, 2000);
    expect(host.created.filter((entry) => entry.options.name === 'a')).toHaveLength(2);
  });

  it('restores the durable retry deadline after a process restart', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'backoff-restart',
        title: 'Backoff restart',
        goal: 'g',
        nodes: [{
          id: 'a',
          prompt: 'a',
          retry: { limit: 1, backoff: { base: 300, factor: 2, max: 600 } },
        }],
      }),
    );
    const resolvePinnedRoute = (context: Parameters<NonNullable<ConstructorParameters<typeof TaskRunner>[0]['resolveNodeRoute']>>[0]) => {
      const pinned = context.defaults?.connectionRoutePinned === true
        && context.defaults?.modelRoutePinned === true;
      return {
        profile: {
          specialty: 'general' as const,
          difficulty: 'simple' as const,
          modelTier: 'fast' as const,
          thinkingLevel: 'low' as const,
        },
        llmConnection: pinned ? 'primary' : 'secondary',
        model: pinned ? 'primary-model' : 'other-model',
        thinkingLevel: pinned ? 'low' as const : 'high' as const,
        ...(pinned ? {
          connectionRoutePinned: true,
          modelRoutePinned: true,
          thinkingLevelPinned: true,
        } : {}),
        strategy: pinned ? 'pinned' as const : 'primary' as const,
      };
    };
    const first = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      getModelDefaults: () => ({
        llmConnection: 'primary', model: 'primary-model', thinkingLevel: 'low',
        connectionRoutePinned: true, modelRoutePinned: true, thinkingLevelPinned: true,
      }),
      resolveNodeRoute: resolvePinnedRoute,
    });
    first.run('backoff-restart', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    first.pause('backoff-restart', 'r1');

    const recoveredHost = new MockHost();
    const recovered = new TaskRunner({
      host: recoveredHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      getModelDefaults: () => ({ llmConnection: 'secondary', model: 'other-model', thinkingLevel: 'high' }),
      resolveNodeRoute: resolvePinnedRoute,
    });
    recovered.resume('backoff-restart', 'r1');
    await tick();
    expect(recoveredHost.created).toHaveLength(0);

    await new Promise<void>((resolve) => setTimeout(resolve, 340));
    expect(recoveredHost.dispatchedNames()).toEqual(['a']);
    expect(recoveredHost.created[0]?.options).toMatchObject({
      llmConnection: 'primary', model: 'primary-model', thinkingLevel: 'low', modelRoutePinned: true,
      thinkingLevelPinned: true,
    });
    expect(readRunLog(root, 'backoff-restart', 'r1').filter((entry) => entry.kind === 'node-routed').at(-1))
      .toMatchObject({
        connectionSlug: 'primary', model: 'primary-model', thinkingLevel: 'low', strategy: 'pinned',
        connectionRoutePinned: true, modelRoutePinned: true, thinkingLevelPinned: true,
      });
  });

  it('fails without dispatch when the mission deadline is already expired', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'expired',
        title: 'Expired',
        goal: 'g',
        mission: {
          deliverables: [{ name: 'result' }],
          deadline: '2026-06-01T00:00:00.000Z',
          policy: { impact_level: 'medium', require_high_impact_approval: true, replay_external_mutations: false },
        },
        nodes: [{ id: 'a', prompt: 'a' }],
      }),
    );
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      nowMs: () => Date.parse('2026-06-02T00:00:00.000Z'),
    });
    runner.run('expired', { runId: 'r1', verifyOnComplete: false });
    await tick();

    expect(host.created).toHaveLength(0);
    expect(runner.getRunState('expired', 'r1')?.status).toBe('failed');
    expect(readRunLog(root, 'expired', 'r1').some((entry) => entry.kind === 'deadline-breach')).toBe(true);
  });

  it('cancels in-flight work when a future mission deadline is crossed', async () => {
    // Freeze only the injected mission clock: durable fsync may exceed 200 ms.
    let clockMs = Date.now();
    const deadline = new Date(clockMs + 200).toISOString();
    saveTaskSpec(
      root,
      specOf({
        id: 'deadline-crossing',
        title: 'Deadline crossing',
        goal: 'g',
        mission: {
          deliverables: [{ name: 'result' }],
          deadline,
          policy: { impact_level: 'medium', require_high_impact_approval: true, replay_external_mutations: false },
        },
        nodes: [{ id: 'slow', prompt: 'wait beyond deadline' }],
      }),
    );
    const runner = makeRunner(undefined, undefined, () => clockMs);
    runner.run('deadline-crossing', { runId: 'r1', verifyOnComplete: false });
    await tick();
    expect(host.dispatchedNames()).toEqual(['slow']);

    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    host.cancelProcessingAndWait = async (sessionId) => {
      await retirementGate;
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };

    clockMs += 201;
    await waitUntil(() => readRunLog(root, 'deadline-crossing', 'r1').some(
      (entry) => entry.kind === 'run-draining',
    ), 2000);
    expect(runner.getRunState('deadline-crossing', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'deadline-crossing', 'r1').some(
      (entry) => entry.kind === 'run-failed',
    )).toBe(false);

    releaseRetirement();
    await runner.waitUntilSettled('deadline-crossing', 'r1');
    expect(host.cancelled).toContain('sess-slow');
    expect(runner.getRunState('deadline-crossing', 'r1')).toMatchObject({ status: 'failed', tokensUsed: 3 });
    expect(readRunLog(root, 'deadline-crossing', 'r1').some(
      (entry) => entry.kind === 'deadline-breach' && entry.deadline === deadline,
    )).toBe(true);
  });

  it('fails immediately when measured usage overshoots the hard token budget', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'token-budget',
        title: 'Token budget',
        goal: 'g',
        token_budget: 2,
        nodes: [{ id: 'a', prompt: 'a' }],
      }),
    );
    const runner = makeRunner();
    runner.run('token-budget', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { finalText: 'done', tokenUsage: tu(2, 1) });
    await tick();

    expect(runner.getRunState('token-budget', 'r1')).toMatchObject({ status: 'failed', tokensUsed: 3 });
    expect(readRunLog(root, 'token-budget', 'r1').some(
      (entry) => entry.kind === 'budget-breach' && entry.metric === 'tokens',
    )).toBe(true);
  });

  it('waits for parallel workers and their late usage before publishing a budget failure', async () => {
    saveTaskSpec(root, specOf({
      id: 'parallel-budget-drain', title: 'Parallel budget drain', goal: 'g',
      token_budget: 2, max_parallel: 2,
      nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }],
    }));
    const runner = makeRunner();
    runner.run('parallel-budget-drain', { runId: 'r1', verifyOnComplete: false });
    await tick();
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    host.cancelProcessingAndWait = async (sessionId) => {
      await retirementGate;
      await host.cancelProcessing(sessionId, true);
      return {
        sessionId,
        workspaceId: 'ws',
        reason: 'interrupted',
        tokenUsage: sessionId === 'sess-a' ? tu(2, 1) : tu(3, 2),
      };
    };

    host.complete('a', { finalText: 'over budget', tokenUsage: tu(2, 1) });
    await tick();
    expect(runner.getRunState('parallel-budget-drain', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'parallel-budget-drain', 'r1').some(
      (entry) => entry.kind === 'run-failed',
    )).toBe(false);

    releaseRetirement();
    const result = await runner.waitUntilSettled('parallel-budget-drain', 'r1');
    expect(result).toMatchObject({ status: 'failed', tokensUsed: 8 });
    expect(host.cancelled).toEqual(['sess-a', 'sess-b']);
  });

  it('fails the run when the measured USD cost reaches the hard mission budget', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'cost-budget',
        title: 'Cost budget',
        goal: 'g',
        mission: {
          deliverables: [{ name: 'result' }],
          budget: { max_cost: 0.01, currency: 'USD' },
          policy: { impact_level: 'medium', require_high_impact_approval: true, replay_external_mutations: false },
        },
        nodes: [{ id: 'a', prompt: 'a' }],
      }),
    );
    const runner = makeRunner();
    runner.run('cost-budget', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { finalText: 'done', tokenUsage: tu(1, 1, 0.02) });
    await tick();

    expect(runner.getRunState('cost-budget', 'r1')).toMatchObject({ status: 'failed', costUsed: 0.02 });
    expect(readRunLog(root, 'cost-budget', 'r1').some(
      (entry) => entry.kind === 'budget-breach' && entry.metric === 'cost',
    )).toBe(true);
  });

  it('fails closed without poisoning aggregates when a child reports non-finite usage', async () => {
    saveTaskSpec(root, specOf({
      id: 'invalid-usage', title: 'Invalid usage', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('invalid-usage', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', {
      finalText: 'untrusted receipt',
      tokenUsage: tu(Number.POSITIVE_INFINITY, 0, Number.NaN),
    });

    const result = await runner.waitUntilSettled('invalid-usage', 'r1');
    expect(result).toMatchObject({ status: 'failed', tokensUsed: 0, costUsed: 0 });
    expect(Number.isFinite(result.tokensUsed)).toBe(true);
    expect(Number.isFinite(result.costUsed)).toBe(true);
    expect(readRunLog(root, 'invalid-usage', 'r1')).toContainEqual(expect.objectContaining({
      kind: 'run-draining', cause: 'recovery',
      reason: expect.stringContaining('non-finite'),
    }));
  });

  it('fails closed when individually finite usage counters overflow their aggregate', async () => {
    saveTaskSpec(root, specOf({
      id: 'overflow-usage', title: 'Overflow usage', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('overflow-usage', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', {
      finalText: 'untrusted receipt',
      tokenUsage: tu(Number.MAX_VALUE, Number.MAX_VALUE, 0),
    });

    const result = await runner.waitUntilSettled('overflow-usage', 'r1');
    expect(result).toMatchObject({ status: 'failed', tokensUsed: 0, costUsed: 0 });
    expect(Number.isFinite(result.tokensUsed)).toBe(true);
    expect(readRunLog(root, 'overflow-usage', 'r1')).toContainEqual(expect.objectContaining({
      kind: 'run-draining', cause: 'recovery',
      reason: expect.stringContaining('non-finite'),
    }));
  });
});
