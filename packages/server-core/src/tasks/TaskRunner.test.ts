import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Buffer } from 'node:buffer';
import type { StoredAttachment, TokenUsage } from '@craft-agent/core/types';
import type {
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
} from '@craft-agent/shared/protocol';
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
  writeNodeOutput,
  writeRunSpecSnapshot,
  type TaskSpec,
} from '@craft-agent/shared/tasks';
import type { SessionCompletionEvent } from '../sessions/SessionManager';
import { createManagedSession, SessionManager } from '../sessions/SessionManager';
import { getDelegatedReviewRequest } from '../sessions/delegated-review-outcome.ts';
import { registerObjectiveAcceptanceCriteria } from '../sessions/objective-acceptance-criteria.ts';
import { createPendingTurnRecovery } from '../sessions/turn-recovery.ts';
import { TaskRunner, type ConductorSessionHost, type TaskExecutionGuardContext } from './TaskRunner';
import type { SubagentAutonomyContext } from '../subagents/autonomy-inheritance.ts';

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
  // independent-reviewer listener attached at the same time while a run is `verifying`.
  private readonly listeners = new Set<(evt: SessionCompletionEvent) => void>();
  readonly created: { id: string; options: CreateSessionOptions }[] = [];
  readonly sent: { sessionId: string; message: string; options?: SendMessageOptions }[] = [];
  readonly statuses: { sessionId: string; status: string }[] = [];
  readonly statusById = new Map<string, string>();
  readonly columns: { sessionId: string; column: string | null }[] = [];
  readonly nodeCounts: { sessionId: string; count: number }[] = [];
  readonly cancelled: string[] = [];
  readonly finalTextById = new Map<string, string>();
  readonly processing = new Set<string>();
  readonly tokenUsageById = new Map<string, TokenUsage>();

  async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    const id = `sess-${options.name}`;
    this.created.push({ id, options });
    return { id };
  }
  async sendMessage(
    sessionId: string,
    message: string,
    _attachments?: FileAttachment[],
    _storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
  ): Promise<void> {
    this.sent.push({ sessionId, message, options });
    this.processing.add(sessionId);
  }
  async setSessionStatus(sessionId: string, status: string): Promise<void> {
    this.statuses.push({ sessionId, status });
    this.statusById.set(sessionId, status);
  }
  async setKanbanColumn(sessionId: string, column: string | null): Promise<void> {
    this.columns.push({ sessionId, column });
  }
  async setTaskNodeCount(sessionId: string, count: number): Promise<void> {
    this.nodeCounts.push({ sessionId, count });
  }
  async cancelProcessing(sessionId: string, _silent?: boolean): Promise<void> {
    this.cancelled.push(sessionId);
    this.processing.delete(sessionId);
  }
  async cancelProcessingAndWait(sessionId: string): Promise<SessionCompletionEvent> {
    await this.cancelProcessing(sessionId, true);
    return {
      sessionId,
      workspaceId: 'ws',
      reason: 'interrupted',
      finalText: this.finalTextById.get(sessionId),
      tokenUsage: this.tokenUsageById.get(sessionId),
    };
  }
  listTaskReviewerSessions(
    _workspaceId: string,
    taskSlug: string,
    taskRunId: string,
    parentSessionId: string,
  ) {
    return this.created
      .filter(entry => entry.options.taskSlug === taskSlug
        && entry.options.taskRunId === taskRunId
        && entry.options.taskNodeId === '__verdict__'
        && entry.options.missionRole === 'reviewer'
        && entry.options.parentSessionId === parentSessionId
        && (this.statusById.get(entry.id) ?? entry.options.sessionStatus) === 'in-progress')
      .map(entry => ({
        id: entry.id,
        isProcessing: this.processing.has(entry.id),
        tokenUsage: this.tokenUsageById.get(entry.id),
        finalText: this.finalTextById.get(entry.id),
      }));
  }
  listTaskWorkerSessions(_workspaceId: string, taskSlug: string, taskRunId: string) {
    return this.created
      .filter(entry => entry.options.taskSlug === taskSlug
        && entry.options.taskRunId === taskRunId
        && !!entry.options.taskNodeId
        && entry.options.taskNodeId !== '__verdict__'
        && ((this.statusById.get(entry.id) ?? entry.options.sessionStatus) === 'in-progress'
          || this.processing.has(entry.id)))
      .map(entry => ({
        id: entry.id,
        isProcessing: this.processing.has(entry.id),
        tokenUsage: this.tokenUsageById.get(entry.id),
        finalText: this.finalTextById.get(entry.id),
      }));
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
  reviewerSessionId(): string {
    const reviewer = this.created
      .filter((entry) => entry.options.taskRunId && entry.options.missionRole === 'reviewer'
        && entry.options.taskNodeId === '__verdict__')
      .at(-1);
    if (!reviewer) throw new Error('reviewer session was not created');
    return reviewer.id;
  }
  completeReview(
    result: 'pass' | 'fail',
    reason = result === 'pass' ? 'Acceptance criteria verified.' : 'Acceptance criteria not met.',
    nodes: string[] = [],
    tokenUsage?: TokenUsage,
  ): void {
    const reviewerSessionId = this.reviewerSessionId();
    const prompt = this.sent
      .filter(entry => entry.sessionId === reviewerSessionId)
      .map(entry => entry.message)
      .filter(message => message.includes('<host_parent_review_contract>'))
      .at(-1);
    const contractText = prompt?.match(
      /<host_parent_review_contract>([^<]+)<\/host_parent_review_contract>/,
    )?.[1];
    if (!contractText) throw new Error('reviewer host contract was not sent');
    const contract = JSON.parse(contractText) as {
      objectiveId: string;
      acceptanceSha256: string;
      criteria: string[];
    };
    const encodedContext = prompt?.match(
      /<host_parent_review_context_base64url>([^<]+)<\/host_parent_review_context_base64url>/,
    )?.[1];
    const reviewContext = encodedContext
      ? Buffer.from(encodedContext, 'base64url').toString('utf8')
      : '';
    const mappingText = reviewContext.match(/The receipt criterion mapping is (\[[^\n]+\])\./)?.[1];
    const mapping = mappingText
      ? JSON.parse(mappingText) as Array<{ criterionId: string; nodeId: string }>
      : [];
    const failedNodeCriteria = new Set(mapping
      .filter(entry => nodes.includes(entry.nodeId))
      .map(entry => entry.criterionId));
    const criteria = contract.criteria.map(id => ({
      id,
      passed: result === 'pass'
        || (nodes.length > 0 ? !failedNodeCriteria.has(id) : id !== 'task-outcome'),
    }));
    this.completeSession(this.reviewerSessionId(), {
      finalText: JSON.stringify({
        objectiveId: contract.objectiveId,
        acceptanceSha256: contract.acceptanceSha256,
        verdict: result === 'pass' ? 'PASS' : 'FAIL',
        criteria,
        findings: result === 'pass' ? [] : [reason],
      }),
      tokenUsage,
    });
  }
  completeRawReview(finalText: string): void {
    this.completeSession(this.reviewerSessionId(), { finalText });
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
    this.processing.delete(sessionId);
    if (opts.finalText !== undefined) this.finalTextById.set(sessionId, opts.finalText);
    if (opts.tokenUsage) this.tokenUsageById.set(sessionId, opts.tokenUsage);
    const evt: SessionCompletionEvent = {
      sessionId,
      workspaceId: 'ws',
      reason: opts.reason ?? 'complete',
      finalText: opts.finalText,
      tokenUsage: opts.tokenUsage,
      executionProof: opts.executionProof,
    };
    // SessionManager iterates its listener Set live. Tests deliberately mirror
    // that behavior so a listener added by a callback cannot consume the same
    // completion event as a second generation.
    for (const listener of this.listeners) listener(evt);
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

class PrefixedSessionHost extends MockHost {
  private sequence = 0;

  constructor(private readonly prefix: string) {
    super();
  }

  override async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    this.sequence += 1;
    const id = `${this.prefix}-${options.name}-${this.sequence}`;
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
    expect(host.sent.find(entry => entry.message.endsWith('Audit the code'))?.options)
      .toMatchObject({ internalOrigin: {
        kind: 'spawned-session', senderSessionId: 'orch', authenticatedTaskText: 'Audit the code',
      } });

    host.complete('audit', { finalText: 'AUDIT', tokenUsage: tu(10, 5) });
    await tick();
    expect(host.dispatchedNames()).toEqual(['audit', 'design']);
    expect(host.promptFor('design')?.endsWith('Design using AUDIT')).toBe(true);

    host.complete('design', { finalText: 'DESIGN', tokenUsage: tu(20, 10) });
    await tick();
    expect(host.promptFor('impl')?.endsWith('Implement DESIGN')).toBe(true);

    host.complete('impl', { finalText: 'IMPL', tokenUsage: tu(5, 5) });
    await tick();

    // All nodes done → the run is verifying until the independent reviewer returns a verdict.
    expect(runner.getRunState('demo', 'r1')!.status).toBe('verifying');
    expect(host.sent.some((s) => s.sessionId === host.reviewerSessionId()
      && s.message.includes('<host_parent_review_contract>'))).toBe(true);

    host.completeReview('pass');
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

  it('routes the resolved prompt and does not turn an automatic route into durable pins', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'resolved-routing',
        title: 'Resolved routing',
        goal: 'Route the effective work',
        params: [{ name: 'plan' }],
        nodes: [{ id: 'apply', prompt: 'Apply ${params.plan}' }],
      }),
    );
    let classifiedPrompt = '';
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      resolveSubagentAutonomyContext: () => ({
        workspacePermissionMode: 'allow-all',
        externalActionPolicy: 'confirm',
      }),
      resolveNodeRoute: (context) => {
        classifiedPrompt = context.node.prompt ?? '';
        return {
          profile: {
            specialty: 'security',
            difficulty: 'complex',
            modelTier: 'best',
            thinkingLevel: 'xhigh',
            highRisk: true,
          },
          model: 'pi/gpt-6-astra',
          llmConnection: 'primary',
          thinkingLevel: 'xhigh',
          strategy: 'primary',
        };
      },
    });

    runner.run('resolved-routing', {
      runId: 'r1',
      orchestratorSessionId: 'orch',
      params: { plan: 'Delete the production database.' },
    });
    await tick();

    expect(classifiedPrompt).toBe('Apply Delete the production database.');
    expect(host.sent[0]?.options?.internalOrigin?.authenticatedTaskText)
      .toBe('Apply Delete the production database.');
    expect(host.created[0]?.options).toMatchObject({
      model: 'pi/gpt-6-astra',
      llmConnection: 'primary',
      thinkingLevel: 'xhigh',
      modelRoutePinned: false,
      connectionRoutePinned: false,
      thinkingLevelPinned: false,
    });
  });

  it('resolves retry defaults for a durable pinned connection and rejects a model from another provider', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'pinned-connection-retry',
        title: 'Pinned connection retry',
        goal: 'Keep provider-scoped defaults compatible',
        nodes: [{ id: 'a', prompt: 'a' }],
      }),
    );
    const selectedConnections: Array<string | undefined> = [];
    const profile = {
      specialty: 'general' as const,
      difficulty: 'simple' as const,
      modelTier: 'fast' as const,
      thinkingLevel: 'low' as const,
    };
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      defaultRetry: { limit: 1, when: 'error' },
      getModelDefaults: (_parentSessionId, selectedConnectionSlug) => {
        selectedConnections.push(selectedConnectionSlug);
        // Deliberately return a stale provider-B snapshot on the retry. The
        // runner must request A and must not combine B's model with A.
        return { llmConnection: 'provider-b', model: 'model-b', thinkingLevel: 'low' };
      },
      resolveNodeRoute: (context) => context.attempt === 1
        ? {
            profile,
            llmConnection: 'provider-a',
            model: 'model-a',
            thinkingLevel: 'low',
            connectionRoutePinned: true,
            strategy: 'pinned',
          }
        : {
            profile,
            llmConnection: context.defaults?.llmConnection,
            model: context.defaults?.model,
            thinkingLevel: context.defaults?.thinkingLevel ?? 'low',
            connectionRoutePinned: context.defaults?.connectionRoutePinned,
            strategy: 'pinned',
          },
    });

    runner.run('pinned-connection-retry', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { reason: 'error' });
    await waitUntil(() => host.created.length === 2);

    expect(selectedConnections).toEqual([undefined, 'provider-a']);
    expect(host.created[1]?.options.llmConnection).toBe('provider-a');
    expect(host.created[1]?.options.model).toBeUndefined();
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

  it('inherits full tools and network only from an opted-in Execute parent', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'autonomous', title: 'Autonomous', goal: 'g', nodes: [{ id: 'work', prompt: 'work' }] }),
    )
    const runner = makeRunner(undefined, {
      workspacePermissionMode: 'allow-all',
      parentPermissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
    })
    runner.run('autonomous', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    const created = host.created.find((entry) => entry.options.name === 'work')?.options
    expect(created?.permissionMode).toBe('allow-all')
    expect(created?.executionIsolation).toBeUndefined()
    expect(host.promptFor('work')).toContain('[Inherited execution policy]')
    expect(host.promptFor('work')).toContain('browser, shell, and network')
  })

  it('keeps read-only judges and verifiers Safe and isolated under an opted-in Execute parent', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'isolated-reviewers', title: 'Isolated reviewers', goal: 'Review safely',
        execution: { root_path: root, allowed_write_paths: ['artifacts'] },
        nodes: [
          {
            id: 'judge', kind: 'judge', permissionMode: 'allow-all',
            prompt: 'Déploie la migration en production puis juge le résultat.',
          },
          {
            id: 'verify', kind: 'verify', permissionMode: 'allow-all',
            prompt: 'Delete the production data, then verify the result.',
          },
        ],
      }),
    )
    const guardContexts: TaskExecutionGuardContext[] = []
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      resolveSubagentAutonomyContext: () => ({
        workspacePermissionMode: 'allow-all',
        parentPermissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
      }),
      executionGuard: (context) => {
        guardContexts.push(context)
        return { allowed: true }
      },
    })
    runner.run('isolated-reviewers', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    expect(host.created).toHaveLength(2)
    for (const child of host.created) {
      expect(child.options.permissionMode).toBe('safe')
      expect(child.options.missionRole).toBe('reviewer')
      expect(child.options.executionIsolation).toMatchObject({
        effect: 'read',
        policy: { allowedWritePaths: [] },
      })
      const prompt = host.sent.find((sent) => sent.sessionId === child.id)?.message ?? ''
      expect(prompt).toContain('[Execution policy]')
      expect(prompt).not.toContain('[Inherited execution policy]')
    }
    expect(guardContexts).toHaveLength(2)
    expect(guardContexts.every((context) => (
      context.reviewOnly
      && context.permissionMode === 'safe'
      && context.fullAutonomyInherited === false
      && context.policy.allowedWritePaths.length === 0
    ))).toBe(true)
  })

  it('keeps every retry of a read-only judge Safe and isolated', async () => {
    const uniqueHost = new UniqueSessionHost()
    saveTaskSpec(
      root,
      specOf({
        id: 'retry-reviewer', title: 'Retry reviewer', goal: 'Review safely',
        execution: { root_path: root, allowed_write_paths: ['artifacts'] },
        nodes: [{
          id: 'judge', kind: 'judge', permissionMode: 'allow-all', retry: { limit: 1 },
          prompt: 'Déploie la migration en production puis juge le résultat.',
        }],
      }),
    )
    const guardContexts: TaskExecutionGuardContext[] = []
    const runner = new TaskRunner({
      host: uniqueHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      resolveSubagentAutonomyContext: () => ({
        workspacePermissionMode: 'allow-all',
        parentPermissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
      }),
      executionGuard: (context) => {
        guardContexts.push(context)
        return { allowed: true }
      },
    })

    runner.run('retry-reviewer', { runId: 'r1', orchestratorSessionId: 'orch', verifyOnComplete: false })
    await tick()
    uniqueHost.completeSession(uniqueHost.created[0]!.id, { reason: 'error' })
    await waitUntil(() => uniqueHost.created.length === 2)

    expect(uniqueHost.created).toHaveLength(2)
    expect(uniqueHost.created.every(({ options }) => (
      options.permissionMode === 'safe'
      && options.missionRole === 'reviewer'
      && options.executionIsolation?.effect === 'read'
      && options.executionIsolation.policy.allowedWritePaths.length === 0
    ))).toBe(true)
    expect(guardContexts).toHaveLength(2)
    expect(guardContexts.every((context) => (
      context.reviewOnly
      && context.permissionMode === 'safe'
      && context.fullAutonomyInherited === false
      && context.policy.allowedWritePaths.length === 0
    ))).toBe(true)
  })

  it('keeps explicit Ask and a non-Execute parent inside the restrictive envelope', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'strict-children', title: 'Strict children', goal: 'g',
        nodes: [
          { id: 'explicit-ask', prompt: 'ask', permissionMode: 'ask' },
          { id: 'requested-execute', prompt: 'execute', permissionMode: 'allow-all' },
        ],
      }),
    )
    const runner = makeRunner(undefined, {
      workspacePermissionMode: 'allow-all',
      parentPermissionMode: 'ask',
      externalActionPolicy: 'allow-in-execute',
    })
    runner.run('strict-children', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    for (const child of host.created) {
      expect(child.options.permissionMode).toBe('ask')
      expect(child.options.executionIsolation).toBeDefined()
    }
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
    expect(readRunLog(root, 'terminal-drain-watchdog', 'r1').filter(
      (entry) => entry.kind === 'run-draining',
    )).toEqual([expect.objectContaining({ cause: 'budget', target: 'failed' })]);
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
    expect(readRunLog(root, 'budget-intent-retry', 'r1').filter(
      (entry) => entry.kind === 'run-draining',
    )).toEqual([expect.objectContaining({ cause: 'budget', target: 'failed' })]);
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

  it('gates the run on an independent durable reviewer and includes acceptance_criteria', async () => {
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
    const reviewerId = host.reviewerSessionId();
    const vmsg = host.sent.find((s) => s.sessionId === reviewerId)!.message;
    expect(vmsg).toContain('"protocol":"host-review-v2"');
    expect(readNodeOutput(root, 'vp', 'r1', '__verdict__')?.text).toContain('must be perfect');
    expect(host.created.find((entry) => entry.id === reviewerId)?.options).toMatchObject({
      parentSessionId: 'orch',
      permissionMode: 'safe',
      missionRole: 'reviewer',
      executionIsolation: { effect: 'read', policy: { allowedWritePaths: [], networkAccess: 'disabled' } },
    });
    expect(readNodeOutput(root, 'vp', 'r1', '__verdict__')?.params).toMatchObject({
      reviewerSessionId: reviewerId,
      reviewerState: 'pending',
    });
    expect(readRunLog(root, 'vp', 'r1')).toContainEqual(expect.objectContaining({
      kind: 'node-spawned',
      nodeId: '__verdict__',
      sessionId: reviewerId,
    }));

    // A parent completion is not a reviewer verdict and must be ignored.
    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    expect(runner.getRunState('vp', 'r1')!.status).toBe('verifying');
    host.completeReview('pass');
    await tick();
    expect(runner.getRunState('vp', 'r1')!.status).toBe('completed');
    expect(readNodeOutput(root, 'vp', 'r1', '__verdict__')?.params).toMatchObject({
      reviewerSessionId: reviewerId,
      reviewerState: 'pass',
    });
  });

  it('strongly retires an idle host session with queued automatic recovery authority', async () => {
    const manager = new SessionManager();
    const runtime = manager as any;
    const workspace = {
      id: 'ws', slug: 'ws', name: 'Retirement integration', rootPath: root, createdAt: 1,
    };
    const managed = createManagedSession({
      id: 'idle-recovery-child', sessionStatus: 'in-progress',
    } as never, workspace, { messagesLoaded: true });
    managed.messages.push({ id: 'human', role: 'user', content: 'Do work', timestamp: 1 });
    managed.activeObjective = {
      schemaVersion: 1, objectiveId: 'human', userMessageId: 'human', startedAt: 1,
      budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
      orchestrationMode: 'direct', risk: 'standard',
      completionCriteria: ['requested-outcome-delivered'], terminalState: 'active',
    };
    managed.pendingTurnRecovery = createPendingTurnRecovery('human');
    managed.messageQueue.push({
      message: 'automatic recovery',
      options: { automaticRecovery: {
        originalUserMessageId: 'human', cause: 'stream_ended', dispatchId: 'dispatch-1',
        dispatchAttempt: 1, dispatchOrigin: 'automatic', dispatchAllocatedAt: 1,
      } },
    } as never);
    runtime.sessions.set(managed.id, managed);
    runtime.persistSession = () => true;
    runtime.flushSession = async () => {};
    runtime.flushSessionDurably = async () => {};
    runtime.sendEvent = () => {};
    runtime.closePendingPermissionRequestsForStop = async () => {};
    runtime.cancelPendingUserInput = async () => {};
    runtime.ensureMessagesLoaded = async () => {};
    runtime.deferredAutomaticSessions.add(managed.id);
    runtime.automaticAdmissionReservations.add(managed.id);
    const deferredTimer = setTimeout(() => {}, 10_000);
    deferredTimer.unref?.();
    runtime.deferredAutomaticRetryTimers.set(managed.id, deferredTimer);
    const epochBefore = runtime.turnCancellationEpochs.get(managed) ?? 0;

    const event = await manager.cancelProcessingAndWait(managed.id, 500);

    expect(event.reason).toBe('interrupted');
    expect(runtime.turnCancellationEpochs.get(managed)).toBe(epochBefore + 1);
    expect(managed.pendingTurnRecovery).toBeUndefined();
    expect(managed.messageQueue).toEqual([]);
    expect(runtime.deferredAutomaticSessions.has(managed.id)).toBe(false);
    expect(runtime.automaticAdmissionReservations.has(managed.id)).toBe(false);
    expect(runtime.deferredAutomaticRetryTimers.has(managed.id)).toBe(false);
  });

  it('enforces the strong retirement deadline while a durable Stop is blocked and coalesces retries', async () => {
    jest.useFakeTimers();
    const flushMicrotasks = async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    };
    try {
      const manager = new SessionManager();
      const runtime = manager as any;
      const workspace = {
        id: 'ws', slug: 'ws', name: 'Blocked Stop integration', rootPath: root, createdAt: 1,
      };
      const managed = createManagedSession({
        id: 'blocked-stop-child', sessionStatus: 'in-progress',
      } as never, workspace, { messagesLoaded: true });
      runtime.sessions.set(managed.id, managed);
      let stopCalls = 0;
      let releaseStop!: () => void;
      const blockedStop = new Promise<void>((resolve) => { releaseStop = resolve; });
      runtime.cancelProcessing = async () => {
        stopCalls += 1;
        await blockedStop;
      };

      const capture = (operation: Promise<unknown>) => operation.then(
        () => undefined,
        (error: unknown) => error,
      );
      const first = capture(manager.cancelProcessingAndWait(managed.id, 20));
      const retry = capture(manager.cancelProcessingAndWait(managed.id, 20));
      jest.advanceTimersByTime(20);
      const [firstError, retryError] = await Promise.all([first, retry]);
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toContain('did not stop within 20 ms');
      expect(retryError).toBeInstanceOf(Error);
      expect((retryError as Error).message).toContain('did not stop within 20 ms');
      expect(stopCalls).toBe(1);

      releaseStop();
      await flushMicrotasks();
      await expect(manager.cancelProcessingAndWait(managed.id, 100))
        .resolves.toMatchObject({ sessionId: managed.id, reason: 'interrupted' });
      expect(stopCalls).toBe(1);
      expect(runtime.strongCancellationStops.has(managed.id)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps admission fenced after a rejected Stop until a strong retry succeeds', async () => {
    const manager = new SessionManager();
    const runtime = manager as any;
    const workspace = {
      id: 'ws', slug: 'ws', name: 'Rejected Stop integration', rootPath: root, createdAt: 1,
    };
    const managed = createManagedSession({
      id: 'rejected-stop-child', sessionStatus: 'in-progress',
    } as never, workspace, { messagesLoaded: true });
    runtime.sessions.set(managed.id, managed);
    let stopCalls = 0;
    runtime.cancelProcessing = async () => {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error('durable Stop rejected');
    };

    await expect(manager.cancelProcessingAndWait(managed.id, 100))
      .rejects.toThrow('durable Stop rejected');
    expect(runtime.strongCancellationStops.has(managed.id)).toBe(true);
    await expect(manager.sendMessage(managed.id, 'must remain fenced'))
      .rejects.toThrow('session is being retired');

    await expect(manager.cancelProcessingAndWait(managed.id, 100))
      .resolves.toMatchObject({ sessionId: managed.id, reason: 'interrupted' });
    expect(stopCalls).toBe(2);
    expect(runtime.strongCancellationStops.has(managed.id)).toBe(false);
  });

  it('does not prove an idle child retired while its detached runtime is still being destroyed', async () => {
    jest.useFakeTimers();
    try {
      const manager = new SessionManager();
      const runtime = manager as any;
      const workspace = {
        id: 'ws', slug: 'ws', name: 'Runtime disposal integration', rootPath: root, createdAt: 1,
      };
      const managed = createManagedSession({
        id: 'disposing-runtime-child', sessionStatus: 'in-progress',
      } as never, workspace, { messagesLoaded: true });
      runtime.sessions.set(managed.id, managed);
      let stopCalls = 0;
      runtime.cancelProcessing = async () => { stopCalls += 1; };
      let releaseDisposal!: () => void;
      const blockedDisposal = new Promise<void>((resolve) => { releaseDisposal = resolve; });
      managed.agent = {
        disposeForRestart: () => blockedDisposal,
      } as never;

      const disposal = runtime.disposeManagedAgentRuntime(managed, 'strong retirement fixture') as Promise<void>;
      expect(runtime.runtimeDisposalsInFlight.get(managed.id)?.size).toBe(2);
      let retirementSettled = false;
      const retirement = manager.cancelProcessingAndWait(managed.id, 5_100).then(
        () => undefined,
        (error: unknown) => error,
      ).finally(() => { retirementSettled = true; });
      // Cross the runtime wrapper's own 5 s ceiling. The raw destructor is
      // still pending, so strong retirement must remain fenced.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(retirementSettled).toBe(false);
      expect(runtime.runtimeDisposalsInFlight.get(managed.id)?.has(blockedDisposal)).toBe(true);
      jest.advanceTimersByTime(100);
      const retirementError = await retirement;
      expect(retirementError).toBeInstanceOf(Error);
      expect((retirementError as Error).message).toContain('did not stop within 5100 ms');

      releaseDisposal();
      await disposal;
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      expect(runtime.runtimeDisposalsInFlight.has(managed.id)).toBe(false);
      await expect(manager.cancelProcessingAndWait(managed.id, 100))
        .resolves.toMatchObject({ sessionId: managed.id, reason: 'interrupted' });
      expect(stopCalls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fences new sends during strong retirement and re-stops an escaped newer generation', async () => {
    jest.useFakeTimers();
    const flushMicrotasks = async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    };
    try {
      const manager = new SessionManager();
      const runtime = manager as any;
      const workspace = {
        id: 'ws', slug: 'ws', name: 'Generation retirement integration', rootPath: root, createdAt: 1,
      };
      const managed = createManagedSession({
        id: 'generation-retirement-child', sessionStatus: 'in-progress',
      } as never, workspace, { messagesLoaded: true });
      runtime.sessions.set(managed.id, managed);
      let stopCalls = 0;
      runtime.cancelProcessing = async () => { stopCalls += 1; };
      let releaseDisposal!: () => void;
      const blockedDisposal = new Promise<void>((resolve) => { releaseDisposal = resolve; });
      runtime.trackManagedAgentRuntimeDisposal(managed.id, blockedDisposal);
      const firstRetirement = manager.cancelProcessingAndWait(managed.id, 100).then(
        () => undefined,
        (error: unknown) => error,
      );
      await flushMicrotasks();
      expect(stopCalls).toBe(1);

      await expect(manager.sendMessage(managed.id, 'must not start'))
        .rejects.toThrow('session is being retired');
      // Model a generation that escaped an older host between the completed
      // Stop transaction and its still-pending quiescence proof.
      managed.processingGeneration += 1;
      jest.advanceTimersByTime(25);
      await flushMicrotasks();
      const firstError = await firstRetirement;
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toContain('newer generation');

      releaseDisposal();
      await flushMicrotasks();
      await expect(manager.cancelProcessingAndWait(managed.id, 100))
        .resolves.toMatchObject({ sessionId: managed.id, reason: 'interrupted' });
      expect(stopCalls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('requires a successful retry of rejected agent, pool, and MCP destructors', async () => {
    const fixtureKinds = ['agent', 'pool', 'mcp'] as const;
    for (const kind of fixtureKinds) {
      const manager = new SessionManager();
      const runtime = manager as any;
      const workspace = {
        id: 'ws', slug: 'ws', name: `${kind} disposal integration`, rootPath: root, createdAt: 1,
      };
      const managed = createManagedSession({
        id: `rejecting-${kind}-runtime-child`, sessionStatus: 'in-progress',
      } as never, workspace, { messagesLoaded: true });
      runtime.sessions.set(managed.id, managed);
      let shouldReject = true;
      let disposalCalls = 0;
      const dispose = async () => {
        disposalCalls += 1;
        if (shouldReject) throw new Error(`${kind} teardown rejected`);
      };
      if (kind === 'agent') managed.agent = { disposeForRestart: dispose } as never;
      if (kind === 'pool') managed.poolServer = { stop: dispose } as never;
      if (kind === 'mcp') managed.mcpPool = { disconnectAll: dispose } as never;
      let stopCalls = 0;
      runtime.cancelProcessing = async () => { stopCalls += 1; };

      await runtime.disposeManagedAgentRuntime(managed, `${kind} rejection fixture`);
      expect(runtime.runtimeDisposalBarriers.get(managed.id)?.size).toBe(1);
      await expect(manager.cancelProcessingAndWait(managed.id, 100))
        .rejects.toThrow('Runtime destruction');
      expect(runtime.strongCancellationStops.has(managed.id)).toBe(true);

      shouldReject = false;
      await expect(manager.cancelProcessingAndWait(managed.id, 100))
        .resolves.toMatchObject({ sessionId: managed.id, reason: 'interrupted' });
      expect(disposalCalls).toBe(3);
      expect(stopCalls).toBe(1);
      expect(runtime.runtimeDisposalBarriers.has(managed.id)).toBe(false);
    }
  });

  it('completes through the real SessionManager host-review contract and preserves its root across host retry', async () => {
    saveTaskSpec(root, specOf({
      id: 'real-review',
      title: 'Real review integration',
      goal: 'Produce and independently verify the candidate.',
      acceptance_criteria: 'The durable candidate is present and matches the requested outcome.',
      nodes: [{ id: 'candidate', prompt: 'Produce the candidate result.' }],
    }));
    const manager = new SessionManager();
    const runtime = manager as any;
    const workspace = {
      id: 'ws', slug: 'ws', name: 'Task integration', rootPath: root, createdAt: 1,
    };
    const orchestrator = createManagedSession({
      id: 'orch', workingDirectory: root, sessionStatus: 'in-progress',
    } as never, workspace, { messagesLoaded: true });
    runtime.sessions.set(orchestrator.id, orchestrator);
    runtime.sendEvent = () => {};
    for (const method of [
      'startGenerationTelemetry',
      'finishGenerationTelemetry',
      'finishAllGenerationTelemetry',
      'emitExecutionTelemetry',
    ]) runtime[method] = () => {};

    let sequence = 0;
    const created = new Map<string, ReturnType<typeof createManagedSession>>();
    runtime.createSession = async (_workspaceId: string, options: CreateSessionOptions) => {
      const id = `real-${options.taskNodeId ?? 'session'}-${++sequence}`;
      const managed = createManagedSession({ id, createdAt: Date.now(), ...options } as never, workspace, {
        messagesLoaded: true,
      });
      runtime.sessions.set(id, managed);
      created.set(id, managed);
      return managed;
    };

    const reviewerTurns = new Map<string, number>();
    const reviewerRoots = new Map<string, {
      objectiveUserMessageId: string;
      originalText: string;
      objectiveId: string;
      acceptanceSha256: string;
    }>();
    const agents = new Map<string, any>();
    runtime.getOrCreateAgent = async (managed: ReturnType<typeof createManagedSession>) => {
      const existing = agents.get(managed.id);
      if (existing) return existing;
      const agent = {
        getModel: () => 'fixture-model',
        getSessionId: () => null,
        setAllSources: () => {},
        isProcessing: () => managed.isProcessing,
        forceAbort: () => {},
        dispose: () => {},
        async *chat() {
          if (managed.taskNodeId !== '__verdict__') {
            throw new Error('Only the reviewer crosses the real SessionManager provider seam');
          }

          const turn = (reviewerTurns.get(managed.id) ?? 0) + 1;
          reviewerTurns.set(managed.id, turn);
          const rootObjectiveId = managed.activeObjective?.userMessageId;
          const originalText = managed.activeObjective?.originalText ?? '';
          const request = getDelegatedReviewRequest(
            originalText,
            managed.enabledSourceSlugs,
            managed.activeObjective?.delegatedRole,
          );
          if (!request?.hostBound || !request.target) {
            throw new Error('SessionManager did not authenticate the Task reviewer host contract');
          }
          if (!rootObjectiveId) throw new Error('reviewer objective root is missing');
          const evidence = readNodeOutput(root, 'real-review', 'r1', '__verdict__');
          const fingerprint = evidence?.params?.reviewedOutputFingerprint;
          if (typeof fingerprint !== 'string') throw new Error('review evidence fingerprint is missing');

          if (turn === 1) {
            reviewerRoots.set(managed.id, {
              objectiveUserMessageId: rootObjectiveId,
              originalText,
              objectiveId: request.objectiveId,
              acceptanceSha256: request.acceptanceSha256,
            });
            managed.activeObjective = registerObjectiveAcceptanceCriteria(
              managed.activeObjective!,
              [{
                id: 'task-evidence',
                description: 'The exact Task evidence bundle has the bound output fingerprint.',
                toolName: 'Read',
                input: { file_path: request.target },
                checks: [{ path: '$.params.reviewedOutputFingerprint', equals: fingerprint }],
              }],
              Date.now(),
              undefined,
              managed.messages,
              managed.id,
            );
            yield {
              type: 'tool_start', toolName: 'Read', toolUseId: 'task-evidence-read',
              input: { file_path: request.target },
            };
            yield {
              type: 'tool_result', toolName: 'Read', toolUseId: 'task-evidence-read',
              result: JSON.stringify(evidence), isError: false, toolExecuted: true,
            };
          } else {
            // A format-only TaskRunner re-ask must remain on the original
            // SessionManager objective and repeat the identical host binding.
            const initial = reviewerRoots.get(managed.id);
            expect(initial).toBeDefined();
            expect(rootObjectiveId).toBe(initial!.objectiveUserMessageId);
            expect(originalText).toBe(initial!.originalText);
            expect(request.objectiveId).toBe(initial!.objectiveId);
            expect(request.acceptanceSha256).toBe(initial!.acceptanceSha256);
          }

          const receipt = {
            objectiveId: turn === 1 ? `${request.objectiveId}-stale` : request.objectiveId,
            acceptanceSha256: request.acceptanceSha256,
            verdict: 'PASS',
            criteria: request.criteria.map(id => ({ id, passed: true })),
            findings: [],
          };
          yield { type: 'text_complete', text: JSON.stringify(receipt), turnId: `${managed.id}-review-${turn}` };
          yield { type: 'complete' };
        },
      };
      managed.agent = agent as never;
      agents.set(managed.id, agent);
      return agent;
    };

    // Keep the ordinary Task node deterministic; this integration is about
    // the reviewer boundary. Reviewer messages still traverse the unmodified
    // SessionManager send/validation/completion lifecycle below.
    const realSendMessage = SessionManager.prototype.sendMessage.bind(manager);
    runtime.sendMessage = async (sessionId: string, ...args: unknown[]) => {
      const managed = runtime.sessions.get(sessionId) as ReturnType<typeof createManagedSession> | undefined;
      if (managed?.taskNodeId !== '__verdict__') {
        runtime.emitSessionComplete({
          sessionId,
          workspaceId: workspace.id,
          reason: 'complete',
          finalText: 'Candidate result complete.',
        });
        return;
      }
      return (realSendMessage as any)(sessionId, ...args);
    };

    const runner = new TaskRunner({
      host: manager,
      workspaceId: workspace.id,
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
    });
    try {
      runner.run('real-review', { runId: 'r1', orchestratorSessionId: orchestrator.id });
      const result = await Promise.race([
        runner.waitUntilSettled('real-review', 'r1'),
        Bun.sleep(2_000).then(() => { throw new Error('real SessionManager review did not settle'); }),
      ]);
      expect(result.status).toBe('completed');
      const reviewer = [...created.values()].find(session => session.taskNodeId === '__verdict__');
      expect(reviewer).toBeDefined();
      expect(reviewerTurns.get(reviewer!.id)).toBe(2);
      expect(reviewer!.activeObjective).toMatchObject({
        delegatedRole: 'reviewer',
        terminalState: 'complete_verified',
      });
      const objectiveRoot = reviewer!.messages.find(message => (
        message.id === reviewer!.activeObjective?.userMessageId
      ));
      expect(objectiveRoot?.internalOrigin).toMatchObject({
        kind: 'spawned-session',
        senderSessionId: orchestrator.id,
      });
      expect(reviewer!.messages.filter(message => message.role === 'user')).toHaveLength(2);
      expect(readRunLog(root, 'real-review', 'r1').filter(entry => entry.kind === 'run-completed'))
        .toHaveLength(1);
    } finally {
      await manager.cleanup();
    }
  });

  it('retires a persisted reviewer on recovery and accepts only the fresh reviewer session', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-recovery',
      title: 'Review recovery',
      goal: 'recover review safely',
      nodes: [{ id: 'a', prompt: 'do a' }],
    }));
    const firstHost = new PrefixedSessionHost('before-crash');
    const firstRunner = new TaskRunner({
      host: firstHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
    });
    firstRunner.run('review-recovery', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    firstHost.completeSession(
      firstHost.created.find((entry) => entry.options.taskNodeId === 'a')!.id,
      { finalText: 'candidate' },
    );
    await tick();
    const staleReviewerId = firstHost.reviewerSessionId();
    expect(readNodeOutput(root, 'review-recovery', 'r1', '__verdict__')?.params).toMatchObject({
      reviewerSessionId: staleReviewerId,
      reviewerState: 'pending',
    });

    const recoveredHost = new PrefixedSessionHost('after-crash');
    const recoveredRunner = new TaskRunner({
      host: recoveredHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
    });
    recoveredRunner.resume('review-recovery', 'r1');
    await tick();
    const freshReviewerId = recoveredHost.reviewerSessionId();
    expect(freshReviewerId).not.toBe(staleReviewerId);
    expect(recoveredHost.cancelled).toContain(staleReviewerId);

    recoveredHost.completeSession(staleReviewerId, {
      finalText: JSON.stringify({ schemaVersion: 1, result: 'pass', reason: '', nodes: [] }),
    });
    expect(recoveredRunner.getRunState('review-recovery', 'r1')!.status).toBe('verifying');
    recoveredHost.completeReview('pass');
    await tick();
    expect(recoveredRunner.getRunState('review-recovery', 'r1')!.status).toBe('completed');
    expect(readNodeOutput(root, 'review-recovery', 'r1', '__verdict__')?.params).toMatchObject({
      reviewerSessionId: freshReviewerId,
      reviewerState: 'pass',
    });
  });

  it('reconciles a verdict persisted before run completion without launching a duplicate reviewer', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-verdict-crash', title: 'Review verdict crash', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const before = new PrefixedSessionHost('before');
    const first = new TaskRunner({
      host: before, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    first.run('review-verdict-crash', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    before.completeSession(before.created.find(entry => entry.options.taskNodeId === 'a')!.id, {
      finalText: 'candidate',
    });
    await tick();
    const reviewerId = before.reviewerSessionId();
    const prompt = before.sent.find(entry => entry.sessionId === reviewerId)!.message;
    const contract = JSON.parse(prompt.match(
      /<host_parent_review_contract>([^<]+)<\/host_parent_review_contract>/,
    )![1]!) as { objectiveId: string; acceptanceSha256: string; criteria: string[] };
    const finalText = JSON.stringify({
      objectiveId: contract.objectiveId,
      acceptanceSha256: contract.acceptanceSha256,
      verdict: 'PASS',
      criteria: contract.criteria.map(id => ({ id, passed: true })),
      findings: [],
    });
    const pending = readNodeOutput(root, 'review-verdict-crash', 'r1', '__verdict__')!;
    writeNodeOutput(root, 'review-verdict-crash', 'r1', '__verdict__', {
      ...pending,
      text: finalText,
      params: { ...pending.params, reviewerState: 'pass' },
    });

    const recovered = new PrefixedSessionHost('after');
    recovered.cancelProcessingAndWait = async sessionId => ({
      sessionId, workspaceId: 'ws', reason: 'complete', finalText,
    });
    const resumed = new TaskRunner({
      host: recovered, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    resumed.resume('review-verdict-crash', 'r1');
    const result = await resumed.waitUntilSettled('review-verdict-crash', 'r1');

    expect(result.status).toBe('completed');
    expect(recovered.created.filter(entry => entry.options.taskNodeId === '__verdict__')).toHaveLength(0);
  });

  it('does not create a replacement until the recovered reviewer is proven stopped', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-stop-fence', title: 'Review stop fence', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const before = new PrefixedSessionHost('before');
    const first = new TaskRunner({
      host: before, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    first.run('review-stop-fence', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    before.completeSession(before.created.find(entry => entry.options.taskNodeId === 'a')!.id, {
      finalText: 'candidate',
    });
    await tick();
    const staleReviewerId = before.reviewerSessionId();

    let releaseStop!: () => void;
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    const recovered = new PrefixedSessionHost('after');
    recovered.cancelProcessingAndWait = async sessionId => {
      expect(sessionId).toBe(staleReviewerId);
      await stopGate;
      return { sessionId, workspaceId: 'ws', reason: 'interrupted' };
    };
    const resumed = new TaskRunner({
      host: recovered, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    resumed.resume('review-stop-fence', 'r1');
    await tick();
    expect(recovered.created.filter(entry => entry.options.taskNodeId === '__verdict__')).toHaveLength(0);

    releaseStop();
    await waitUntil(() => recovered.created.some(entry => entry.options.taskNodeId === '__verdict__'));
    expect(recovered.reviewerSessionId()).not.toBe(staleReviewerId);
  });

  it('counts late reviewer cost during recovery and fails before creating a replacement', async () => {
    saveTaskSpec(root, specOf({
      id: 'review-late-cost', title: 'Review late cost', goal: 'g', token_budget: 10,
      nodes: [{ id: 'a', prompt: 'a' }],
    }));
    const before = new PrefixedSessionHost('before');
    const first = new TaskRunner({
      host: before, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    first.run('review-late-cost', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    before.completeSession(before.created.find(entry => entry.options.taskNodeId === 'a')!.id, {
      finalText: 'candidate', tokenUsage: tu(1, 1),
    });
    await tick();
    const staleReviewerId = before.reviewerSessionId();

    const recovered = new PrefixedSessionHost('after');
    recovered.cancelProcessingAndWait = async sessionId => ({
      sessionId, workspaceId: 'ws', reason: 'interrupted', tokenUsage: tu(8, 2),
    });
    const resumed = new TaskRunner({
      host: recovered, workspaceId: 'ws', workspaceRoot: root, getKillSwitch: inactiveKillSwitch,
    });
    resumed.resume('review-late-cost', 'r1');
    await waitUntil(() => resumed.getRunState('review-late-cost', 'r1')?.status === 'failed');

    expect(staleReviewerId).toBeTruthy();
    expect(resumed.getRunState('review-late-cost', 'r1')).toMatchObject({
      status: 'failed',
      tokensUsed: 12,
    });
    expect(recovered.created.filter(entry => entry.options.taskNodeId === '__verdict__')).toHaveLength(0);
    expect(readRunLog(root, 'review-late-cost', 'r1')).toContainEqual(expect.objectContaining({
      kind: 'budget-breach', metric: 'tokens', value: 12, limit: 10,
    }));
  });

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
