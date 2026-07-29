import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TokenUsage } from '@craft-agent/core/types';
import type { CreateSessionOptions } from '@craft-agent/shared/protocol';
import {
  ExecutionProofIssuer,
  operationValueHash,
  type SignedExecutionProof,
} from '@craft-agent/shared/governance';
import {
  appendRunLog,
  parseTaskSpec,
  saveTaskSpec,
  readRunLog,
  readNodeOutput,
  writeRunSpecSnapshot,
  type TaskSpec,
} from '@craft-agent/shared/tasks';
import type { SessionCompletionEvent } from '../sessions/SessionManager';
import { TaskRunner, type ConductorSessionHost } from './TaskRunner';
import { inferTaskNodeProfile, type TaskNodeRouteContext } from './task-node-routing';

// Flush pending microtasks so the runner's async dispatch (create → column → send) settles.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const inactiveKillSwitch = () => ({ global: false, workspaceIds: [], missionIds: [] });

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function tu(inputTokens: number, outputTokens: number, costUsd = 0): TokenUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, contextTokens: 0, costUsd };
}

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw);
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues));
  return r.data;
}

/** Mock host: records calls; the test drives completions via complete(). */
class MockHost implements ConductorSessionHost {
  // A Set, mirroring SessionManager — the Conductor keeps its main subscription AND a one-shot
  // verdict listener attached at the same time while a run is `verifying`.
  private readonly listeners = new Set<(evt: SessionCompletionEvent) => void>();
  readonly created: { id: string; options: CreateSessionOptions }[] = [];
  readonly sent: { sessionId: string; message: string }[] = [];
  readonly statuses: { sessionId: string; status: string }[] = [];
  readonly columns: { sessionId: string; column: string | null }[] = [];
  readonly nodeCounts: { sessionId: string; count: number }[] = [];
  readonly cancelled: string[] = [];
  readonly finalTextById = new Map<string, string>();

  async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    const id = `sess-${options.name}`;
    this.created.push({ id, options });
    return { id };
  }
  async sendMessage(sessionId: string, message: string): Promise<void> {
    this.sent.push({ sessionId, message });
  }
  async setSessionStatus(sessionId: string, status: string): Promise<void> {
    this.statuses.push({ sessionId, status });
  }
  async setKanbanColumn(sessionId: string, column: string | null): Promise<void> {
    this.columns.push({ sessionId, column });
  }
  async setTaskNodeCount(sessionId: string, count: number): Promise<void> {
    this.nodeCounts.push({ sessionId, count });
  }
  async cancelProcessing(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
  }
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  getSessionFinalText(sessionId: string): string | undefined {
    return this.finalTextById.get(sessionId);
  }
  workingDirById = new Map<string, string>();
  getSessionWorkingDirectory(sessionId: string): string | undefined {
    return this.workingDirById.get(sessionId);
  }

  // --- test helpers (sessionId is derived from the node title, which defaults to the node id) ---
  sessionIdFor(nodeId: string): string {
    return `sess-${nodeId}`;
  }
  promptFor(nodeId: string): string | undefined {
    return this.sent.find((s) => s.sessionId === this.sessionIdFor(nodeId))?.message;
  }
  dispatchedNames(): string[] {
    return this.created.map((c) => c.options.name!).filter(Boolean);
  }
  complete(nodeId: string, opts: {
    reason?: SessionCompletionEvent['reason'];
    finalText?: string;
    tokenUsage?: TokenUsage;
    executionProof?: SignedExecutionProof;
  } = {}): void {
    this.completeSession(this.sessionIdFor(nodeId), opts);
  }
  /** Fire a completion for an arbitrary session id (e.g. the orchestrator's verification verdict). */
  completeSession(sessionId: string, opts: {
    reason?: SessionCompletionEvent['reason'];
    finalText?: string;
    tokenUsage?: TokenUsage;
    executionProof?: SignedExecutionProof;
  } = {}): void {
    const evt: SessionCompletionEvent = {
      sessionId,
      workspaceId: 'ws',
      reason: opts.reason ?? 'complete',
      finalText: opts.finalText,
      tokenUsage: opts.tokenUsage,
      executionProof: opts.executionProof,
    };
    for (const listener of [...this.listeners]) listener(evt);
  }
}

class UniqueSessionHost extends MockHost {
  private sequence = 0;

