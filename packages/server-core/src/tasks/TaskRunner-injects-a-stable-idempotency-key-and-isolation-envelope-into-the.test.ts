import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer, operationValueHash, type SignedExecutionProof } from "@craft-agent/shared/governance";
import { saveTaskSpec, readRunLog } from "@craft-agent/shared/tasks";
import { TaskRunner } from "./TaskRunner";
import type { SubagentAutonomyContext } from "../subagents/autonomy-inheritance.ts";
import { MockHost, inactiveKillSwitch, specOf, tick, tu } from "./testing/TaskRunner-fixture.ts";

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

  it('injects a stable idempotency key and isolation envelope into the child prompt', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'guarded',
        title: 'Guarded',
        goal: 'g',
        execution: {
          root_path: root,
          allowed_write_paths: ['artifacts'],
          network_access: 'allow-list',
          allowed_hosts: ['api.example.com'],
          timeout_ms: 60_000,
        },
        nodes: [{ id: 'publish', prompt: 'Publish once' }],
      }),
    );
    const runner = makeRunner();
    runner.run('guarded', { runId: 'r1' });
    await tick();

    const prompt = host.promptFor('publish') ?? '';
    expect(prompt).toContain('Idempotency key: ws:guarded:r1:publish');
    expect(prompt).toContain('Write paths: (none)');
    expect(prompt).toContain('Network: allow-list (api.example.com)');
    const created = host.created.find((entry) => entry.options.name === 'publish')?.options;
    expect(created?.executionIsolation).toMatchObject({
      effect: 'read',
      policy: { allowedWritePaths: [] },
    });
    expect(readRunLog(root, 'guarded', 'r1').some((entry) => entry.kind === 'node-checkpoint' && entry.status === 'executing')).toBe(true);
  });

  it('persists write paths only for nodes that declare workspace-write', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'workspace-writer',
        title: 'Workspace writer',
        goal: 'g',
        execution: { root_path: root, allowed_write_paths: ['artifacts'] },
        nodes: [{ id: 'report', prompt: 'Write report', effect: 'workspace-write', permissionMode: 'allow-all' }],
      }),
    );
    const runner = makeRunner();
    runner.run('workspace-writer', { runId: 'r1' });
    await tick();

    const created = host.created.find((entry) => entry.options.name === 'report')?.options;
    expect(created?.executionIsolation).toMatchObject({
      effect: 'workspace-write',
      policy: { allowedWritePaths: ['artifacts'] },
    });
    expect(host.promptFor('report')).toContain('Write paths: artifacts');
  });

  it('rejects a task working directory outside the workspace', () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'escape',
        title: 'Escape',
        goal: 'g',
        cwd: join(root, '..'),
        execution: { root_path: root },
        nodes: [{ id: 'a', prompt: 'a' }],
      }),
    );
    expect(() => makeRunner().run('escape', { runId: 'r1' })).toThrow('Path escapes the workspace root');
  });

  it('rejects an isolation root outside the host workspace even without a task cwd', () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'root-escape',
        title: 'Root escape',
        goal: 'g',
        execution: { root_path: join(root, '..') },
        nodes: [{ id: 'a', prompt: 'a' }],
      }),
    );
    expect(() => makeRunner().run('root-escape', { runId: 'r1' })).toThrow('Isolation root rejected');
    expect(host.created).toHaveLength(0);
  });

  it('blocks a mission before dispatch when its kill switch is active', () => {
    saveTaskSpec(root, specOf({ id: 'stopped', title: 'Stopped', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: () => ({ global: false, workspaceIds: [], missionIds: ['stopped'] }),
    });
    expect(() => runner.run('stopped', { runId: 'r1' })).toThrow('Mission kill switch is active');
    expect(host.created).toHaveLength(0);
  });

  it('fails closed before dispatch when kill-switch state is unavailable', () => {
    saveTaskSpec(root, specOf({ id: 'switch-unavailable', title: 'Switch unavailable', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: () => {
        throw new Error('registry offline');
      },
    });
    expect(() => runner.run('switch-unavailable', { runId: 'r1' })).toThrow('kill-switch state is unavailable');
    expect(host.created).toHaveLength(0);
  });

  it('drains an in-flight mission immediately when a kill switch is activated', async () => {
    saveTaskSpec(root, specOf({ id: 'live', title: 'Live', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    let missionStopped = false;
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: () => ({
        global: false,
        workspaceIds: [],
        missionIds: missionStopped ? ['live'] : [],
      }),
    });
    runner.run('live', { runId: 'r1', verifyOnComplete: false });
    await tick();

    expect(host.dispatchedNames()).toEqual(['a']);
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    host.cancelProcessingAndWait = async (sessionId) => {
      await retirementGate;
      await host.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };
    missionStopped = true;
    expect(runner.enforceKillSwitches()).toBe(1);
    expect(runner.getRunState('live', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'live', 'r1').some((entry) => entry.kind === 'kill-switch')).toBe(false);

    releaseRetirement();
    await runner.waitUntilSettled('live', 'r1');
    await tick();

    expect(runner.getRunState('live', 'r1')).toMatchObject({
      status: 'stopped', tokensUsed: 3,
      nodes: [{ id: 'a', state: 'cancelled' }],
    });
    expect(host.cancelled).toEqual(['sess-a']);
    expect(readRunLog(root, 'live', 'r1').some((entry) => entry.kind === 'kill-switch')).toBe(true);
    expect(runner.enforceKillSwitches()).toBe(0);
  });

  it('does not settle a kill-switched review until the reviewer is proven idle', async () => {
    saveTaskSpec(root, specOf({
      id: 'kill-reviewer', title: 'Kill reviewer', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    let missionStopped = false;
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: () => ({
        global: false,
        workspaceIds: [],
        missionIds: missionStopped ? ['kill-reviewer'] : [],
      }),
    });
    runner.run('kill-reviewer', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'candidate' });
    await tick();
    const reviewerId = host.reviewerSessionId();
    let releaseRetirement!: () => void;
    const gate = new Promise<void>(resolve => { releaseRetirement = resolve; });
    host.cancelProcessingAndWait = async sessionId => {
      expect(sessionId).toBe(reviewerId);
      await gate;
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };

    missionStopped = true;
    expect(runner.enforceKillSwitches()).toBe(1);
    // The outward status remains non-terminal until the strong retirement
    // barrier proves the reviewer idle.
    expect(runner.getRunState('kill-reviewer', 'r1')?.status).toBe('verifying');
    let settled = false;
    void runner.waitUntilSettled('kill-reviewer', 'r1').then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    releaseRetirement();
    expect((await runner.waitUntilSettled('kill-reviewer', 'r1'))).toMatchObject({
      status: 'stopped', tokensUsed: 3,
    });
  });

  it('hydrates and drains a crashed run when its kill switch became active offline', async () => {
    saveTaskSpec(root, specOf({
      id: 'restart-kill-switch', title: 'Restart kill switch', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const before = makeRunner();
    before.run('restart-kill-switch', { runId: 'r1', verifyOnComplete: false });
    await tick();

    const recoveredHost = new MockHost();
    recoveredHost.created.push({
      id: 'sess-a',
      options: {
        taskSlug: 'restart-kill-switch', taskRunId: 'r1', taskNodeId: 'a',
        name: 'a', sessionStatus: 'in-progress',
      },
    });
    let releaseRetirement!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    recoveredHost.cancelProcessingAndWait = async (sessionId) => {
      await gate;
      await recoveredHost.cancelProcessing(sessionId, true);
      return { sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(2, 1) };
    };
    const recovered = new TaskRunner({
      host: recoveredHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: () => ({
        global: false, workspaceIds: [], missionIds: ['restart-kill-switch'],
      }),
    });

    expect(recovered.recoverNonTerminalRuns()).toHaveLength(1);
    expect(recovered.getRunState('restart-kill-switch', 'r1')?.status).toBe('running');
    expect(readRunLog(root, 'restart-kill-switch', 'r1').some(
      (entry) => entry.kind === 'run-draining' && entry.cause === 'kill-switch',
    )).toBe(true);
    expect(readRunLog(root, 'restart-kill-switch', 'r1').some(
      (entry) => entry.kind === 'kill-switch',
    )).toBe(false);

    releaseRetirement();
    expect((await recovered.waitUntilSettled('restart-kill-switch', 'r1'))).toMatchObject({
      status: 'stopped', tokensUsed: 3,
    });
  });

  it('holds an external mutation in the approval inbox until a validator approves it', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'approve-mutation',
        title: 'Approve mutation',
        goal: 'Publish safely',
        mission: {
          deliverables: [{ name: 'publication' }],
          policy: {
            impact_level: 'high',
            require_high_impact_approval: true,
            replay_external_mutations: false,
            owner: 'alice',
            validator: 'bob',
          },
        },
        nodes: [{ id: 'publish', prompt: 'Publish now', effect: 'external-mutation', approval: true }],
      }),
    );
    const issuer = new ExecutionProofIssuer({
      signingKey: 'task-runner-execution-proof-key-32-bytes-minimum',
      now: () => '2026-06-07T00:00:01.000Z',
      generateId: () => 'proof-publish',
    });
    const runner = makeRunner(issuer);
    const started = runner.run('approve-mutation', { runId: 'r1', verifyOnComplete: false });
    await tick();

    expect(runner.getRunState('approve-mutation', started.runId)?.status).toBe('waiting-approval');
    expect(host.created).toHaveLength(0);
    const approval = runner.listPendingApprovals('approve-mutation', 'r1')[0];
    expect(approval).toMatchObject({
      slug: 'approve-mutation',
      nodeId: 'publish',
      impact: 'high',
      owner: 'bob',
    });

    runner.resolveApproval('approve-mutation', 'r1', approval!.requestId, 'approved', 'bob');
    await tick();
    expect(host.created).toHaveLength(1);
    host.complete('publish', {
      finalText: 'published',
      executionProof: issueTaskProof(issuer, 'approve-mutation', 'publish', 'ws:approve-mutation:r1:publish'),
    });
    await tick();
    expect(runner.getRunState('approve-mutation', 'r1')?.status).toBe('completed');
    expect(readRunLog(root, 'approve-mutation', 'r1')).toContainEqual(expect.objectContaining({
      kind: 'node-checkpoint',
      nodeId: 'publish',
      status: 'confirmed',
      executionProof: expect.objectContaining({ proofId: 'proof-publish' }),
    }));
  });

  it('never accepts model text as proof of an external mutation and does not retry ambiguously', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'mutation-without-proof',
        title: 'Mutation without proof',
        goal: 'Reject unverifiable completion',
        nodes: [{
          id: 'publish',
          prompt: 'Publish now',
          effect: 'external-mutation',
          retry: { limit: 3 },
        }],
      }),
    );
    const runner = makeRunner();
    runner.run('mutation-without-proof', { runId: 'r1', verifyOnComplete: false });
    await tick();

    host.complete('publish', { finalText: 'published successfully' });
    await tick();

    expect(runner.getRunState('mutation-without-proof', 'r1')?.status).toBe('failed');
    expect(host.created).toHaveLength(1);
    expect(readRunLog(root, 'mutation-without-proof', 'r1')).not.toContainEqual(expect.objectContaining({
      kind: 'node-checkpoint',
      nodeId: 'publish',
      status: 'confirmed',
    }));
    expect(readRunLog(root, 'mutation-without-proof', 'r1')).toContainEqual(expect.objectContaining({
      kind: 'node-finished',
      nodeId: 'publish',
      state: 'failed',
      reason: expect.stringContaining('without an authoritative provider-reconciled execution proof'),
    }));
  });
});
