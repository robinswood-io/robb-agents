import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { appendRunLog, saveTaskSpec, readRunLog, readNodeOutput, writeRunSpecSnapshot } from "@craft-agent/shared/tasks";
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
      ...(nowMs !== undefined ? { nowMs: nowMs } : {}),
      resolveSubagentAutonomyContext: () => autonomyContext,
      ...(executionProofIssuer ? {
        verifyExecutionProof: (proof, binding) => executionProofIssuer.verifyForTask(proof, binding),
      } : {}),
    });
  }

  it('discovers a create-before-log worker before a drained paused run can resume', async () => {
    const spec = specOf({
      id: 'paused-create-crash', title: 'Paused create crash', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    });
    saveTaskSpec(root, spec);
    writeRunSpecSnapshot(root, spec.id, 'r1', spec);
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: spec.id, runId: 'r1',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:01.000Z', kind: 'run-paused',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:02.000Z', kind: 'run-pause-drained',
    });
    const recoveredHost = new MockHost();
    recoveredHost.created.push({
      id: 'orphan-paused-a',
      options: {
        taskSlug: spec.id, taskRunId: 'r1', taskNodeId: 'a',
        name: 'a', sessionStatus: 'in-progress',
      },
    });
    let releaseRetirement!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    const retired: string[] = [];
    recoveredHost.cancelProcessingAndWait = async (sessionId) => {
      retired.push(sessionId);
      await gate;
      await recoveredHost.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted' };
    };
    const recovered = new TaskRunner({
      host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    recovered.recoverNonTerminalRuns();
    await waitUntil(() => retired.length === 1);
    recovered.resume(spec.id, 'r1');
    await tick();
    expect(recoveredHost.created).toHaveLength(1);

    releaseRetirement();
    await waitUntil(() => recoveredHost.created.length === 2);
    expect(recoveredHost.created.map((entry) => entry.id)).toEqual(['orphan-paused-a', 'sess-a']);
  });

  it('stops a run and cancels in-flight children', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'st',
        title: 'St',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('st', { runId: 'r1' });
    await tick();

    await runner.stop('st', 'r1');
    const snap = runner.getRunState('st', 'r1')!;
    expect(snap.status).toBe('stopped');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('cancelled');
    expect(host.cancelled).toContain('sess-a');
  });

  it('publishes stopped only after every worker is idle and late usage is accounted', async () => {
    saveTaskSpec(root, specOf({
      id: 'strong-worker-stop', title: 'Strong worker stop', goal: 'g', max_parallel: 2,
      nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }],
    }));
    const runner = makeRunner();
    runner.run('strong-worker-stop', { runId: 'r1', verifyOnComplete: false });
    await tick();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const retirementCalls: string[] = [];
    host.cancelProcessingAndWait = async (sessionId) => {
      retirementCalls.push(sessionId);
      await gate;
      await host.cancelProcessing(sessionId, true);
      return {
        sessionId,
        workspaceId: 'ws',
        reason: 'interrupted',
        tokenUsage: sessionId === 'sess-a' ? tu(2, 1, 0.1) : tu(3, 1, 0.2),
      };
    };

    const stopping = runner.stop('strong-worker-stop', 'r1');
    await tick();
    expect(runner.getRunState('strong-worker-stop', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'strong-worker-stop', 'r1').some((entry) => entry.kind === 'run-stopped')).toBe(false);

    release();
    await stopping;
    expect(retirementCalls).toEqual(['sess-a', 'sess-b']);
    expect(runner.getRunState('strong-worker-stop', 'r1')).toMatchObject({
      status: 'stopped', tokensUsed: 7, costUsed: 0.30000000000000004,
    });
    expect(host.cancelled).toEqual(['sess-a', 'sess-b']);
  });

  it('keeps worker stop non-terminal and retryable when strong retirement fails', async () => {
    saveTaskSpec(root, specOf({
      id: 'strong-worker-stop-retry', title: 'Strong worker stop retry', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('strong-worker-stop-retry', { runId: 'r1', verifyOnComplete: false });
    await tick();
    let attempts = 0;
    host.cancelProcessingAndWait = async (sessionId) => {
      attempts += 1;
      if (attempts === 1) throw new Error('worker still stopping');
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(1, 1) };
    };

    await expect(runner.stop('strong-worker-stop-retry', 'r1')).rejects.toThrow('could not be retired');
    expect(runner.getRunState('strong-worker-stop-retry', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'strong-worker-stop-retry', 'r1').some(
      (entry) => entry.kind === 'run-stopped',
    )).toBe(false);

    await runner.stop('strong-worker-stop-retry', 'r1');
    expect(attempts).toBe(2);
    expect(runner.getRunState('strong-worker-stop-retry', 'r1')).toMatchObject({
      status: 'stopped', tokensUsed: 2,
    });
  });

  it('automatically retries a rejected terminal drain without an operator Stop', async () => {
    saveTaskSpec(root, specOf({
      id: 'terminal-drain-watchdog', title: 'Terminal drain watchdog', goal: 'g', token_budget: 1,
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('terminal-drain-watchdog', { runId: 'r1', verifyOnComplete: false });
    await tick();
    let attempts = 0;
    host.cancelProcessingAndWait = async (sessionId) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary terminal stop failure');
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };

    host.complete('a', { finalText: 'over budget', tokenUsage: tu(1, 1) });
    const settled = await runner.waitUntilSettled('terminal-drain-watchdog', 'r1');

    expect(attempts).toBe(2);
    expect(settled.status).toBe('failed');
    expect<unknown>(readRunLog(root, 'terminal-drain-watchdog', 'r1').filter(
      (entry) => entry.kind === 'run-draining',
    )).toEqual([(expect.objectContaining({ cause: 'budget', target: 'failed' }) as unknown)]);
  });

  it('does not rewrite a failed budget intent when operator stop retries its drain', async () => {
    saveTaskSpec(root, specOf({
      id: 'budget-intent-retry', title: 'Budget intent retry', goal: 'g', token_budget: 1,
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('budget-intent-retry', { runId: 'r1', verifyOnComplete: false });
    await tick();
    let attempts = 0;
    host.cancelProcessingAndWait = async (sessionId) => {
      attempts += 1;
      if (attempts === 1) throw new Error('first budget drain unavailable');
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };

    host.complete('a', { finalText: 'over', tokenUsage: tu(1, 1) });
    await waitUntil(() => attempts === 1);
    expect(runner.getRunState('budget-intent-retry', 'r1')?.status).toBe('running');

    await runner.stop('budget-intent-retry', 'r1');
    expect(runner.getRunState('budget-intent-retry', 'r1')?.status).toBe('failed');
    expect<unknown>(readRunLog(root, 'budget-intent-retry', 'r1').filter(
      (entry) => entry.kind === 'run-draining',
    )).toEqual([(expect.objectContaining({ cause: 'budget', target: 'failed' }) as unknown)]);
  });

  it('recovers a create-before-log worker during a durable terminal drain', async () => {
    const spec = specOf({
      id: 'durable-worker-drain', title: 'Durable worker drain', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    });
    saveTaskSpec(root, spec);
    writeRunSpecSnapshot(root, spec.id, 'r1', spec);
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: spec.id, runId: 'r1',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:01.000Z', kind: 'node-scheduled', nodeId: 'a',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:02.000Z', kind: 'run-draining', target: 'stopped',
      cause: 'operator', sessionIds: [], reason: 'stopped',
    });
    const recoveredHost = new MockHost();
    // The host persisted the child envelope, but the runner crashed before
    // createSession returned and node-spawned could be appended.
    recoveredHost.created.push({
      id: 'durable-worker-a',
      options: {
        taskSlug: spec.id, taskRunId: 'r1', taskNodeId: 'a',
        name: 'a', sessionStatus: 'in-progress',
      },
    });
    const retired: string[] = [];
    recoveredHost.cancelProcessingAndWait = async (sessionId) => {
      retired.push(sessionId);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };
    const recovered = new TaskRunner({
      host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });

    recovered.recoverNonTerminalRuns();
    const result = await recovered.waitUntilSettled('durable-worker-drain', 'r1');
    expect(result).toMatchObject({ status: 'stopped', tokensUsed: 3 });
    expect(retired).toEqual(['durable-worker-a']);
    expect(recoveredHost.created).toHaveLength(1);
  });

  it('retires a create-before-log worker before normal recovery redispatches it', async () => {
    const spec = specOf({
      id: 'worker-create-crash', title: 'Worker create crash', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    });
    saveTaskSpec(root, spec);
    writeRunSpecSnapshot(root, spec.id, 'r1', spec);
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: spec.id, runId: 'r1',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:01.000Z', kind: 'node-scheduled', nodeId: 'a',
    });
    const recoveredHost = new MockHost();
    recoveredHost.created.push({
      id: 'orphan-worker-a',
      options: {
        taskSlug: spec.id, taskRunId: 'r1', taskNodeId: 'a',
        name: 'a', sessionStatus: 'in-progress',
      },
    });
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    const retired: string[] = [];
    recoveredHost.cancelProcessingAndWait = async (sessionId) => {
      retired.push(sessionId);
      await retirementGate;
      await recoveredHost.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };
    const recovered = new TaskRunner({
      host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });

    recovered.recoverNonTerminalRuns();
    await waitUntil(() => retired.length === 1);
    expect(retired).toEqual(['orphan-worker-a']);
    expect(recoveredHost.created).toHaveLength(1);

    releaseRetirement();
    await waitUntil(() => recoveredHost.created.length === 2);
    expect(recoveredHost.created.map((entry) => entry.id)).toEqual(['orphan-worker-a', 'sess-a']);
    expect(recovered.getRunState(spec.id, 'r1')).toMatchObject({ status: 'running', tokensUsed: 3 });
  });

  it('resumes a run from the persisted run-log after a restart, reusing finished node outputs', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'res',
        title: 'Res',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    // First runner: complete 'a' (output persisted), leave 'b' pending, then "crash" (drop the runner).
    const r1 = makeRunner();
    r1.run('res', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'A', tokenUsage: tu(3, 4) });
    await tick();
    r1.pause('res', 'r1'); // cancel the newly dispatched 'b' before simulating the restart
    expect(readNodeOutput(root, 'res', 'r1', 'a')).toEqual({ text: 'A' });

    // Simulate an app restart: a brand-new runner + host with empty in-memory state.
    const host2 = new MockHost();
    const r2 = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch, now: () => '2026-06-07T00:00:00.000Z' });
    r2.resume('res', 'r1'); // not in memory → rehydrate from the run-log
    await tick();

    // 'a' is reused from disk (NOT re-spawned); only 'b' dispatches, seeded with a's recovered output.
    expect(host2.dispatchedNames()).toEqual(['b']);
    expect(host2.promptFor('b')?.endsWith('b A')).toBe(true);
    // The orchestrator linkage is recovered from the run-log.
    expect(host2.created.find((c) => c.options.name === 'b')?.options.parentSessionId).toBe('orch');

    host2.complete('b', { finalText: 'B' });
    await tick();
    // Resumed run re-verifies (orchestrator recovered from the run-log) before going terminal.
    expect(r2.getRunState('res', 'r1')!.status).toBe('verifying');
    host2.completeReview('pass');
    await tick();
    expect(r2.getRunState('res', 'r1')!.status).toBe('completed');
  });

  it('resumes against the immutable run snapshot after task.yaml is edited', async () => {
    const original = specOf({
      id: 'snapshot-resume',
      title: 'Snapshot resume',
      goal: 'g',
      nodes: [
        { id: 'a', prompt: 'original a' },
        { id: 'b', depends_on: ['a'], prompt: 'original b uses ${nodes.a.output}' },
      ],
    });
    saveTaskSpec(root, original);
    const first = makeRunner();
    first.run('snapshot-resume', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { finalText: 'A' });
    await tick();
    first.pause('snapshot-resume', 'r1');

    saveTaskSpec(
      root,
      specOf({
        id: 'snapshot-resume',
        title: 'Mutated live spec',
        goal: 'different',
        nodes: [{ id: 'replacement', prompt: 'must never run' }],
      }),
    );

    const resumedHost = new MockHost();
    const resumed = new TaskRunner({ host: resumedHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch });
    resumed.resume('snapshot-resume', 'r1');
    await tick();

    expect(resumedHost.dispatchedNames()).toEqual(['b']);
    expect(resumedHost.promptFor('b')?.endsWith('original b uses A')).toBe(true);
  });
});