  override async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    this.sequence += 1;
    const id = `sess-${options.name}-${this.sequence}`;
    this.created.push({ id, options });
    return { id };
  }
}

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

  function makeRunner(executionProofIssuer?: ExecutionProofIssuer) {
    return new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      now: () => '2026-06-07T00:00:00.000Z',
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

  it('runs a dependency chain, feeding each output into the next', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'demo',
        title: 'Demo',
        goal: 'audit then design then implement',
        nodes: [
          { id: 'audit', prompt: 'Audit the code' },
          { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
          { id: 'impl', depends_on: ['design'], prompt: 'Implement ${nodes.design.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('demo', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();

    expect(host.dispatchedNames()).toEqual(['audit']);
    expect(host.promptFor('audit')?.endsWith('Audit the code')).toBe(true);

    host.complete('audit', { finalText: 'AUDIT', tokenUsage: tu(10, 5) });
    await tick();
    expect(host.dispatchedNames()).toEqual(['audit', 'design']);
    expect(host.promptFor('design')?.endsWith('Design using AUDIT')).toBe(true);

    host.complete('design', { finalText: 'DESIGN', tokenUsage: tu(20, 10) });
    await tick();
    expect(host.promptFor('impl')?.endsWith('Implement DESIGN')).toBe(true);

    host.complete('impl', { finalText: 'IMPL', tokenUsage: tu(5, 5) });
    await tick();

    // All nodes done → the run is verifying (not yet terminal) until the orchestrator returns a verdict.
    expect(runner.getRunState('demo', 'r1')!.status).toBe('verifying');
    expect(host.sent.some((s) => s.sessionId === 'orch' && s.message.includes('finished running'))).toBe(true);

    host.completeSession('orch', { finalText: 'Looks correct.\nVERDICT: PASS' });
    await tick();

    const snap = runner.getRunState('demo', 'r1')!;
    expect(snap.status).toBe('completed');
    expect(snap.nodes.every((n) => n.state === 'done')).toBe(true);
    expect(snap.tokensUsed).toBe(55);

    // Run-log + node output persisted.
    const log = readRunLog(root, 'demo', 'r1');
    expect(log[0]).toMatchObject({ kind: 'run-started' });
    expect(log.some((e) => e.kind === 'run-completed')).toBe(true);
    expect(readNodeOutput(root, 'demo', 'r1', 'audit')).toEqual({ text: 'AUDIT' });
  });

  it('passes llmConnection (node value, else the task default) to createSession', async () => {
    // Regression: pi/* models complete instantly with empty output unless the child session is
    // created with the connection slug that serves the model.
    saveTaskSpec(
      root,
      specOf({
        id: 'conn',
        title: 'Conn',
        goal: 'g',
        defaults: { llmConnection: 'default-conn' },
        nodes: [
          { id: 'a', prompt: 'a', model: 'pi/gpt-5.6-sol', llmConnection: 'pi-conn' },
          { id: 'b', prompt: 'b', model: 'claude-opus-4-8' }, // inherits the task default
        ],
      }),
    )
    const runner = makeRunner()
    runner.run('conn', { runId: 'r1' })
    await tick()

    const optsA = host.created.find((c) => c.options.name === 'a')?.options
    const optsB = host.created.find((c) => c.options.name === 'b')?.options
    expect(optsA?.llmConnection).toBe('pi-conn')
    expect(optsB?.llmConnection).toBe('default-conn')
  })

  it('resolves permissionMode: node override → task default → child (never the workspace default)', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'perm',
        title: 'Perm',
        goal: 'g',
        defaults: { permissionMode: 'ask' },
        nodes: [
          { id: 'a', prompt: 'a', permissionMode: 'safe' }, // node override wins
          { id: 'b', prompt: 'b' }, // inherits the task default
        ],
      }),
    )
    const runner = makeRunner()
    runner.run('perm', { runId: 'r1' })
    await tick()

    expect(host.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('safe')
    expect(host.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('ask')
  })

  it('defaults an omitted permission mode to safe for fail-closed autonomy', async () => {
    // A hand-authored spec must opt in explicitly before an unattended child can mutate state.
    saveTaskSpec(
      root,
      specOf({ id: 'perm2', title: 'Perm2', goal: 'g', nodes: [{ id: 'c', prompt: 'c' }] }),
    )
    const runner = makeRunner()
    runner.run('perm2', { runId: 'r1' })
    await tick()

    expect(host.created.find((c) => c.options.name === 'c')?.options.permissionMode).toBe('safe')
  })

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
    missionStopped = true;
    expect(runner.enforceKillSwitches()).toBe(1);
    await tick();

    expect(runner.getRunState('live', 'r1')).toMatchObject({
      status: 'stopped',
      nodes: [{ id: 'a', state: 'cancelled' }],
    });
    expect(host.cancelled).toEqual(['sess-a']);
    expect(readRunLog(root, 'live', 'r1').some((entry) => entry.kind === 'kill-switch')).toBe(true);
    expect(runner.enforceKillSwitches()).toBe(0);
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
    expect(approval).toMatchObject({ nodeId: 'publish', impact: 'high', owner: 'bob' });

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
    host2.completeSession('orch', { finalText: 'VERDICT: PASS' });
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
    const runner = new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch });
    runner.run('backoff', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();

    expect(host.created.filter((entry) => entry.options.name === 'a')).toHaveLength(1);
    const retry = readRunLog(root, 'backoff', 'r1').find((entry) => entry.kind === 'node-retry');
    expect(retry).toMatchObject({ kind: 'node-retry', delayMs: 30 });

    await new Promise<void>((resolve) => setTimeout(resolve, 40));
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
    const first = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      resolveNodeRoute: (context) => ({
        profile: inferTaskNodeProfile(context.node, context.attempt),
        llmConnection: 'primary',
        model: 'primary-model',
        thinkingLevel: 'low',
        strategy: 'primary',
      }),
    });
    first.run('backoff-restart', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    first.pause('backoff-restart', 'r1');

    const recoveredHost = new MockHost();
    const recoveredPreviousRoutes: Array<TaskNodeRouteContext['previousRoute']> = [];
    const recovered = new TaskRunner({
      host: recoveredHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      resolveNodeRoute: (context) => {
        recoveredPreviousRoutes.push(context.previousRoute);
        return {
          profile: inferTaskNodeProfile(context.node, context.attempt),
          llmConnection: 'secondary',
          model: 'fallback-model',
          thinkingLevel: 'high',
          strategy: 'retry-fallback',
        };
      },
    });
    recovered.resume('backoff-restart', 'r1');
    await tick();
    expect(recoveredHost.created).toHaveLength(0);

    await new Promise<void>((resolve) => setTimeout(resolve, 340));
    expect(recoveredHost.dispatchedNames()).toEqual(['a']);
    expect(recoveredPreviousRoutes).toEqual([{ llmConnection: 'primary', model: 'primary-model' }]);
    expect(readRunLog(root, 'backoff-restart', 'r1').filter((entry) => entry.kind === 'node-routed').at(-1))
      .toMatchObject({ connectionSlug: 'secondary', model: 'fallback-model', strategy: 'retry-fallback' });
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
    const deadline = new Date(Date.now() + 200).toISOString();
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
    const runner = makeRunner();
    runner.run('deadline-crossing', { runId: 'r1', verifyOnComplete: false });
    await tick();
    expect(host.dispatchedNames()).toEqual(['slow']);

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(host.cancelled).toContain('sess-slow');
    expect(runner.getRunState('deadline-crossing', 'r1')?.status).toBe('failed');
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
  }, 60_000);

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

  it('persists the selected route and passes it to the next retry attempt', async () => {
    saveTaskSpec(root, specOf({ id: 'route-retry', title: 'Route retry', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const previousRoutes: Array<TaskNodeRouteContext['previousRoute']> = [];
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      defaultRetry: { limit: 1, when: 'error' },
      resolveNodeRoute: (context) => {
        previousRoutes.push(context.previousRoute);
        const useFallback = context.attempt > 1;
        return {
          profile: inferTaskNodeProfile(context.node, context.attempt),
          llmConnection: useFallback ? 'secondary' : 'primary',
          model: useFallback ? 'fallback-model' : 'primary-model',
          thinkingLevel: useFallback ? 'high' : 'low',
          strategy: useFallback ? 'retry-fallback' : 'primary',
        };
      },
    });
    runner.run('route-retry', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();

    expect(previousRoutes).toEqual([
      undefined,
      { llmConnection: 'primary', model: 'primary-model' },
    ]);
    expect(readRunLog(root, 'route-retry', 'r1').filter((entry) => entry.kind === 'node-routed'))
      .toEqual([
        expect.objectContaining({ connectionSlug: 'primary', strategy: 'primary' }),
        expect.objectContaining({ connectionSlug: 'secondary', strategy: 'retry-fallback' }),
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

  it('gates the run on the orchestrator verdict and includes acceptance_criteria in the prompt', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'vp', title: 'Vp', goal: 'g', acceptance_criteria: 'must be perfect', nodes: [{ id: 'a', prompt: 'do a' }] }),
    );
    const runner = makeRunner();
    runner.run('vp', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('vp', 'r1')!.status).toBe('verifying');
    const vmsg = host.sent.find((s) => s.sessionId === 'orch')!.message;
    expect(vmsg).toContain('must be perfect');
    expect(vmsg).toContain('VERDICT: PASS');

    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(runner.getRunState('vp', 'r1')!.status).toBe('completed');
  });

  it('re-runs the terminal node once on a FAIL verdict, then completes on PASS', async () => {
    saveTaskSpec(root, specOf({ id: 'vf', title: 'Vf', goal: 'g', nodes: [{ id: 'a', prompt: 'do a' }] }));
    const runner = makeRunner();
    runner.run('vf', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'first' });
    await tick();

    host.completeSession('orch', { finalText: 'Not good enough.\nVERDICT: FAIL — missing X' });
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
    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(runner.getRunState('vf', 'r1')!.status).toBe('completed');
  });

  it('fails the run when FAIL verdicts exhaust the repair budget (max_iterations)', async () => {
    // max_iterations: 1 → one repair allowed; the second FAIL breaches the iteration budget.
    saveTaskSpec(root, specOf({ id: 'vff', title: 'Vff', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'do a' }] }));
    const runner = makeRunner();
    runner.run('vff', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — nope' });
    await tick();
    expect(runner.getRunState('vff', 'r1')!.status).toBe('running'); // first repair in flight

    host.complete('a', { finalText: 'y' });
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — still nope' });
    await tick();
    expect(runner.getRunState('vff', 'r1')!.status).toBe('failed');
    const log = readRunLog(root, 'vff', 'r1');
    expect(log.filter((e) => e.kind === 'verdict').length).toBe(2);
    expect(log.some((e) => e.kind === 'budget-breach' && (e as { metric?: string }).metric === 'iterations')).toBe(true);
    expect(log.some((e) => e.kind === 'run-failed')).toBe(true);
  });

  it('re-asks on an unparsable verdict and fails only after the re-ask budget is exhausted', async () => {
    saveTaskSpec(root, specOf({ id: 'unp', title: 'Unp', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('unp', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();

    // First malformed reply → re-asked, run stays verifying (not terminal).
    host.completeSession('orch', { finalText: 'I think it is fine but forgot the verdict line.' });
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('verifying');
    expect(host.sent.filter((s) => s.sessionId === 'orch' && s.message.includes('did not include a parseable verdict')).length).toBe(1);

    // Second malformed reply → re-asked again (MAX_UNPARSED_REASKS = 2).
    host.completeSession('orch', { finalText: 'still no verdict line, sorry' });
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('verifying');

    // Third malformed reply → budget exhausted → failed.
    host.completeSession('orch', { finalText: 'nope, no verdict again' });
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

    host.completeSession('orch', { finalText: 'VERDICT: FAIL — nodes=b — b is wrong' });
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

    host.completeSession('orch', { finalText: 'no verdict here' }); // unparsed → re-ask
    await tick();
    expect(runner.getRunState('unb', 'r1')!.status).toBe('verifying');

    host.completeSession('orch', { finalText: 'VERDICT: FAIL — fix it' }); // first real FAIL → repair still allowed
    await tick();
    expect(runner.getRunState('unb', 'r1')!.status).toBe('running');
  });

  it('does not hang in verifying when the verification send rejects', async () => {
    saveTaskSpec(root, specOf({ id: 'snd', title: 'Snd', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('snd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    // Make the orchestrator verification send reject (the verdict can never arrive).
    const origSend = host.sendMessage.bind(host);
    host.sendMessage = async (sessionId: string, message: string) => {
      if (sessionId === 'orch') throw new Error('send boom');
      return origSend(sessionId, message);
    };
    host.complete('a', { finalText: 'x' });
    await tick();
    await tick();
    expect(runner.getRunState('snd', 'r1')!.status).toBe('failed');
  });

  it('ignores a verdict that arrives after the run was stopped', async () => {
    saveTaskSpec(root, specOf({ id: 'late', title: 'Late', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('late', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('late', 'r1')!.status).toBe('verifying');

    await runner.stop('late', 'r1');
    expect(runner.getRunState('late', 'r1')!.status).toBe('stopped');

    // A late verdict for the (now stopped) run must not flip it back to completed/failed.
    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
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
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — redo' }); // consumes the one repair
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
    host2.completeSession('orch', { finalText: 'VERDICT: FAIL — still bad' });
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
