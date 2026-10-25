import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { appendRunLog, saveTaskSpec, readRunLog, readNodeOutput, writeNodeOutput, writeRunSpecSnapshot } from "@craft-agent/shared/tasks";
import { TaskRunner } from "./TaskRunner";
import type { SubagentAutonomyContext } from "../subagents/autonomy-inheritance.ts";
import { MockHost, PrefixedSessionHost, inactiveKillSwitch, specOf, tick, tu, waitUntil } from "./testing/TaskRunner-fixture.ts";

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

  it('restores reviewer usage high-water marks and does not charge a recovered cumulative receipt twice', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-usage-high-water', title: 'Review usage high water', goal: 'g', token_budget: 15,
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const before = new PrefixedSessionHost('before');
    const first = new TaskRunner({
      host: before, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    first.run('review-usage-high-water', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    before.completeSession(before.created.find(entry => entry.options.taskNodeId === 'a')!.id, {
      finalText: 'candidate', tokenUsage: tu(1, 1),
    });
    await tick();
    const staleReviewerId = before.reviewerSessionId();
    // Simulate the exact crash window after reviewer usage was durably added to
    // the aggregate but before its verdict/output transition was appended.
    appendRunLog(root, 'review-usage-high-water', 'r1', {
      t: new Date().toISOString(),
      kind: 'usage-updated',
      tokensUsed: 10,
      costUsed: 0.8,
      currency: 'USD',
      sourceSessionId: staleReviewerId,
      cumulativeTokens: 8,
      cumulativeCostUsd: 0.8,
    });

    const recovered = new PrefixedSessionHost('after');
    recovered.cancelProcessingAndWait = async sessionId => ({
      sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(6, 2, 0.8),
    });
    const resumed = new TaskRunner({
      host: recovered, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    resumed.resume('review-usage-high-water', 'r1');
    await waitUntil(() => recovered.created.some(entry => entry.options.taskNodeId === '__verdict__'));

    expect(resumed.getRunState('review-usage-high-water', 'r1')).toMatchObject({
      status: 'verifying',
      tokensUsed: 10,
      costUsed: 0.8,
    });
    expect(readRunLog(root, 'review-usage-high-water', 'r1').some(entry => (
      entry.kind === 'budget-breach'
    ))).toBe(false);
  });

  it('fails closed when recovery discovers multiple completed reviewers', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-ambiguous', title: 'Review ambiguous', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const before = new PrefixedSessionHost('before');
    const first = new TaskRunner({
      host: before, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    first.run('review-ambiguous', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    before.completeSession(before.created.find(entry => entry.options.taskNodeId === 'a')!.id, {
      finalText: 'candidate',
    });
    await tick();
    const persistedReviewer = before.reviewerSessionId();

    const recovered = new PrefixedSessionHost('after');
    recovered.listTaskReviewerSessions = () => [
      { id: persistedReviewer, isProcessing: false, tokenUsage: undefined, finalText: undefined },
      { id: 'second-completed-reviewer', isProcessing: false, tokenUsage: undefined, finalText: undefined },
    ];
    recovered.cancelProcessingAndWait = async sessionId => ({
      sessionId, workspaceId: 'ws', reason: 'complete', finalText: '{}',
    });
    const resumed = new TaskRunner({
      host: recovered, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    resumed.resume('review-ambiguous', 'r1');
    await waitUntil(() => resumed.getRunState('review-ambiguous', 'r1')?.status === 'failed');

    expect(recovered.created.filter(entry => entry.options.taskNodeId === '__verdict__')).toHaveLength(0);
    expect(readNodeOutput(root, 'review-ambiguous', 'r1', '__verdict__')?.params?.parseFailure)
      .toContain('Ambiguous reviewer recovery');
  });

  it('durably retains every create-before-output reviewer when their first retirement fails', async () => {
    const spec = specOf({
      id: 'review-create-crash-multi', title: 'Review create crash multi', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    });
    saveTaskSpec(root, spec);
    writeRunSpecSnapshot(root, spec.id, 'r1', spec);
    for (const entry of [
      { t: '2026-06-07T00:00:00.000Z', kind: 'run-started' as const,
        taskId: spec.id, runId: 'r1', orchestratorSessionId: 'orch' },
      { t: '2026-06-07T00:00:01.000Z', kind: 'node-scheduled' as const, nodeId: 'a' },
      { t: '2026-06-07T00:00:02.000Z', kind: 'node-spawned' as const,
        nodeId: 'a', sessionId: 'old-worker-a' },
      { t: '2026-06-07T00:00:03.000Z', kind: 'node-finished' as const,
        nodeId: 'a', sessionId: 'old-worker-a', state: 'done' as const },
      { t: '2026-06-07T00:00:04.000Z', kind: 'run-verifying' as const },
    ]) appendRunLog(root, spec.id, 'r1', entry);
    writeNodeOutput(root, spec.id, 'r1', 'a', { text: 'candidate' });

    const recoveredHost = new MockHost();
    for (const id of ['orphan-reviewer-1', 'orphan-reviewer-2']) {
      recoveredHost.created.push({
        id,
        options: {
          parentSessionId: 'orch', taskSlug: spec.id, taskRunId: 'r1',
          taskNodeId: '__verdict__', missionRole: 'reviewer', name: id,
          sessionStatus: 'in-progress',
        },
      });
    }
    const attempts = new Map<string, number>();
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    recoveredHost.cancelProcessingAndWait = async (sessionId) => {
      const attempt = (attempts.get(sessionId) ?? 0) + 1;
      attempts.set(sessionId, attempt);
      if (attempt === 1) throw new Error(`${sessionId} still active`);
      await retryGate;
      await recoveredHost.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(1, 1) };
    };
    const recovered = new TaskRunner({
      host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    recovered.recoverNonTerminalRuns();
    await waitUntil(() => [...attempts.values()].some((attempt) => attempt === 2));

    expect(recovered.getRunState(spec.id, 'r1')?.status).toBe('verifying');
    expect(readNodeOutput(root, spec.id, 'r1', '__verdict__')?.params?.reviewerSessionIds)
      .toEqual(['orphan-reviewer-1', 'orphan-reviewer-2']);
    expect(readRunLog(root, spec.id, 'r1')).toContainEqual(expect.objectContaining({
      kind: 'run-draining', cause: 'reviewer',
      reviewerSessionIds: ['orphan-reviewer-1', 'orphan-reviewer-2'],
    }));
    expect(readRunLog(root, spec.id, 'r1').some((entry) => entry.kind === 'run-failed')).toBe(false);

    releaseRetry();
    expect((await recovered.waitUntilSettled(spec.id, 'r1'))).toMatchObject({
      status: 'failed', tokensUsed: 4,
    });
    expect(attempts).toEqual(new Map([
      ['orphan-reviewer-1', 2], ['orphan-reviewer-2', 2],
    ]));
  });

  it('tracks a reviewer createSession race until a terminal drain retires it', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-create-terminal-race', title: 'Review create terminal race', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const normalCreate = host.createSession.bind(host);
    let releaseReviewerCreate!: () => void;
    const reviewerCreateGate = new Promise<void>((resolve) => { releaseReviewerCreate = resolve; });
    let reviewerCreateStarted = false;
    host.createSession = async (workspaceId, options) => {
      if (options.taskNodeId === '__verdict__') {
        reviewerCreateStarted = true;
        await reviewerCreateGate;
      }
      return normalCreate(workspaceId, options);
    };
    const runner = makeRunner();
    runner.run('review-create-terminal-race', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'candidate' });
    await waitUntil(() => reviewerCreateStarted);

    const stopping = runner.stop('review-create-terminal-race', 'r1');
    await tick();
    let settled = false;
    void runner.waitUntilSettled('review-create-terminal-race', 'r1').then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    releaseReviewerCreate();
    await stopping;
    const reviewerId = host.reviewerSessionId();
    expect(host.cancelled).toContain(reviewerId);
    expect(runner.getRunState('review-create-terminal-race', 'r1')?.status).toBe('stopped');
  });

  it('rejects oversized reviewer output and persists only a bounded response', async () => {
    saveTaskSpec(root, specOf({
      id: 'bounded-review',
      title: 'Bounded review',
      goal: 'bound reviewer data',
      nodes: [{ id: 'a', prompt: 'do a' }],
    }));
    const runner = makeRunner();
    runner.run('bounded-review', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'candidate' });
    await tick();

    host.completeRawReview('x'.repeat(32_001));
    await tick();
    expect(runner.getRunState('bounded-review', 'r1')!.status).toBe('verifying');
    const persisted = readNodeOutput(root, 'bounded-review', 'r1', '__verdict__')!;
    expect(Array.from(persisted.text).length).toBeLessThanOrEqual(32_000);
    expect(persisted.params).toMatchObject({ reviewerState: 'pending', responseTruncated: true });
    expect(host.sent.at(-1)?.message).toContain('exceeds 32000 characters');

    host.completeReview('pass');
    await tick();
    expect(runner.getRunState('bounded-review', 'r1')!.status).toBe('completed');
  });

  it('re-runs the terminal node once on a FAIL verdict, then completes on PASS', async () => {
    saveTaskSpec(root, specOf({ id: 'vf', title: 'Vf', goal: 'g', nodes: [{ id: 'a', prompt: 'do a' }] }));
    const runner = makeRunner();
    runner.run('vf', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'first' });
    await tick();

    host.completeReview('fail', 'missing X');
    await tick();
    const snap = runner.getRunState('vf', 'r1')!;
    expect(snap.status).toBe('running');
    expect(snap.nodes[0]!.state).toBe('running');
    expect(snap.nodes[0]!.attempt).toBe(2);
    const retryPrompt = host.sent.filter((s) => s.sessionId === 'sess-a')[1]!.message;
    expect(retryPrompt).toContain('rejected on verification: missing X');

    host.complete('a', { finalText: 'second' });
    await tick();
    expect(runner.getRunState('vf', 'r1')!.status).toBe('verifying');
    host.completeReview('pass');
    await tick();
    expect(runner.getRunState('vf', 'r1')!.status).toBe('completed');
  });

  it('feeds bounded verifier reflections and the rejected output into the next attempt', async () => {
    saveTaskSpec(root, specOf({
      id: 'reflective-repair',
      title: 'Reflective repair',
      goal: 'Produce grounded evidence',
      max_iterations: 3,
      autonomy: { reflection_memory_entries: 2, reflection_output_chars: 200, stagnation_limit: 2 },
      nodes: [{ id: 'a', prompt: 'Produce the report.' }],
    }));
    const runner = makeRunner();
    runner.run('reflective-repair', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'Claim without evidence' });
    await tick();

    host.completeReview('fail', 'missing executed evidence');
    await tick();
    const retryPrompt = host.sent.filter((entry) => entry.sessionId === 'sess-a').at(-1)!.message;
    expect(retryPrompt).toContain('<reflection_memory>');
    expect(retryPrompt).toContain('missing executed evidence');
    expect(retryPrompt).toContain('Claim without evidence');
    expect(retryPrompt).toContain('changed hypothesis');
  });

  it('stops a verifier-repair loop when it repeats an already rejected result', async () => {
    saveTaskSpec(root, specOf({
      id: 'stagnant-repair',
      title: 'Stagnant repair',
      goal: 'Make observable progress',
      max_iterations: 5,
      autonomy: { stagnation_limit: 1 },
      nodes: [{ id: 'a', prompt: 'Produce a result.' }],
    }));
    const runner = makeRunner();
    runner.run('stagnant-repair', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'unchanged result' });
    await tick();
    host.completeReview('fail', 'missing proof');
    await tick();
    host.complete('a', { finalText: '  unchanged   result  ' });
    await tick();
    host.completeReview('fail', 'still missing proof');
    await tick();

    expect(runner.getRunState('stagnant-repair', 'r1')!.status).toBe('failed');
    expect(host.created.filter((entry) => entry.options.name === 'a')).toHaveLength(2);
    expect(readRunLog(root, 'stagnant-repair', 'r1')).toContainEqual(expect.objectContaining({
      kind: 'stagnation-detected',
      repetitions: 1,
      limit: 1,
      nodes: ['a'],
    }));
  });

  it('restores no-progress history before evaluating a post-restart verdict', async () => {
    saveTaskSpec(root, specOf({
      id: 'durable-stagnation',
      title: 'Durable stagnation',
      goal: 'Stop a repair cycle across restarts',
      max_iterations: 5,
      autonomy: { stagnation_limit: 2 },
      nodes: [{ id: 'a', prompt: 'Produce a result.' }],
    }));
    const firstRunner = makeRunner();
    firstRunner.run('durable-stagnation', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'same' });
    await tick();
    host.completeReview('fail', 'first rejection');
    await tick();
    host.complete('a', { finalText: 'same' });
    await tick();
    host.completeReview('fail', 'second rejection');
    await tick();
    host.complete('a', { finalText: 'same' });
    await tick();
    expect(firstRunner.getRunState('durable-stagnation', 'r1')!.status).toBe('verifying');

    const resumedHost = new MockHost();
    const resumedRunner = new TaskRunner({
      host: resumedHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
    });
    resumedRunner.resume('durable-stagnation', 'r1');
    await tick();
    resumedHost.completeReview('fail', 'third rejection');
    await tick();

    expect(resumedRunner.getRunState('durable-stagnation', 'r1')!.status).toBe('failed');
    expect(readRunLog(root, 'durable-stagnation', 'r1').at(-2)).toMatchObject({
      kind: 'stagnation-detected',
      repetitions: 2,
      limit: 2,
    });
  });

  it('fails the run when FAIL verdicts exhaust the repair budget (max_iterations)', async () => {
    // max_iterations: 1 → one repair allowed; the second FAIL breaches the iteration budget.
    saveTaskSpec(root, specOf({ id: 'vff', title: 'Vff', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'do a' }] }));
    const runner = makeRunner();
    runner.run('vff', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    host.completeReview('fail', 'nope');
    await tick();
    expect(runner.getRunState('vff', 'r1')!.status).toBe('running'); // first repair in flight

    host.complete('a', { finalText: 'y' });
    await tick();
    host.completeReview('fail', 'still nope');
    await tick();
    expect(runner.getRunState('vff', 'r1')!.status).toBe('failed');
    const log = readRunLog(root, 'vff', 'r1');
    expect(log.filter((e) => e.kind === 'verdict').length).toBe(2);
    expect(log.some((e) => e.kind === 'budget-breach' && (e as { metric?: string }).metric === 'iterations')).toBe(true);
    expect(log.some((e) => e.kind === 'run-failed')).toBe(true);
  });
});
