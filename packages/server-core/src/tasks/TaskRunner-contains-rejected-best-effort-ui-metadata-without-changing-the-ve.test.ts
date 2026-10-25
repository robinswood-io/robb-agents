import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { saveTaskSpec, readRunLog } from "@craft-agent/shared/tasks";
import { TaskRunner } from "./TaskRunner";
import type { SubagentAutonomyContext } from "../subagents/autonomy-inheritance.ts";
import { MockHost, inactiveKillSwitch, specOf, tick } from "./testing/TaskRunner-fixture.ts";

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

  it('contains rejected best-effort UI metadata without changing the verdict or leaking an unhandled rejection', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'metadata-rejections',
        title: 'Metadata rejections',
        goal: 'complete despite unavailable board metadata',
        nodes: [{ id: 'work', prompt: 'work' }],
      }),
    );

    const setSessionStatus = host.setSessionStatus.bind(host);
    host.setTaskNodeCount = async () => {
      throw new Error('node-count metadata unavailable');
    };
    host.setSessionStatus = async (sessionId, status) => {
      if (sessionId === 'orch' || status === 'done') {
        throw new Error(`status metadata unavailable for ${sessionId}`);
      }
      await setSessionStatus(sessionId, status);
    };
    const setKanbanColumn = host.setKanbanColumn.bind(host);
    host.setKanbanColumn = async (sessionId, column) => {
      if (sessionId === 'orch' || column === 'done') {
        throw new Error(`column metadata unavailable for ${sessionId}`);
      }
      await setKanbanColumn(sessionId, column);
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const runner = makeRunner();
      runner.run('metadata-rejections', { runId: 'r1', orchestratorSessionId: 'orch' });
      await tick();

      host.complete('work', { finalText: 'candidate' });
      await tick();
      host.completeReview('pass');
      await tick();
      await tick();

      expect(runner.getRunState('metadata-rejections', 'r1')?.status).toBe('completed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('starts a targeted repair as a new run and reuses confirmed upstream evidence', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'targeted-repair',
        title: 'Targeted repair',
        goal: 'g',
        nodes: [
          { id: 'collect', prompt: 'collect' },
          { id: 'publish', depends_on: ['collect'], prompt: 'publish ${nodes.collect.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('targeted-repair', { runId: 'source' });
    await tick();
    host.complete('collect', { finalText: 'CONFIRMED INPUT' });
    await tick();
    host.complete('publish', { finalText: 'OLD RESULT' });
    await tick();
    expect(runner.getRunState('targeted-repair', 'source')?.status).toBe('completed');

    const repair = runner.repair('targeted-repair', 'source', ['publish'], { runId: 'repair-1' });
    await tick();

    expect(repair.runId).toBe('repair-1');
    expect(host.dispatchedNames()).toEqual(['collect', 'publish', 'publish']);
    const repairedPrompt = host.sent.filter((entry) => entry.sessionId === 'sess-publish').at(-1)?.message;
    expect(repairedPrompt).toContain('publish CONFIRMED INPUT');
    const repairLog = readRunLog(root, 'targeted-repair', 'repair-1');
    expect(repairLog).toContainEqual(expect.objectContaining({ kind: 'run-replayed', sourceRunId: 'source' }));
    expect(repairLog).toContainEqual(expect.objectContaining({ kind: 'node-reused', nodeId: 'collect' }));
  });

  it('refuses a targeted repair while the source run is still active', async () => {
    saveTaskSpec(root, specOf({
      id: 'active-repair',
      title: 'Active repair',
      goal: 'g',
      nodes: [{ id: 'work', prompt: 'work' }],
    }));
    const runner = makeRunner();
    runner.run('active-repair', { runId: 'source' });
    await tick();

    expect(() => runner.repair('active-repair', 'source', ['work'], { runId: 'repair' }))
      .toThrow('Cannot repair non-terminal run');
    expect(runner.getRunState('active-repair', 'repair')).toBeNull();
  });

  it('refuses to append a targeted repair into the immutable source run', async () => {
    saveTaskSpec(root, specOf({
      id: 'immutable-repair',
      title: 'Immutable repair',
      goal: 'g',
      nodes: [{ id: 'work', prompt: 'work' }],
    }));
    const runner = makeRunner();
    runner.run('immutable-repair', { runId: 'source' });
    await tick();
    host.complete('work', { finalText: 'done' });
    await tick();

    expect(() => runner.repair('immutable-repair', 'source', ['work'], { runId: 'source' }))
      .toThrow('must create a new immutable run');
  });
});
