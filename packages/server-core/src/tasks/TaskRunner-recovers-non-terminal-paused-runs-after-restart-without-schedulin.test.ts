import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { appendRunLog, saveTaskSpec, readRunLog, writeRunSpecSnapshot } from "@craft-agent/shared/tasks";
import { TaskRunner } from "./TaskRunner";
import type { SubagentAutonomyContext } from "../subagents/autonomy-inheritance.ts";
import { MockHost, UniqueSessionHost, inactiveKillSwitch, specOf, tick } from "./testing/TaskRunner-fixture.ts";

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

  it('recovers non-terminal paused runs after restart without scheduling until resumed', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'auto-recover',
        title: 'Auto recover',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b' },
        ],
      }),
    );
    const first = makeRunner();
    first.run('auto-recover', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { finalText: 'A' });
    await tick();
    first.pause('auto-recover', 'r1');

    const recoveredHost = new MockHost();
    const recovered = new TaskRunner({ host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch });
    const snapshots = recovered.recoverNonTerminalRuns();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status).toBe('paused');
    expect(recoveredHost.created).toHaveLength(0);

    recovered.resume('auto-recover', 'r1');
    await tick();
    expect(recoveredHost.dispatchedNames()).toEqual(['b']);
  });

  it('quarantines a corrupt run log and continues recovering valid runs', async () => {
    for (const id of ['corrupt-run', 'valid-run']) {
      saveTaskSpec(root, specOf({ id, title: id, goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
      const runner = makeRunner();
      runner.run(id, { runId: 'r1', verifyOnComplete: false });
      await tick();
      runner.pause(id, 'r1');
    }
    const corruptPath = join(root, 'tasks', 'corrupt-run', 'runs', 'r1', 'run-log.jsonl');
    const corruptLines = readFileSync(corruptPath, 'utf8').trimEnd().split('\n');
    const firstRecord = JSON.parse(corruptLines[0]!) as Record<string, unknown>;
    firstRecord.kind = 'run-stopped';
    corruptLines[0] = JSON.stringify(firstRecord);
    writeFileSync(corruptPath, `${corruptLines.join('\n')}\n`, 'utf8');

    const failures: string[] = [];
    const recovered = new TaskRunner({
      host: new MockHost(),
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      onRecoveryError: ({ slug, error }) => failures.push(`${slug}:${error.message}`),
    }).recoverNonTerminalRuns();

    expect(recovered.map((snapshot) => snapshot.slug)).toEqual(['valid-run']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('corrupt-run');
  });

  it('recovers a snapshotted run after its live task.yaml is deleted', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'deleted-live-spec',
        title: 'Deleted live spec',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    const first = makeRunner();
    first.run('deleted-live-spec', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { finalText: 'A' });
    await tick();
    first.pause('deleted-live-spec', 'r1');
    rmSync(join(root, 'tasks', 'deleted-live-spec', 'task.yaml'));

    const recoveredHost = new MockHost();
    const recovered = new TaskRunner({ host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch });
    const snapshots = recovered.recoverNonTerminalRuns();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status).toBe('paused');
    recovered.resume('deleted-live-spec', 'r1');
    await tick();
    expect(recoveredHost.promptFor('b')?.endsWith('b A')).toBe(true);
  });

  it('recovers 1,000 ambiguous mutation checkpoints with zero duplicate dispatches', () => {
    const spec = specOf({
      id: 'recovery-scale',
      title: 'Recovery scale',
      goal: 'prove exactly-once recovery admission',
      nodes: [{ id: 'mutate', prompt: 'perform one external mutation', effect: 'external-mutation' }],
    });
    saveTaskSpec(root, spec);

    const checkpointCount = 1_000;
    for (let index = 0; index < checkpointCount; index += 1) {
      const runId = `run-${String(index).padStart(4, '0')}`;
      const sessionId = `original-session-${index}`;
      writeRunSpecSnapshot(root, spec.id, runId, spec);
      appendRunLog(root, spec.id, runId, {
        t: '2026-06-07T00:00:00.000Z',
        kind: 'run-started',
        taskId: spec.id,
        runId,
      });
      appendRunLog(root, spec.id, runId, {
        t: '2026-06-07T00:00:01.000Z',
        kind: 'node-scheduled',
        nodeId: 'mutate',
      });
      appendRunLog(root, spec.id, runId, {
        t: '2026-06-07T00:00:02.000Z',
        kind: 'node-spawned',
        nodeId: 'mutate',
        sessionId,
      });
      appendRunLog(root, spec.id, runId, {
        t: '2026-06-07T00:00:03.000Z',
        kind: 'node-checkpoint',
        nodeId: 'mutate',
        idempotencyKey: `key-${index}`,
        status: 'executing',
      });
    }

    const recoveredHost = new MockHost();
    const recovered = new TaskRunner({ host: recoveredHost, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch });
    const snapshots = recovered.recoverNonTerminalRuns();

    expect(snapshots).toHaveLength(checkpointCount);
    expect(snapshots.every((snapshot) => snapshot.status === 'failed')).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.nodes[0]?.state === 'failed')).toBe(true);
    expect(recoveredHost.created).toHaveLength(0);

    let originalSpawnCount = 0;
    for (let index = 0; index < checkpointCount; index += 1) {
      const runId = `run-${String(index).padStart(4, '0')}`;
      originalSpawnCount += readRunLog(root, spec.id, runId)
        .filter((entry) => entry.kind === 'node-spawned').length;
    }
    expect(originalSpawnCount).toBe(checkpointCount);
  }, 300_000);

  it('retries a failed node up to retry.limit, then fails', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rt', title: 'Rt', goal: 'g', nodes: [{ id: 'a', prompt: 'do a', retry: { limit: 1 } }] }),
    );
    const runner = makeRunner();
    runner.run('rt', { runId: 'r1' });
    await tick();

    // First failure → within budget → re-dispatched (still running, attempt 2).
    host.complete('a', { reason: 'error' });
    await tick();
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(2);
    let snap = runner.getRunState('rt', 'r1')!;
    expect(snap.nodes[0]!.state).toBe('running');
    expect(snap.nodes[0]!.attempt).toBe(2);
    const checkpointKeys = readRunLog(root, 'rt', 'r1')
      .filter((entry) => entry.kind === 'node-checkpoint')
      .map((entry) => entry.idempotencyKey);
    expect(new Set(checkpointKeys)).toEqual(new Set(['ws:rt:r1:a']));

    // Second failure → budget exhausted → failed.
    host.complete('a', { reason: 'error' });
    await tick();
    snap = runner.getRunState('rt', 'r1')!;
    expect(snap.status).toBe('failed');
    expect(snap.nodes[0]!.state).toBe('failed');
    expect(readRunLog(root, 'rt', 'r1').some((e) => e.kind === 'node-retry')).toBe(true);
  });

  it('does not retry when retry.limit is 0', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rt0', title: 'Rt0', goal: 'g', nodes: [{ id: 'a', prompt: 'a', retry: { limit: 0 } }] }),
    );
    const runner = makeRunner();
    runner.run('rt0', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    expect(runner.getRunState('rt0', 'r1')!.status).toBe('failed');
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
  });

  it('automatically retries transient errors when the runner provides a default policy', async () => {
    saveTaskSpec(root, specOf({ id: 'auto-retry', title: 'Auto retry', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      defaultRetry: { limit: 2, when: ['error', 'empty'] },
    });
    runner.run('auto-retry', { runId: 'r1' });
    await tick();

    host.complete('a', { reason: 'error' });
    await tick();
    host.complete('a', { reason: 'timeout' });
    await tick();
    host.complete('a', { finalText: 'recovered' });
    await tick();

    expect(host.created.filter((created) => created.options.name === 'a')).toHaveLength(3);
    expect(runner.getRunState('auto-retry', 'r1')!.status).toBe('completed');
  });

  it('preserves the selected connection, model and reasoning through retries', async () => {
    saveTaskSpec(root, specOf({ id: 'manual-retry', title: 'Manual retry', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    let defaultsReads = 0;
    const runner = new TaskRunner({
      host, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
      defaultRetry: { limit: 1, when: 'error' },
      getModelDefaults: () => {
        defaultsReads += 1;
        return { llmConnection: 'primary', model: 'selected-model', thinkingLevel: 'medium' };
      },
    });
    runner.run('manual-retry', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    expect(defaultsReads).toBe(2);
    expect(host.created.filter(entry => entry.options.name === 'a').map(entry => ({
      model: entry.options.model, llmConnection: entry.options.llmConnection, thinkingLevel: entry.options.thinkingLevel,
    }))).toEqual([
      { model: 'selected-model', llmConnection: 'primary', thinkingLevel: 'medium' },
      { model: 'selected-model', llmConnection: 'primary', thinkingLevel: 'medium' },
    ]);
  });

  it('ignores a stale completion emitted by an earlier retry attempt', async () => {
    const uniqueHost = new UniqueSessionHost();
    saveTaskSpec(root, specOf({ id: 'stale-retry', title: 'Stale retry', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = new TaskRunner({
      host: uniqueHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      defaultRetry: { limit: 1, when: 'error' },
    });
    runner.run('stale-retry', { runId: 'r1' });
    await tick();
    const firstSessionId = uniqueHost.created[0]!.id;

    uniqueHost.completeSession(firstSessionId, { reason: 'error' });
    await tick();
    const secondSessionId = uniqueHost.created[1]!.id;
    uniqueHost.completeSession(firstSessionId, { finalText: 'stale success' });
    await tick();

    expect(runner.getRunState('stale-retry', 'r1')!.nodes[0]).toMatchObject({ state: 'running', attempt: 2 });
    uniqueHost.completeSession(secondSessionId, { finalText: 'fresh success' });
    await tick();
    expect(runner.getRunState('stale-retry', 'r1')!.status).toBe('completed');
  });

  it('automatically retries an empty declared output but not an invalid execution policy', async () => {
    saveTaskSpec(root, specOf({
      id: 'auto-empty',
      title: 'Auto empty',
      goal: 'g',
      nodes: [{ id: 'a', prompt: 'a', outputs: [{ name: 'result' }] }],
    }));
    const retryRunner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      defaultRetry: { limit: 1, when: ['error', 'empty'] },
    });
    retryRunner.run('auto-empty', { runId: 'r1' });
    await tick();
    host.complete('a', { finalText: ' ' });
    await tick();
    host.complete('a', { finalText: 'recovered' });
    await tick();
    expect(retryRunner.getRunState('auto-empty', 'r1')!.status).toBe('completed');

    const blockedHost = new MockHost();
    saveTaskSpec(root, specOf({
      id: 'invalid-policy',
      title: 'Invalid policy',
      goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const blockedRunner = new TaskRunner({
      host: blockedHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      defaultRetry: { limit: 2, when: ['error', 'empty', 'invalid'] },
      executionGuard: () => ({ allowed: false, reason: 'permission denied' }),
    });
    blockedRunner.run('invalid-policy', { runId: 'r1' });
    await tick();
    expect(blockedHost.created).toHaveLength(0);
    expect(blockedRunner.getRunState('invalid-policy', 'r1')!.status).toBe('failed');
  });

  it('feeds the prior failure into the retried prompt and can then succeed', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rtok', title: 'RtOk', goal: 'g', nodes: [{ id: 'a', prompt: 'do a', retry: { limit: 2 } }] }),
    );
    const runner = makeRunner();
    runner.run('rtok', { runId: 'r1' });
    await tick();

    host.complete('a', { reason: 'timeout' });
    await tick();
    const retryPrompt = host.sent.filter((s) => s.sessionId === 'sess-a')[1]!.message;
    expect(retryPrompt).toContain('Previous attempt failed: timeout');
    expect(retryPrompt).toContain('do a');

    host.complete('a', { finalText: 'OK' });
    await tick();
    expect(runner.getRunState('rtok', 'r1')!.status).toBe('completed');
  });

  it('does not retry on error when retry.when targets a different failure class', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rtw', title: 'RtW', goal: 'g', nodes: [{ id: 'a', prompt: 'a', retry: { limit: 3, when: 'empty' } }] }),
    );
    const runner = makeRunner();
    runner.run('rtw', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    expect(runner.getRunState('rtw', 'r1')!.status).toBe('failed');
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
  });

  it('completes without verifying when there is no orchestrator', async () => {
    saveTaskSpec(root, specOf({ id: 'nov', title: 'NoV', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('nov', { runId: 'r1' }); // no orchestratorSessionId → nothing to verify against
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('nov', 'r1')!.status).toBe('completed');
    expect(readRunLog(root, 'nov', 'r1').some((e) => e.kind === 'run-verifying')).toBe(false);
  });
});
