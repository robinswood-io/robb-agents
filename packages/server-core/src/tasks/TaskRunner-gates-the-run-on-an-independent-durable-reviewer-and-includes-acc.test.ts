import { sessionManagerForTest } from "../sessions/testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest } from "../sessions/testing/runtime-state-access.ts";
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { saveTaskSpec, readRunLog, readNodeOutput } from "@craft-agent/shared/tasks";
import { createManagedSession, SessionManager } from "../sessions/SessionManager";
import { createPendingTurnRecovery } from "../sessions/turn-recovery.ts";
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
    const runtime = sessionManagerForTest(manager);
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    runtime.persistSession = () => true;
    runtime.flushSession = async () => {};
    runtime.flushSessionDurably = async () => {};
    runtime.sendEvent = () => {};
    runtime.closePendingPermissionRequestsForStop = async () => {};
    runtime.cancelPendingUserInput = async () => {};
    runtime.ensureMessagesLoaded = async () => {};
    sessionRuntimeStateForTest(manager).deferredAutomaticSessions.add(managed.id);
    sessionRuntimeStateForTest(manager).automaticAdmissionReservations.add(managed.id);
    const deferredTimer = setTimeout(() => {}, 10_000);
    deferredTimer.unref?.();
    sessionRuntimeStateForTest(manager).deferredAutomaticRetryTimers.set(managed.id, deferredTimer);
    const epochBefore = sessionRuntimeStateForTest(manager).turnCancellationEpochs.get(managed) ?? 0;

    const event = await manager.cancelProcessingAndWait(managed.id, 500);

    expect(event.reason).toBe('interrupted');
    expect(sessionRuntimeStateForTest(manager).turnCancellationEpochs.get(managed)).toBe(epochBefore + 1);
    expect(managed.pendingTurnRecovery).toBeUndefined();
    expect(managed.messageQueue).toEqual([]);
    expect(sessionRuntimeStateForTest(manager).deferredAutomaticSessions.has(managed.id)).toBe(false);
    expect(sessionRuntimeStateForTest(manager).automaticAdmissionReservations.has(managed.id)).toBe(false);
    expect(sessionRuntimeStateForTest(manager).deferredAutomaticRetryTimers.has(managed.id)).toBe(false);
  });

  it('enforces the strong retirement deadline while a durable Stop is blocked and coalesces retries', async () => {
    jest.useFakeTimers();
    const flushMicrotasks = async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    };
    try {
      const manager = new SessionManager();
      const runtime = sessionManagerForTest(manager);
      const workspace = {
        id: 'ws', slug: 'ws', name: 'Blocked Stop integration', rootPath: root, createdAt: 1,
      };
      const managed = createManagedSession({
        id: 'blocked-stop-child', sessionStatus: 'in-progress',
      } as never, workspace, { messagesLoaded: true });
      sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
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
      expect(sessionRuntimeStateForTest(manager).strongCancellationStops.has(managed.id)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps admission fenced after a rejected Stop until a strong retry succeeds', async () => {
    const manager = new SessionManager();
    const runtime = sessionManagerForTest(manager);
    const workspace = {
      id: 'ws', slug: 'ws', name: 'Rejected Stop integration', rootPath: root, createdAt: 1,
    };
    const managed = createManagedSession({
      id: 'rejected-stop-child', sessionStatus: 'in-progress',
    } as never, workspace, { messagesLoaded: true });
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
    let stopCalls = 0;
    runtime.cancelProcessing = async () => {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error('durable Stop rejected');
    };

    await expect(manager.cancelProcessingAndWait(managed.id, 100))
      .rejects.toThrow('durable Stop rejected');
    expect(sessionRuntimeStateForTest(manager).strongCancellationStops.has(managed.id)).toBe(true);
    await expect(manager.sendMessage(managed.id, 'must remain fenced'))
      .rejects.toThrow('session is being retired');

    await expect(manager.cancelProcessingAndWait(managed.id, 100))
      .resolves.toMatchObject({ sessionId: managed.id, reason: 'interrupted' });
    expect(stopCalls).toBe(2);
    expect(sessionRuntimeStateForTest(manager).strongCancellationStops.has(managed.id)).toBe(false);
  });

  it('does not prove an idle child retired while its detached runtime is still being destroyed', async () => {
    jest.useFakeTimers();
    try {
      const manager = new SessionManager();
      const runtime = sessionManagerForTest(manager);
      const workspace = {
        id: 'ws', slug: 'ws', name: 'Runtime disposal integration', rootPath: root, createdAt: 1,
      };
      const managed = createManagedSession({
        id: 'disposing-runtime-child', sessionStatus: 'in-progress',
      } as never, workspace, { messagesLoaded: true });
      sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
      let stopCalls = 0;
      runtime.cancelProcessing = async () => { stopCalls += 1; };
      let releaseDisposal!: () => void;
      const blockedDisposal = new Promise<void>((resolve) => { releaseDisposal = resolve; });
      managed.agent = {
        disposeForRestart: () => blockedDisposal,
      } as never;

      const disposal = runtime.disposeManagedAgentRuntime(managed, 'strong retirement fixture') as Promise<void>;
      expect(sessionRuntimeStateForTest(manager).runtimeDisposalsInFlight.get(managed.id)?.size).toBe(2);
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
      expect(sessionRuntimeStateForTest(manager).runtimeDisposalsInFlight.get(managed.id)?.has(blockedDisposal)).toBe(true);
      jest.advanceTimersByTime(100);
      const retirementError = await retirement;
      expect(retirementError).toBeInstanceOf(Error);
      expect((retirementError as Error).message).toContain('did not stop within 5100 ms');

      releaseDisposal();
      await disposal;
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      expect(sessionRuntimeStateForTest(manager).runtimeDisposalsInFlight.has(managed.id)).toBe(false);
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
      const runtime = sessionManagerForTest(manager);
      const workspace = {
        id: 'ws', slug: 'ws', name: 'Generation retirement integration', rootPath: root, createdAt: 1,
      };
      const managed = createManagedSession({
        id: 'generation-retirement-child', sessionStatus: 'in-progress',
      } as never, workspace, { messagesLoaded: true });
      sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
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
      const runtime = sessionManagerForTest(manager);
      const workspace = {
        id: 'ws', slug: 'ws', name: `${kind} disposal integration`, rootPath: root, createdAt: 1,
      };
      const managed = createManagedSession({
        id: `rejecting-${kind}-runtime-child`, sessionStatus: 'in-progress',
      } as never, workspace, { messagesLoaded: true });
      sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed);
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
      expect(sessionRuntimeStateForTest(manager).runtimeDisposalBarriers.get(managed.id)?.size).toBe(1);
      await expect(manager.cancelProcessingAndWait(managed.id, 100))
        .rejects.toThrow('Runtime destruction');
      expect(sessionRuntimeStateForTest(manager).strongCancellationStops.has(managed.id)).toBe(true);

      shouldReject = false;
      await expect(manager.cancelProcessingAndWait(managed.id, 100))
        .resolves.toMatchObject({ sessionId: managed.id, reason: 'interrupted' });
      expect(disposalCalls).toBe(3);
      expect(stopCalls).toBe(1);
      expect(sessionRuntimeStateForTest(manager).runtimeDisposalBarriers.has(managed.id)).toBe(false);
    }
  });
});
