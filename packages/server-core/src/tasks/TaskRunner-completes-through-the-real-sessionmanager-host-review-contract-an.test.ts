import { withSessionOperationsForTest } from '../sessions/testing/session-operation-access.ts';
import { sessionManagerForTest } from "../sessions/testing/private-runtime-access.ts";
import { completeSessionAgentFixture } from "../sessions/testing/scripted-session-agent.ts";
import { managedToSession } from "../sessions/SessionManager/session-presentation.ts";
import { sessionRuntimeStateForTest } from "../sessions/testing/runtime-state-access.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CreateSessionOptions } from "@craft-agent/shared/protocol";
import { saveTaskSpec, readRunLog, readNodeOutput, writeNodeOutput } from "@craft-agent/shared/tasks";
import { createManagedSession, SessionManager } from "../sessions/SessionManager";
import { getDelegatedReviewRequest } from "../sessions/delegated-review-outcome.ts";
import { registerObjectiveAcceptanceCriteria } from "../sessions/objective-acceptance-criteria.ts";
import { TaskRunner } from "./TaskRunner";
import { PrefixedSessionHost, inactiveKillSwitch, specOf, tick, tu, waitUntil } from "./testing/TaskRunner-fixture.ts";

describe('TaskRunner (Conductor)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('completes through the real SessionManager host-review contract and preserves its root across host retry', async () => {
    saveTaskSpec(root, specOf({
      id: 'real-review',
      title: 'Real review integration',
      goal: 'Produce and independently verify the candidate.',
      acceptance_criteria: 'The durable candidate is present and matches the requested outcome.',
      nodes: [{ id: 'candidate', prompt: 'Produce the candidate result.' }],
    }));
    const manager = withSessionOperationsForTest(new SessionManager());
    const runtime = sessionManagerForTest(manager);
    const workspace = {
      id: 'ws', slug: 'ws', name: 'Task integration', rootPath: root, createdAt: 1,
    };
    const orchestrator = createManagedSession({
      id: 'orch', workingDirectory: root, sessionStatus: 'in-progress',
    } as never, workspace, { messagesLoaded: true });
    sessionRuntimeStateForTest(manager).sessions.set(orchestrator.id, orchestrator);
    runtime.sendEvent = () => {};
    for (const method of [
      'startGenerationTelemetry',
      'finishGenerationTelemetry',
      'finishAllGenerationTelemetry',
      'emitExecutionTelemetry',
    ] as const) runtime[method] = () => {};

    let sequence = 0;
    const created = new Map<string, ReturnType<typeof createManagedSession>>();
    runtime.createSession = async (_workspaceId: string, options: CreateSessionOptions = {}) => {
      const id = `real-${options.taskNodeId ?? 'session'}-${++sequence}`;
      const managed = createManagedSession({ id, createdAt: Date.now(), ...options } as never, workspace, {
        messagesLoaded: true,
      });
      sessionRuntimeStateForTest(manager).sessions.set(id, managed);
      created.set(id, managed);
      return managedToSession(managed);
    };

    const reviewerTurns = new Map<string, number>();
    const reviewerRoots = new Map<string, {
      objectiveUserMessageId: string;
      originalText: string;
      objectiveId: string;
      acceptanceSha256: string;
    }>();
    const agents = new Map<string, NonNullable<ReturnType<typeof createManagedSession>['agent']>>();
    runtime.getOrCreateAgent = async (managed: ReturnType<typeof createManagedSession>) => {
      const existing = agents.get(managed.id);
      if (existing) return existing;
      const agent = completeSessionAgentFixture(workspace, {
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
          const fingerprint = evidence?.params?.["reviewedOutputFingerprint"];
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
      });
      managed.agent = agent;
      agents.set(managed.id, agent);
      return agent;
    };

    // Keep the ordinary Task node deterministic; this integration is about
    // the reviewer boundary. Reviewer messages still traverse the unmodified
    // SessionManager send/validation/completion lifecycle below.
    const realSendMessage = SessionManager.prototype.sendMessage.bind(manager);
    runtime.sendMessage = async (sessionId, ...args) => {
      const managed = sessionRuntimeStateForTest(manager).sessions.get(sessionId) as ReturnType<typeof createManagedSession> | undefined;
      if (managed?.taskNodeId !== '__verdict__') {
        runtime.emitSessionComplete({
          sessionId,
          workspaceId: workspace.id,
          reason: 'complete',
          finalText: 'Candidate result complete.',
        });
        return;
      }
      return realSendMessage(sessionId, ...args);
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
    expect<unknown>(readRunLog(root, 'review-late-cost', 'r1')).toContainEqual((expect.objectContaining({
      kind: 'budget-breach', metric: 'tokens', value: 12, limit: 10,
    }) as unknown));
  });
});
