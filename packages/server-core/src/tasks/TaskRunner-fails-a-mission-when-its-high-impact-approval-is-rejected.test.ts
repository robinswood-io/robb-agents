import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
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

  it('fails a mission when its high-impact approval is rejected', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'reject-mutation',
        title: 'Reject mutation',
        goal: 'Publish safely',
        mission: {
          deliverables: [{ name: 'publication' }],
          policy: {
            impact_level: 'critical',
            require_high_impact_approval: true,
            replay_external_mutations: false,
          },
        },
        nodes: [{ id: 'publish', prompt: 'Publish now', effect: 'external-mutation', approval: true }],
      }),
    );
    const runner = makeRunner();
    runner.run('reject-mutation', { runId: 'r1', verifyOnComplete: false });
    await tick();
    const approval = runner.listPendingApprovals('reject-mutation', 'r1')[0]!;

    runner.resolveApproval('reject-mutation', 'r1', approval.requestId, 'rejected', 'validator', 'Not authorized');
    await tick();
    expect(runner.getRunState('reject-mutation', 'r1')?.status).toBe('failed');
    expect(host.created).toHaveLength(0);
  });

  it('stamps task/run/node linkage on each dispatched child session', async () => {
    // The manual subtask composer skips Conductor-owned children by checking taskRunId.
    saveTaskSpec(
      root,
      specOf({ id: 'link', title: 'Link', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }),
    )
    const runner = makeRunner()
    runner.run('link', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    const optsA = host.created.find((c) => c.options.name === 'a')?.options
    expect(optsA?.taskSlug).toBe('link')
    expect(optsA?.taskRunId).toBe('r1')
    expect(optsA?.taskNodeId).toBe('a')
  })

  it('creates a child session per node (createSession announces each to the renderer by default)', async () => {
    // Renderer visibility depends on createSession emitting session_created; the runner's job is
    // simply to create one session per node (the host's createSession owns the announcement).
    saveTaskSpec(
      root,
      specOf({ id: 'announce', title: 'Announce', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }] }),
    )
    const runner = makeRunner()
    runner.run('announce', { runId: 'r1' })
    await tick()

    expect(host.created.map((c) => c.id)).toEqual([host.sessionIdFor('a'), host.sessionIdFor('b')])
  })

  it("children inherit the orchestrator's working directory (falling back to spec.cwd)", async () => {
    const specDir = join(root, 'spec-dir')
    const parentDir = join(root, 'parent-dir')
    mkdirSync(specDir)
    mkdirSync(parentDir)
    saveTaskSpec(
      root,
      specOf({ id: 'cwd', title: 'Cwd', goal: 'g', cwd: specDir, nodes: [{ id: 'a', prompt: 'a' }] }),
    )
    host.workingDirById.set('orch', parentDir)
    const runner = makeRunner()
    runner.run('cwd', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()
    // Orchestrator cwd wins over the spec default.
    expect(host.created.find((c) => c.options.name === 'a')?.options.workingDirectory).toBe(parentDir)

    // With no orchestrator cwd, the spec's declared cwd is used.
    host.created.length = 0
    host.workingDirById.clear()
    const runner2 = makeRunner()
    runner2.run('cwd', { runId: 'r2', orchestratorSessionId: 'orch' })
    await tick()
    expect(host.created.find((c) => c.options.name === 'a')?.options.workingDirectory).toBe(specDir)
  })

  it('moves the orchestrator tile to in-progress on start and done on completion', async () => {
    saveTaskSpec(root, specOf({ id: 'col', title: 'Col', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }))
    const runner = makeRunner()
    runner.run('col', { runId: 'r1', orchestratorSessionId: 'orch', verifyOnComplete: false })
    await tick()
    expect(host.columns).toContainEqual({ sessionId: 'orch', column: 'in-progress' })

    host.complete('a', { finalText: 'A' })
    await tick()
    expect(host.columns).toContainEqual({ sessionId: 'orch', column: 'done' })
  })

  it('runs a fan-out and joins at the synthesizer', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'fan',
        title: 'Fan',
        goal: 'g',
        nodes: [
          { id: 'design', prompt: 'design' },
          { id: 'impl-a', depends_on: ['design'], prompt: 'A: ${nodes.design.output}' },
          { id: 'impl-b', depends_on: ['design'], prompt: 'B: ${nodes.design.output}' },
          { id: 'review', depends_on: ['impl-a', 'impl-b'], prompt: 'review ${nodes.impl-a.output} ${nodes.impl-b.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('fan', { runId: 'r1' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['design']);

    host.complete('design', { finalText: 'D' });
    await tick();
    // Both siblings dispatch in parallel; review waits for the barrier.
    expect(host.dispatchedNames().sort()).toEqual(['design', 'impl-a', 'impl-b']);
    expect(host.promptFor('review')).toBeUndefined();

    host.complete('impl-a', { finalText: 'A' });
    await tick();
    expect(host.promptFor('review')).toBeUndefined(); // still waiting on impl-b

    host.complete('impl-b', { finalText: 'B' });
    await tick();
    expect(host.promptFor('review')?.endsWith('review A B')).toBe(true);

    host.complete('review', { finalText: 'R' });
    await tick();
    expect(runner.getRunState('fan', 'r1')!.status).toBe('completed');
  });

  it('marks a node failed, leaves dependents pending, and settles the run as failed', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'fail',
        title: 'F',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('fail', { runId: 'r1' });
    await tick();

    host.complete('a', { reason: 'error' });
    await tick();

    const snap = runner.getRunState('fail', 'r1')!;
    expect(snap.status).toBe('failed');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('failed');
    expect(snap.nodes.find((n) => n.id === 'b')!.state).toBe('pending');
    expect(host.promptFor('b')).toBeUndefined();
    expect(host.statuses.some((s) => s.sessionId === 'sess-a' && s.status === 'needs-review')).toBe(true);

    const log = readRunLog(root, 'fail', 'r1');
    expect(log.some((e) => e.kind === 'node-finished' && (e as { state?: string }).state === 'failed')).toBe(true);
    expect(log.some((e) => e.kind === 'run-failed')).toBe(true);
  });

  it('honors max_parallel', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'par',
        title: 'P',
        goal: 'g',
        max_parallel: 1,
        nodes: [
          { id: 'x', prompt: 'x' },
          { id: 'y', prompt: 'y' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('par', { runId: 'r1' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['x']); // only one slot

    host.complete('x', { finalText: 'X' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['x', 'y']);

    host.complete('y', { finalText: 'Y' });
    await tick();
    expect(runner.getRunState('par', 'r1')!.status).toBe('completed');
  });

  it('pauses scheduling and resumes', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'pz',
        title: 'Pz',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('pz', { runId: 'r1' });
    await tick();

    runner.pause('pz', 'r1');
    expect(host.cancelled).toEqual(['sess-a']);
    host.complete('a', { finalText: 'A' });
    await tick();
    expect(host.promptFor('b')).toBeUndefined(); // paused → no scheduling
    expect(runner.getRunState('pz', 'r1')!.status).toBe('paused');
    expect(runner.getRunState('pz', 'r1')!.nodes.find((node) => node.id === 'a')?.state).toBe('cancelled');

    runner.resume('pz', 'r1');
    await tick();
    expect(host.created.filter((entry) => entry.options.name === 'a')).toHaveLength(2);
    host.complete('a', { finalText: 'A' });
    await tick();
    expect(host.promptFor('b')?.endsWith('b A')).toBe(true);

    host.complete('b', { finalText: 'B' });
    await tick();
    expect(runner.getRunState('pz', 'r1')!.status).toBe('completed');
  });

  it('does not resume a paused worker until its previous attempt is proven idle', async () => {
    saveTaskSpec(root, specOf({
      id: 'pause-retirement-fence', title: 'Pause retirement fence', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('pause-retirement-fence', { runId: 'r1', verifyOnComplete: false });
    await tick();
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    host.cancelProcessingAndWait = async (sessionId) => {
      await retirementGate;
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };

    runner.pause('pause-retirement-fence', 'r1');
    runner.resume('pause-retirement-fence', 'r1');
    await tick();
    expect(runner.getRunState('pause-retirement-fence', 'r1')?.status).toBe('paused');
    expect(host.created.filter((entry) => entry.options.name === 'a')).toHaveLength(1);

    releaseRetirement();
    await waitUntil(() => host.created.filter((entry) => entry.options.name === 'a').length === 2);
    expect(runner.getRunState('pause-retirement-fence', 'r1')).toMatchObject({
      status: 'running', tokensUsed: 3,
    });
  });

  it('reconstructs and completes an interrupted pause drain after restart', async () => {
    saveTaskSpec(root, specOf({
      id: 'pause-drain-restart', title: 'Pause drain restart', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const first = makeRunner();
    first.run('pause-drain-restart', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.cancelProcessingAndWait = async () => {
      throw new Error('process lost during pause drain');
    };
    first.pause('pause-drain-restart', 'r1');
    await tick();

    const recoveredHost = new MockHost();
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
    const [snapshot] = recovered.recoverNonTerminalRuns();
    expect(snapshot.status).toBe('paused');
    await waitUntil(() => retired.length === 1);
    expect(retired).toEqual(['sess-a']);
    expect(recoveredHost.created).toHaveLength(0);

    releaseRetirement();
    await waitUntil(() => recoveredHost.cancelled.includes('sess-a'));
    expect(recovered.getRunState('pause-drain-restart', 'r1')).toMatchObject({
      status: 'paused', tokensUsed: 3,
    });
  });

  it('keeps retrying a failed pause retirement without requiring Resume', async () => {
    saveTaskSpec(root, specOf({
      id: 'pause-retirement-watchdog', title: 'Pause retirement watchdog', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('pause-retirement-watchdog', { runId: 'r1', verifyOnComplete: false });
    await tick();
    let attempts = 0;
    host.cancelProcessingAndWait = async (sessionId) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary stop failure');
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(1, 1) };
    };

    runner.pause('pause-retirement-watchdog', 'r1');
    await waitUntil(() => attempts >= 2, 1_000);

    expect(attempts).toBe(2);
    expect(host.cancelled).toEqual(['sess-a']);
    expect(runner.getRunState('pause-retirement-watchdog', 'r1')).toMatchObject({
      status: 'paused', tokensUsed: 2,
    });
    expect(readRunLog(root, 'pause-retirement-watchdog', 'r1').some(
      (entry) => entry.kind === 'run-pause-drained',
    )).toBe(true);
  });

  it('honors one Resume request after a failed pause drain is retried successfully', async () => {
    saveTaskSpec(root, specOf({
      id: 'pause-resume-watchdog', title: 'Pause resume watchdog', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('pause-resume-watchdog', { runId: 'r1', verifyOnComplete: false });
    await tick();
    let attempts = 0;
    host.cancelProcessingAndWait = async (sessionId) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary pause stop failure');
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(1, 1) };
    };

    runner.pause('pause-resume-watchdog', 'r1');
    runner.resume('pause-resume-watchdog', 'r1');
    await waitUntil(() => host.created.filter((entry) => entry.options.name === 'a').length === 2, 1_000);

    expect(attempts).toBe(2);
    expect(runner.getRunState('pause-resume-watchdog', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'pause-resume-watchdog', 'r1').filter(
      (entry) => entry.kind === 'run-resumed',
    )).toHaveLength(1);
  });
});
