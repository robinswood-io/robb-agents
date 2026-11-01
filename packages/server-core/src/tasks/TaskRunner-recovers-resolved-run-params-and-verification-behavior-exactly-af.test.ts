import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer, operationValueHash, type SignedExecutionProof } from "@craft-agent/shared/governance";
import { appendRunLog, saveTaskSpec, readRunLog, writeNodeOutput, writeRunSpecSnapshot } from "@craft-agent/shared/tasks";
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

  function issueTaskProof(
    issuer: ExecutionProofIssuer,
    missionId: string,
    nodeId: string,
    idempotencyKey: string,
    reconciliationStatus: 'confirmed' | 'diverged' = 'confirmed',
  ): SignedExecutionProof {
    return issuer.issue({
      clientId: 'client-1',
      workspaceId: 'ws',
      missionId,
      nodeId,
      agentId: 'agent-1',
      connectorId: 'connector-1',
      operationId: 'records.upsert',
      idempotencyKey,
      payloadHash: operationValueHash({ record: 'input' }),
      resultHash: operationValueHash({ record: 'output' }),
      providerRequestId: 'provider-request-1',
      policyVersion: 1,
      authorizationGeneration: 1,
      connectorManifestHash: operationValueHash({ manifest: 'v1' }),
      reconciliation: {
        status: reconciliationStatus,
        observedAt: '2026-06-07T00:00:01.000Z',
        providerStateHash: operationValueHash({ present: reconciliationStatus === 'confirmed' }),
        ...(reconciliationStatus === 'diverged' ? { detailCode: 'PROVIDER_STATE_MISSING' } : {}),
      },
    });
  }

  it('recovers resolved run params and verification behavior exactly after restart', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'context-resume',
        title: 'Context resume',
        goal: 'g',
        params: [{ name: 'env', default: 'dev' }],
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'deploy ${params.env} using ${nodes.a.output}' },
        ],
      }),
    );
    const first = makeRunner();
    first.run('context-resume', {
      runId: 'r1',
      params: { env: 'prod' },
      verifyOnComplete: false,
    });
    await tick();
    host.complete('a', { finalText: 'A' });
    await tick();
    first.pause('context-resume', 'r1');

    const recoveredHost = new MockHost();
    const recovered = new TaskRunner({ host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch });
    recovered.resume('context-resume', 'r1');
    await tick();

    expect(recoveredHost.promptFor('b')?.endsWith('deploy prod using A')).toBe(true);
    recoveredHost.complete('b', { finalText: 'B' });
    await tick();
    expect(recovered.getRunState('context-resume', 'r1')?.status).toBe('completed');
  });

  it('does not replay an in-flight node after a crash without operator review', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'ambiguous',
        title: 'Ambiguous',
        goal: 'g',
        nodes: [{ id: 'mutate', prompt: 'mutate once', effect: 'external-mutation' }],
      }),
    );
    const first = makeRunner();
    first.run('ambiguous', { runId: 'r1' });
    await tick();
    expect(readRunLog(root, 'ambiguous', 'r1').some(
      (entry) => entry.kind === 'node-checkpoint' && entry.status === 'executing',
    )).toBe(true);

    // Simulate a process crash before a completion/proof checkpoint.
    const host2 = new MockHost();
    const resumed = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch });
    resumed.resume('ambiguous', 'r1');
    await tick();

    expect(host2.created).toHaveLength(0);
    expect(resumed.getRunState('ambiguous', 'r1')?.status).toBe('failed');
    expect(resumed.getRunState('ambiguous', 'r1')?.nodes[0]?.state).toBe('failed');
  });

  it('recovers a confirmed read checkpoint when the process died before node-finished', async () => {
    const spec = specOf({
      id: 'confirmed-before-finished',
      title: 'Confirmed before finished',
      goal: 'recover the committed output',
      nodes: [{ id: 'inspect', prompt: 'inspect' }],
    });
    saveTaskSpec(root, spec);
    writeRunSpecSnapshot(root, spec.id, 'r1', spec);
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: spec.id, runId: 'r1',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:01.000Z', kind: 'node-scheduled', nodeId: 'inspect',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:02.000Z', kind: 'node-spawned', nodeId: 'inspect', sessionId: 'old-session',
    });
    writeNodeOutput(root, spec.id, 'r1', 'inspect', { text: 'durable result' });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:03.000Z', kind: 'node-checkpoint', nodeId: 'inspect',
      idempotencyKey: 'ws:confirmed-before-finished:r1:inspect', status: 'confirmed',
      proofHash: operationValueHash('durable result'),
    });

    const recoveredHost = new MockHost();
    const recovered = new TaskRunner({
      host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    const [snapshot] = recovered.recoverNonTerminalRuns();

    expect(snapshot).toMatchObject({ status: 'completed', nodes: [{ id: 'inspect', state: 'done' }] });
    expect(recoveredHost.created).toHaveLength(0);
  });

  it('recovers a rejected approval when the process died before node-finished', async () => {
    const spec = specOf({
      id: 'rejected-before-finished',
      title: 'Rejected before finished',
      goal: 'preserve the rejection',
      nodes: [{ id: 'publish', prompt: 'publish', effect: 'external-mutation', approval: true }],
    });
    saveTaskSpec(root, spec);
    writeRunSpecSnapshot(root, spec.id, 'r1', spec);
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: spec.id, runId: 'r1',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:01.000Z', kind: 'approval-requested', requestId: 'approval-1',
      nodeId: 'publish', reason: 'high impact', impact: 'high',
    });
    appendRunLog(root, spec.id, 'r1', {
      t: '2026-06-07T00:00:02.000Z', kind: 'approval-resolved', requestId: 'approval-1',
      nodeId: 'publish', decision: 'rejected', actor: 'reviewer', comment: 'not authorized',
    });

    const recoveredHost = new MockHost();
    const recovered = new TaskRunner({
      host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    const [snapshot] = recovered.recoverNonTerminalRuns();

    expect(snapshot).toMatchObject({ status: 'failed', nodes: [{ id: 'publish', state: 'failed' }] });
    expect(recovered.listPendingApprovals(spec.id, 'r1')).toHaveLength(0);
    expect(recoveredHost.created).toHaveLength(0);
  });

  it('fences an asynchronous dispatch that resumes after the run was stopped', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'fenced-stop', title: 'Fenced stop', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }),
    );
    let releaseGuard!: () => void;
    const guard = new Promise<{ allowed: true }>((resolve) => {
      releaseGuard = () => resolve({ allowed: true });
    });
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      executionGuard: () => guard,
    });
    runner.run('fenced-stop', { runId: 'r1', verifyOnComplete: false });
    await tick();
    await runner.stop('fenced-stop', 'r1');
    releaseGuard();
    await tick();
    await tick();

    expect(runner.getRunState('fenced-stop', 'r1')).toMatchObject({
      status: 'stopped', nodes: [{ id: 'a', state: 'cancelled' }],
    });
    expect(host.created).toHaveLength(0);
    expect(host.sent).toHaveLength(0);
  });

  it('recovers a proven external mutation without dispatching it twice', async () => {
    const issuer = new ExecutionProofIssuer({
      signingKey: 'task-runner-recovery-proof-key-32-bytes',
      now: () => '2026-06-07T00:00:01.000Z',
      generateId: () => 'proof-recovered-mutation',
    });
    saveTaskSpec(
      root,
      specOf({
        id: 'proven-recovery',
        title: 'Proven recovery',
        goal: 'reuse a reconciled mutation',
        nodes: [
          { id: 'publish', prompt: 'publish once', effect: 'external-mutation' },
          { id: 'report', prompt: 'report ${nodes.publish.output}', depends_on: ['publish'] },
        ],
      }),
    );

    const first = makeRunner(issuer);
    first.run('proven-recovery', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('publish', {
      finalText: 'provider confirmed',
      executionProof: issueTaskProof(
        issuer,
        'proven-recovery',
        'publish',
        'ws:proven-recovery:r1:publish',
      ),
    });
    await tick();
    first.pause('proven-recovery', 'r1');

    const recoveredHost = new MockHost();
    const recovered = new TaskRunner({
      host: recoveredHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      verifyExecutionProof: (proof, binding) => issuer.verifyForTask(proof, binding),
    });
    recovered.resume('proven-recovery', 'r1');
    await tick();

    expect(recoveredHost.dispatchedNames()).toEqual(['report']);
    expect(recoveredHost.promptFor('report')?.endsWith('report provider confirmed')).toBe(true);
  });

  it('enforces the task timeout and cancels the child session', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'deadline',
        title: 'Deadline',
        goal: 'g',
        execution: { timeout_ms: 5 },
        nodes: [{ id: 'slow', prompt: 'wait' }],
      }),
    );
    const runner = makeRunner();
    runner.run('deadline', { runId: 'r1' });
    await waitUntil(() => host.cancelled.includes('sess-slow'));

    expect(host.cancelled).toContain('sess-slow');
    expect(runner.getRunState('deadline', 'r1')?.status).toBe('failed');
  });

  it('does not dispatch a timeout retry until the previous attempt is proven idle', async () => {
    saveTaskSpec(root, specOf({
      id: 'timeout-retirement-fence', title: 'Timeout retirement fence', goal: 'g',
      execution: { timeout_ms: 5 },
      nodes: [{
        id: 'slow', prompt: 'wait',
        retry: { limit: 1, when: ['error'] },
      }],
    }));
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    host.cancelProcessingAndWait = async (sessionId) => {
      await retirementGate;
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };
    const runner = makeRunner();
    runner.run('timeout-retirement-fence', { runId: 'r1', verifyOnComplete: false });
    await waitUntil(() => runner.getRunState('timeout-retirement-fence', 'r1')?.nodes[0]?.state === 'cancelled');
    expect(host.created.filter((entry) => entry.options.name === 'slow')).toHaveLength(1);

    releaseRetirement();
    await waitUntil(() => host.created.filter((entry) => entry.options.name === 'slow').length === 2);
    expect(runner.getRunState('timeout-retirement-fence', 'r1')).toMatchObject({
      status: 'running', tokensUsed: 3,
    });
  });

  it('fails a timed-out run only after retrying an initially unproven worker stop', async () => {
    saveTaskSpec(root, specOf({
      id: 'timeout-retirement-retry', title: 'Timeout retirement retry', goal: 'g',
      execution: { timeout_ms: 5 },
      nodes: [{ id: 'slow', prompt: 'wait' }],
    }));
    let attempts = 0;
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    host.cancelProcessingAndWait = async (sessionId) => {
      attempts += 1;
      if (attempts === 1) throw new Error('first timeout retirement unavailable');
      await retirementGate;
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };
    const runner = makeRunner();
    runner.run('timeout-retirement-retry', { runId: 'r1', verifyOnComplete: false });
    await waitUntil(() => attempts === 2);
    expect(runner.getRunState('timeout-retirement-retry', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'timeout-retirement-retry', 'r1').some(
      (entry) => entry.kind === 'run-failed',
    )).toBe(false);

    releaseRetirement();
    const result = await runner.waitUntilSettled('timeout-retirement-retry', 'r1');
    expect(result).toMatchObject({ status: 'failed', tokensUsed: 3 });
    expect(host.created.filter((entry) => entry.options.name === 'slow')).toHaveLength(1);
  });

  it('does not finish a parallel run while a timed-out peer is still retiring', async () => {
    saveTaskSpec(root, specOf({
      id: 'parallel-timeout-retirement', title: 'Parallel timeout retirement', goal: 'g',
      max_parallel: 2,
      nodes: [
        { id: 'a', prompt: 'hang', timeout: 5 },
        { id: 'b', prompt: 'finish', timeout: 1_000 },
      ],
    }));
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    let retirementStarted = false;
    host.cancelProcessingAndWait = async (sessionId) => {
      expect(sessionId).toBe('sess-a');
      retirementStarted = true;
      await retirementGate;
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };
    const runner = makeRunner();
    runner.run('parallel-timeout-retirement', { runId: 'r1', verifyOnComplete: false });
    await waitUntil(() => retirementStarted);

    host.complete('b', { finalText: 'done' });
    await tick();
    expect(runner.getRunState('parallel-timeout-retirement', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'parallel-timeout-retirement', 'r1').some(
      (entry) => entry.kind === 'run-failed',
    )).toBe(false);

    releaseRetirement();
    expect((await runner.waitUntilSettled('parallel-timeout-retirement', 'r1'))).toMatchObject({
      status: 'failed', tokensUsed: 3,
    });
  });

  it('arms the worker timeout before awaiting a provider turn that never resolves', async () => {
    saveTaskSpec(root, specOf({
      id: 'hung-worker-send', title: 'Hung worker send', goal: 'g',
      execution: { timeout_ms: 5 },
      nodes: [{ id: 'a', prompt: 'hang' }],
    }));
    host.sendMessage = async () => new Promise<void>(() => {});
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    let retirementStarted = false;
    host.cancelProcessingAndWait = async (sessionId) => {
      retirementStarted = true;
      await retirementGate;
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted' };
    };
    const runner = makeRunner();
    runner.run('hung-worker-send', { runId: 'r1', verifyOnComplete: false });
    await waitUntil(() => retirementStarted);
    expect(runner.getRunState('hung-worker-send', 'r1')).toMatchObject({
      status: 'running', nodes: [{ id: 'a', state: 'cancelled' }],
    });
    expect(readRunLog(root, 'hung-worker-send', 'r1').some(
      (entry) => entry.kind === 'run-failed',
    )).toBe(false);

    releaseRetirement();
    expect((await runner.waitUntilSettled('hung-worker-send', 'r1')).status).toBe('failed');
  });
});
