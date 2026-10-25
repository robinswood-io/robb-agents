import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { saveTaskSpec, readRunLog, readNodeOutput } from "@craft-agent/shared/tasks";
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

  it('re-asks on an unparsable verdict and fails only after the re-ask budget is exhausted', async () => {
    saveTaskSpec(root, specOf({ id: 'unp', title: 'Unp', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('unp', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();

    const reviewerId = host.reviewerSessionId();
    // First malformed reply → re-asked in the same reviewer, run stays verifying.
    host.completeRawReview('I think it is fine but forgot the JSON object.');
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('verifying');
    const reviewerMessages = host.sent.filter((s) => s.sessionId === reviewerId);
    const reAsk = reviewerMessages.filter(message => message.message.includes('rejected by the parser'));
    expect(reAsk).toHaveLength(1);
    expect(reAsk[0]!.options?.internalOrigin).toMatchObject({
      kind: 'spawned-session',
      senderSessionId: 'orch',
      authenticatedTaskText: reviewerMessages[0]!.message,
    });
    expect(reAsk[0]!.message.match(
      /<host_parent_review_contract>([^<]+)<\/host_parent_review_contract>/,
    )?.[1]).toBe(reviewerMessages[0]!.message.match(
      /<host_parent_review_contract>([^<]+)<\/host_parent_review_contract>/,
    )?.[1]);
    expect(readRunLog(root, 'unp', 'r1').filter((entry) => (
      entry.kind === 'verdict' && entry.result === 'unparsed'
    ))).toHaveLength(1);

    // Second malformed reply → re-asked again (MAX_UNPARSED_REASKS = 2).
    host.completeRawReview('still no JSON object, sorry');
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('verifying');

    // Third malformed reply → budget exhausted → failed.
    host.completeRawReview('nope, no JSON again');
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('failed');
    expect(readRunLog(root, 'unp', 'r1').filter((e) => e.kind === 'verdict' && (e as { result?: string }).result === 'unparsed').length).toBe(3);
  });

  it('scopes a repair to the named nodes and their transitive dependents', async () => {
    // Chain a → b → c. A FAIL naming only `b` must re-run b AND c (downstream), but leave a done.
    saveTaskSpec(
      root,
      specOf({
        id: 'scope',
        title: 'Scope',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
          { id: 'c', depends_on: ['b'], prompt: 'c ${nodes.b.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('scope', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'A' });
    await tick();
    host.complete('b', { finalText: 'B' });
    await tick();
    host.complete('c', { finalText: 'C' });
    await tick();
    expect(runner.getRunState('scope', 'r1')!.status).toBe('verifying');

    host.completeReview('fail', 'b is wrong', ['b']);
    await tick();
    const snap = runner.getRunState('scope', 'r1')!;
    expect(snap.status).toBe('running');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('done'); // upstream untouched
    expect(snap.nodes.find((n) => n.id === 'b')!.state).toBe('running'); // re-dispatched
    expect(snap.nodes.find((n) => n.id === 'c')!.state).toBe('pending'); // waits on b
    // a ran once; b re-dispatched (2); c not yet re-dispatched.
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
    expect(host.created.filter((c) => c.options.name === 'b')).toHaveLength(2);
    expect(host.created.filter((c) => c.options.name === 'c')).toHaveLength(1);
  });

  it('an unparsed re-ask does not consume the repair budget', async () => {
    // max_iterations: 1. An intervening unparsed verdict must not eat the single repair allowance.
    saveTaskSpec(root, specOf({ id: 'unb', title: 'Unb', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('unb', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();

    host.completeRawReview('no structured result here'); // unparsed → re-ask
    await tick();
    expect(runner.getRunState('unb', 'r1')!.status).toBe('verifying');

    host.completeReview('fail', 'fix it'); // first real FAIL → repair still allowed
    await tick();
    expect(runner.getRunState('unb', 'r1')!.status).toBe('running');
  });

  it('does not hang in verifying when the verification send rejects', async () => {
    saveTaskSpec(root, specOf({ id: 'snd', title: 'Snd', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('snd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    // Make the independent reviewer send reject (the verdict can never arrive).
    const origSend = host.sendMessage.bind(host);
    host.sendMessage = async (sessionId: string, message: string) => {
      if (sessionId !== 'sess-a') throw new Error('send boom');
      return origSend(sessionId, message);
    };
    host.complete('a', { finalText: 'x' });
    await tick();
    await tick();
    expect(runner.getRunState('snd', 'r1')!.status).toBe('failed');
  });

  it('arms the reviewer watchdog before awaiting a send that never resolves', async () => {
    saveTaskSpec(root, specOf({
      id: 'hung-review-send', title: 'Hung reviewer send', goal: 'g',
      execution: { timeout_ms: 10 },
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('hung-review-send', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    const normalSend = host.sendMessage.bind(host);
    host.sendMessage = async (sessionId, message, attachments, storedAttachments, options) => {
      if (sessionId === 'sess-a') {
        return normalSend(sessionId, message, attachments, storedAttachments, options);
      }
      await new Promise<void>(() => {});
    };
    host.complete('a', { finalText: 'candidate' });
    await waitUntil(() => runner.getRunState('hung-review-send', 'r1')?.status === 'failed', 500);

    expect(runner.getRunState('hung-review-send', 'r1')?.status).toBe('failed');
    expect(readNodeOutput(root, 'hung-review-send', 'r1', '__verdict__')?.params?.parseFailure)
      .toContain('reviewer timed out after 10 ms');
  });

  it('re-arms reviewer timeouts longer than the platform timer ceiling', async () => {
    jest.useFakeTimers();
    let nowMs = 0;
    const flushMicrotasks = async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    };
    const timeoutMs = 2_147_483_647 + 5_000;
    try {
      saveTaskSpec(root, specOf({
        id: 'long-review-timeout', title: 'Long review timeout', goal: 'g',
        execution: { timeout_ms: timeoutMs },
        nodes: [{ id: 'a', prompt: 'a' }],
      }));
      const runner = makeRunner(undefined, undefined, () => nowMs);
      runner.run('long-review-timeout', { runId: 'r1', orchestratorSessionId: 'orch' });
      await flushMicrotasks();
      host.complete('a', { finalText: 'candidate' });
      await flushMicrotasks();
      expect(runner.getRunState('long-review-timeout', 'r1')?.status).toBe('verifying');

      nowMs = 2_147_483_647;
      jest.advanceTimersByTime(2_147_483_647);
      await flushMicrotasks();
      expect(runner.getRunState('long-review-timeout', 'r1')?.status).toBe('verifying');

      nowMs = timeoutMs;
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      expect(runner.getRunState('long-review-timeout', 'r1')?.status).toBe('failed');
      expect(readNodeOutput(root, 'long-review-timeout', 'r1', '__verdict__')?.params?.parseFailure)
        .toContain(`reviewer timed out after ${timeoutMs} ms`);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not publish reviewer failure until strong retirement captures late usage', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-failure-retirement', title: 'Review failure retirement', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('review-failure-retirement', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'candidate', tokenUsage: tu(1, 1) });
    await tick();
    const reviewerId = host.reviewerSessionId();
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>(resolve => { releaseRetirement = resolve; });
    host.cancelProcessingAndWait = async sessionId => {
      expect(sessionId).toBe(reviewerId);
      await retirementGate;
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(4, 3, 0.25) };
    };

    host.completeSession(reviewerId, { reason: 'error' });
    await tick();
    expect(runner.getRunState('review-failure-retirement', 'r1')?.status).toBe('verifying');
    let settled = false;
    void runner.waitUntilSettled('review-failure-retirement', 'r1').then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    releaseRetirement();
    const result = await runner.waitUntilSettled('review-failure-retirement', 'r1');
    expect(result).toMatchObject({ status: 'failed', tokensUsed: 9, costUsed: 0.25 });
    expect(host.statuses).toContainEqual({ sessionId: reviewerId, status: 'cancelled' });
  });

  it('keeps reviewer failure non-terminal when stop cannot be proven and retries its failed intent', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-failure-stop-retry', title: 'Review failure stop retry', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('review-failure-stop-retry', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'candidate' });
    await tick();
    const reviewerId = host.reviewerSessionId();
    let retirementAttempts = 0;
    host.cancelProcessingAndWait = async sessionId => {
      retirementAttempts += 1;
      expect(sessionId).toBe(reviewerId);
      if (retirementAttempts === 1) throw new Error('reviewer still stopping');
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };

    host.completeSession(reviewerId, { reason: 'error' });
    await waitUntil(() => retirementAttempts === 1);
    expect(runner.getRunState('review-failure-stop-retry', 'r1')?.status).toBe('verifying');
    let settled = false;
    void runner.waitUntilSettled('review-failure-stop-retry', 'r1').then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    await runner.stop('review-failure-stop-retry', 'r1');
    expect(retirementAttempts).toBe(2);
    expect((await runner.waitUntilSettled('review-failure-stop-retry', 'r1'))).toMatchObject({
      status: 'failed', tokensUsed: 3,
    });
  });

  it('keeps a stopped run retryable when strong reviewer retirement initially fails', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-stop-retry', title: 'Review stop retry', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const runner = makeRunner();
    runner.run('review-stop-retry', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'candidate' });
    await tick();
    const reviewerId = host.reviewerSessionId();
    let attempts = 0;
    host.cancelProcessingAndWait = async sessionId => {
      attempts += 1;
      expect(sessionId).toBe(reviewerId);
      if (attempts === 1) throw new Error('retirement unavailable');
      return { sessionId, workspaceId: 'ws', reason: 'interrupted' };
    };

    await expect(runner.stop('review-stop-retry', 'r1')).rejects.toThrow('could not be retired');
    expect(runner.getRunState('review-stop-retry', 'r1')?.status).toBe('verifying');
    let settled = false;
    void runner.waitUntilSettled('review-stop-retry', 'r1').then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    await runner.stop('review-stop-retry', 'r1');
    expect(attempts).toBe(2);
    expect((await runner.waitUntilSettled('review-stop-retry', 'r1')).status).toBe('stopped');
  });

  it('ignores a verdict that arrives after the run was stopped', async () => {
    saveTaskSpec(root, specOf({ id: 'late', title: 'Late', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('late', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('late', 'r1')!.status).toBe('verifying');

    const reviewerId = host.reviewerSessionId();
    await runner.stop('late', 'r1');
    expect(runner.getRunState('late', 'r1')!.status).toBe('stopped');
    expect(host.cancelled).toContain(reviewerId);

    // A late result from the cancelled reviewer must not flip it back.
    host.completeSession(reviewerId, {
      finalText: JSON.stringify({ schemaVersion: 1, result: 'pass', reason: '', nodes: [] }),
    });
    await tick();
    expect(runner.getRunState('late', 'r1')!.status).toBe('stopped');
  });

  it('reconstructs the repair counter from the run-log on a cross-restart resume', async () => {
    // max_iterations: 1. Consume the single repair, then "restart": the resumed run must remember
    // repairsUsed=1 (from the persisted FAIL verdict) so the next FAIL fails immediately.
    saveTaskSpec(root, specOf({ id: 'hyd', title: 'Hyd', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'a' }] }));
    const r1 = makeRunner();
    r1.run('hyd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    host.completeReview('fail', 'redo'); // consumes the one repair
    await tick();
    expect(r1.getRunState('hyd', 'r1')!.status).toBe('running');
    host.complete('a', { finalText: 'repaired' });
    await tick();
    expect(r1.getRunState('hyd', 'r1')!.status).toBe('verifying');

    // Restart: fresh host + runner with empty in-memory state, resume from the run-log.
    const host2 = new MockHost();
    const r2 = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch, now: () => '2026-06-07T00:00:00.000Z' });
    r2.resume('hyd', 'r1');
    await tick();
    expect(r2.getRunState('hyd', 'r1')!.status).toBe('verifying');

    // A single FAIL now exhausts the (carried-over) budget immediately.
    host2.completeReview('fail', 'still bad');
    await tick();
    expect(r2.getRunState('hyd', 'r1')!.status).toBe('failed');
  });

  it('fails a node that completes with no text despite declaring outputs (instead of marking it done)', async () => {
    // Bug 2: a clean turn-completion is not proof of success. A node that declared `outputs` but
    // produced empty final text delivered nothing — it must fail (→ needs-review), not silently pass.
    saveTaskSpec(
      root,
      specOf({
        id: 'empty',
        title: 'Empty',
        goal: 'g',
        nodes: [{ id: 'a', prompt: 'a', outputs: [{ name: 'result' }] }],
      }),
    );
    const runner = makeRunner();
    runner.run('empty', { runId: 'r1' });
    await tick();

    host.complete('a', { finalText: '   ' }); // whitespace-only → counts as empty
    await tick();

    const snap = runner.getRunState('empty', 'r1')!;
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('failed');
    expect(snap.status).toBe('failed');
    expect(host.statuses.some((s) => s.sessionId === 'sess-a' && s.status === 'needs-review')).toBe(true);
  });

  it('still marks a node done on empty text when it declares no outputs (lenient default)', async () => {
    // The empty-output guard must only bite nodes that declared outputs; output-less nodes keep the
    // lenient "completed = done" behavior.
    saveTaskSpec(root, specOf({ id: 'lenient', title: 'Lenient', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('lenient', { runId: 'r1' });
    await tick();

    host.complete('a', { finalText: '' });
    await tick();

    expect(runner.getRunState('lenient', 'r1')!.nodes.find((n) => n.id === 'a')!.state).toBe('done');
  });

  it('publishes the total node count to the orchestrator at run start (stable board denominator)', async () => {
    // Bug 3: the board derives subtask progress from lazily-spawned child sessions, so without an
    // up-front total the denominator grows (0/1 → 1/2 …). The runner publishes spec.nodes.length once.
    saveTaskSpec(
      root,
      specOf({
        id: 'count',
        title: 'Count',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b' },
          { id: 'c', depends_on: ['b'], prompt: 'c' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('count', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();

    expect(host.nodeCounts).toContainEqual({ sessionId: 'orch', count: 3 });
  });
});
