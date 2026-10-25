import { offlineMissionRouteOptions } from "./testing/mission-route-fixture.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISessionManager } from "../handlers/session-manager-interface.ts";
import { MissionRuntimeService } from "./MissionRuntimeService.ts";
import { FakeConnectorChokePoint, ReviewExecutor, binding, connectorStoragePaths, eventually, executionInput, harness, roots, spec } from "./testing/BrokeredMissionConnectorExecutor-fixture.ts";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('BrokeredMissionConnectorExecutor', () => {
  it('returns a host-bound durable approval request before any mutation', async () => {
    const { runtime, executor } = harness();
    const input = executionInput();
    const result = await executor.execute(input, await binding(executor));
    expect(result.status).toBe('approval-required');
    expect(runtime.mutationCount).toBe(0);
    if (result.status !== 'approval-required') throw new Error('expected approval');
    expect(executor.pendingApproval(input.mission.id, input.item.id)).toMatchObject({
      approvalId: result.approvalId,
      requestHash: result.requestHash,
      operationId: 'drive.update',
      risk: 'W2',
      approvalContext: {
        provider: 'Google Workspace',
        connectorId: 'io.robb-agents.google-workspace',
        origin: 'https://www.googleapis.com',
        resourceClass: 'file',
        purpose: 'Update a Drive file',
        effect: 'external-mutation',
        method: 'PATCH',
      },
    });
    expect(JSON.stringify(executor.pendingApproval(input.mission.id, input.item.id))).not.toContain('approved-report.xlsx');
    expect(JSON.stringify(executor.pendingApproval(input.mission.id, input.item.id))).not.toContain('file-42');
    expect(() => executor.resolveApproval({
      missionId: input.mission.id,
      workItemId: input.item.id,
      approvalId: result.approvalId,
      requestHash: '0'.repeat(64),
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    })).toThrow('does not match the durable request');
  });

  it('rejects traversal identifiers before resolving any durable path', () => {
    const { root, executor } = harness();
    expect(() => executor.pendingApproval('../outside', 'publish')).toThrow('Invalid mission id');
    expect(() => executor.pendingApproval('connector-mission', '../outside')).toThrow('Invalid work item id');
    expect(() => executor.resolvedApproval('connector-mission/alias', 'publish')).toThrow('Invalid mission id');
    expect(existsSync(join(root, 'missions'))).toBe(false);
  });

  it('refuses a symlinked Mission directory without writing outside the workspace', async () => {
    const { root, runtime, executor } = harness();
    const input = executionInput();
    const outside = mkdtempSync(join(tmpdir(), 'mission-broker-dir-outside-'));
    roots.push(outside);
    mkdirSync(join(root, 'missions'));
    symlinkSync(outside, connectorStoragePaths(root, input).missionDirectory, 'dir');

    await expect(executor.execute(input, await binding(executor)))
      .rejects.toThrow(/symbolic link|real directory/);
    expect(runtime.mutationCount).toBe(0);
    expect(existsSync(join(outside, 'connector-executions'))).toBe(false);
  });

  it('refuses symlinked and hard-linked durable state files without touching their targets', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const { root, runtime, executor } = harness();
      const input = executionInput();
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-state-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'state.json');
      writeFileSync(outside, 'outside-state-sentinel\n');
      mkdirSync(paths.executionDirectory, { recursive: true });
      if (attack === 'symlink') symlinkSync(outside, paths.state);
      else linkSync(outside, paths.state);

      await expect(executor.execute(input, await binding(executor)))
        .rejects.toThrow(attack === 'symlink' ? /symbolic link/ : /exactly one hard link/);
      expect(runtime.mutationCount).toBe(0);
      expect(readFileSync(outside, 'utf8')).toBe('outside-state-sentinel\n');
    }
  });

  it('refuses symlinked and hard-linked state locks without deleting or modifying their targets', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const { root, runtime, executor } = harness();
      const input = executionInput();
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-lock-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'lock.json');
      writeFileSync(outside, 'outside-lock-sentinel\n');
      mkdirSync(paths.executionDirectory, { recursive: true });
      if (attack === 'symlink') symlinkSync(outside, paths.stateLock);
      else linkSync(outside, paths.stateLock);

      await expect(executor.execute(input, await binding(executor)))
        .rejects.toThrow(attack === 'symlink' ? /symbolic link/ : /exactly one hard link/);
      expect(runtime.mutationCount).toBe(0);
      expect(readFileSync(outside, 'utf8')).toBe('outside-lock-sentinel\n');
      expect(existsSync(paths.state)).toBe(false);
    }
  });

  it('retains ambiguous recovery state when a receipt is symlinked or hard-linked', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const runtime = new FakeConnectorChokePoint();
      runtime.requiresApproval = false;
      const { root, executor } = harness({ runtime });
      const input = executionInput();
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-receipt-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'receipt.json');
      writeFileSync(outside, 'outside-receipt-sentinel\n');
      mkdirSync(paths.executionDirectory, { recursive: true });
      if (attack === 'symlink') symlinkSync(outside, paths.receipt);
      else linkSync(outside, paths.receipt);

      expect(await executor.execute(input, await binding(executor))).toMatchObject({
        status: 'failed',
        ambiguousMutation: true,
        reason: expect.stringContaining('requires recovery reconciliation'),
      });
      expect(runtime.mutationCount).toBe(1);
      expect(readFileSync(outside, 'utf8')).toBe('outside-receipt-sentinel\n');
      expect(JSON.parse(readFileSync(paths.state, 'utf8'))).toMatchObject({ status: 'executing' });
    }
  });

  it('refuses symlinked and hard-linked receipt locks after the provider mutation', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const runtime = new FakeConnectorChokePoint();
      runtime.requiresApproval = false;
      const { root, executor } = harness({ runtime });
      const input = executionInput();
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-receipt-lock-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'receipt-lock.json');
      writeFileSync(outside, 'outside-receipt-lock-sentinel\n');
      mkdirSync(paths.executionDirectory, { recursive: true });
      if (attack === 'symlink') symlinkSync(outside, paths.receiptLock);
      else linkSync(outside, paths.receiptLock);

      expect(await executor.execute(input, await binding(executor))).toMatchObject({
        status: 'failed',
        ambiguousMutation: true,
      });
      expect(runtime.mutationCount).toBe(1);
      expect(readFileSync(outside, 'utf8')).toBe('outside-receipt-lock-sentinel\n');
      expect(existsSync(paths.receipt)).toBe(false);
    }
  });

  it('revalidates the confined receipt before reusing an executed durable state', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const runtime = new FakeConnectorChokePoint();
      runtime.requiresApproval = false;
      const { root, executor } = harness({ runtime });
      const input = executionInput();
      const operationBinding = await binding(executor);
      expect((await executor.execute(input, operationBinding)).status).toBe('submission');
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-stored-receipt-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'receipt.json');
      writeFileSync(outside, 'outside-stored-receipt-sentinel\n');
      unlinkSync(paths.receipt);
      if (attack === 'symlink') symlinkSync(outside, paths.receipt);
      else linkSync(outside, paths.receipt);

      await expect(executor.execute(input, operationBinding))
        .rejects.toThrow(attack === 'symlink' ? /symbolic link/ : /exactly one hard link/);
      expect(runtime.mutationCount).toBe(1);
      expect(readFileSync(outside, 'utf8')).toBe('outside-stored-receipt-sentinel\n');
    }
  });

  it('detects a state pathname swap before truncating or writing the replacement inode', async () => {
    let armed = false;
    let armedCalls = 0;
    let swap: (() => void) | undefined;
    const { root, executor } = harness({
      now: () => {
        if (armed && ++armedCalls === 3) swap?.();
        return '2026-08-20T10:00:00.000Z';
      },
    });
    const input = executionInput();
    const pending = await executor.execute(input, await binding(executor));
    if (pending.status !== 'approval-required') throw new Error('expected approval');
    const paths = connectorStoragePaths(root, input);
    const parked = `${paths.state}.original`;
    const replacement = 'replacement-state-sentinel\n';
    swap = () => {
      renameSync(paths.state, parked);
      writeFileSync(paths.state, replacement);
    };
    armed = true;

    expect(() => executor.resolveApproval({
      missionId: input.mission.id,
      workItemId: input.item.id,
      approvalId: pending.approvalId,
      requestHash: pending.requestHash,
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    })).toThrow(/changed while its descriptor was in use/);
    expect(readFileSync(paths.state, 'utf8')).toBe(replacement);
    expect(JSON.parse(readFileSync(parked, 'utf8'))).toMatchObject({
      revision: 2,
      status: 'waiting-approval',
    });
  });

  it('fails closed when bounded consent metadata is altered beside its canonical request hash', async () => {
    const { root, executor } = harness();
    const input = executionInput();
    const result = await executor.execute(input, await binding(executor));
    if (result.status !== 'approval-required') throw new Error('expected approval');
    const statePath = join(root, 'missions', input.mission.id, 'connector-executions', `${input.item.id}.state.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      pendingApproval: { approvalContext: { purpose: string } };
    };
    state.pendingApproval.approvalContext.purpose = 'Delete every provider record';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    expect(() => executor.pendingApproval(input.mission.id, input.item.id))
      .toThrow('consent context is not bound');
  });

  it('executes only after the signed durable host approval and emits a proof receipt', async () => {
    const { root, runtime, executor } = harness();
    const input = executionInput();
    const operationBinding = await binding(executor);
    const pending = await executor.execute(input, operationBinding);
    if (pending.status !== 'approval-required') throw new Error('expected approval');
    executor.resolveApproval({
      missionId: input.mission.id,
      workItemId: input.item.id,
      approvalId: pending.approvalId,
      requestHash: pending.requestHash,
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    });
    const completed = await executor.execute(input, operationBinding);
    expect(completed.status).toBe('submission');
    expect(runtime.mutationCount).toBe(1);
    if (completed.status !== 'submission') throw new Error('expected submission');
    const uri = completed.submission.evidence[0]?.uri;
    expect(uri).toContain('connector-executions/publish.receipt.json');
    expect(JSON.parse(readFileSync(join(root, uri!), 'utf8'))).toMatchObject({
      kind: 'brokered-connector-mutation',
      operationId: 'drive.update',
      proof: { reconciliation: { status: 'confirmed' } },
    });
  });

  it('reuses a reconciled proof across a replan dispatch without repeating the mutation', async () => {
    const { runtime, executor } = harness();
    runtime.requiresApproval = false;
    const firstInput = executionInput();
    expect((await executor.execute(firstInput, await executor.prepare(firstInput))).status).toBe('submission');
    expect(runtime.mutationCount).toBe(1);

    const replannedInput = { ...firstInput, dispatchId: 'dispatch-after-replan' };
    const replayed = await executor.execute(replannedInput, await executor.prepare(replannedInput));
    expect(replayed.status).toBe('submission');
    expect(runtime.mutationCount).toBe(1);
  });

  it('rebinds an expired unapproved request before issuing a fresh approval', async () => {
    let now = '2026-08-20T10:00:00.000Z';
    const runtime = new FakeConnectorChokePoint();
    const { executor } = harness({ runtime, now: () => now });
    const input = executionInput();
    const operationBinding = await binding(executor);
    const first = await executor.execute(input, operationBinding);
    if (first.status !== 'approval-required') throw new Error('expected approval');
    now = '2026-08-20T10:03:00.000Z';
    runtime.approvalExpiresAt = '2026-08-20T10:05:00.000Z';
    const refreshed = await executor.execute(input, operationBinding);
    expect(refreshed.status).toBe('approval-required');
    if (refreshed.status !== 'approval-required') throw new Error('expected refreshed approval');
    expect(refreshed.requestHash).not.toBe(first.requestHash);
    expect(runtime.mutationCount).toBe(0);
  });

  it('does not replay a durable approval after its expiry', async () => {
    let now = '2026-08-20T10:00:00.000Z';
    const runtime = new FakeConnectorChokePoint();
    const { executor } = harness({ runtime, now: () => now });
    const input = executionInput();
    const operationBinding = await binding(executor);
    const first = await executor.execute(input, operationBinding);
    if (first.status !== 'approval-required') throw new Error('expected approval');
    executor.resolveApproval({
      missionId: input.mission.id,
      workItemId: input.item.id,
      approvalId: first.approvalId,
      requestHash: first.requestHash,
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    });

    now = '2026-08-20T10:03:00.000Z';
    runtime.approvalExpiresAt = '2026-08-20T10:05:00.000Z';
    const refreshed = await executor.execute(input, operationBinding);
    expect(refreshed.status).toBe('approval-required');
    if (refreshed.status !== 'approval-required') throw new Error('expected refreshed approval');
    expect(refreshed.approvalId).not.toBe(first.approvalId);
    expect(refreshed.requestHash).not.toBe(first.requestHash);
    expect(executor.resolvedApproval(input.mission.id, input.item.id)).toBeNull();
    expect(runtime.mutationCount).toBe(0);
  });

  it('recovers a crash after provider mutation without invoking it twice', async () => {
    const runtime = new FakeConnectorChokePoint();
    runtime.requiresApproval = false;
    runtime.crashAfterMutation = true;
    const first = harness({ runtime });
    const input = executionInput();
    const operationBinding = await binding(first.executor);
    expect((await first.executor.execute(input, operationBinding)).status).toBe('failed');
    expect(runtime.mutationCount).toBe(1);
    runtime.crashAfterMutation = false;
    const restarted = harness({
      root: first.root,
      runtime,
      recover: async () => ({ status: 'confirmed', proof: runtime.lastProof! }),
    });
    expect((await restarted.executor.execute(input, operationBinding)).status).toBe('submission');
    expect(runtime.mutationCount).toBe(1);
  });

  it('fails closed and exposes the explicit compensation requirement on reconciliation mismatch', async () => {
    const { runtime, executor } = harness();
    runtime.requiresApproval = false;
    runtime.diverged = true;
    const input = executionInput();
    const result = await executor.execute(input, await binding(executor));
    expect(result).toMatchObject({ status: 'failed', ambiguousMutation: true });
    expect(executor.compensationRequirement(input.mission.id, input.item.id)).toMatchObject({
      compensation: { strategy: 'manual' },
      reason: expect.stringContaining('RECONCILIATION_DIVERGED'),
    });
  });

  it('never retries when crash recovery cannot prove the mutation absent', async () => {
    const runtime = new FakeConnectorChokePoint();
    runtime.requiresApproval = false;
    runtime.crashAfterMutation = true;
    const first = harness({ runtime });
    const input = executionInput();
    const operationBinding = await binding(first.executor);
    await first.executor.execute(input, operationBinding);
    runtime.crashAfterMutation = false;
    const restarted = harness({
      root: first.root,
      runtime,
      recover: async () => ({ status: 'unknown', reason: 'provider lookup unavailable' }),
    });
    expect(await restarted.executor.execute(input, operationBinding)).toMatchObject({
      status: 'failed', ambiguousMutation: true,
    });
    expect(runtime.mutationCount).toBe(1);
  });

  it('integrates with MissionRuntimeService and resumes only after host approval', async () => {
    const broker = harness();
    const sessionManager = {
      waitForInit: async () => {},
      getSessions: () => [],
      cancelProcessing: async () => {},
    } as unknown as ISessionManager;
    const service = new MissionRuntimeService({
      ...offlineMissionRouteOptions,
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: broker.root } : null,
      listWorkspaces: () => [{ id: 'workspace-1', rootPath: broker.root }],
      executorFactory: () => new ReviewExecutor(),
      connectorExecutorFactory: () => broker.executor,
    });
    await service.createAndStart('workspace-1', spec());
    await eventually(async () => (await service.getMission('workspace-1', 'connector-mission')).status === 'waiting-approval');
    const pending = await service.getPendingConnectorApproval('workspace-1', 'connector-mission', 'publish');
    expect(pending).not.toBeNull();
    expect(await service.listPendingConnectorApprovals('workspace-1')).toEqual([pending!]);
    await expect(service.getPendingConnectorApproval(
      'workspace-1',
      'connector-mission',
      '../outside',
    )).rejects.toThrow('Unknown mission work item');
    await service.resolveConnectorApproval({
      ...pending!,
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    });
    await eventually(async () => (await service.getMission('workspace-1', 'connector-mission')).status === 'completed');
    expect(await service.listPendingConnectorApprovals('workspace-1')).toEqual([]);
    expect(broker.runtime.mutationCount).toBe(1);
  });

  it('recovers a crash after the durable approval decision but before Mission resume', async () => {
    const broker = harness();
    const sessionManager = {
      waitForInit: async () => {}, getSessions: () => [], cancelProcessing: async () => {},
    } as unknown as ISessionManager;
    const options = {
      sessionManager,
      resolveWorkspace: (id: string) => id === 'workspace-1' ? { id, rootPath: broker.root } : null,
      listWorkspaces: () => [{ id: 'workspace-1', rootPath: broker.root }],
      executorFactory: () => new ReviewExecutor(),
      connectorExecutorFactory: () => broker.executor,
    };
    const firstService = new MissionRuntimeService({ ...offlineMissionRouteOptions, ...options });
    await firstService.createAndStart('workspace-1', spec());
    await eventually(async () => (await firstService.getMission('workspace-1', 'connector-mission')).status === 'waiting-approval');
    const pending = await firstService.getPendingConnectorApproval('workspace-1', 'connector-mission', 'publish');
    broker.executor.resolveApproval({
      missionId: 'connector-mission', workItemId: 'publish',
      approvalId: pending!.approvalId, requestHash: pending!.requestHash,
      decision: 'approved', resolvedBy: 'human-approver-1',
    });

    const restartedService = new MissionRuntimeService({ ...offlineMissionRouteOptions, ...options });
    expect(await restartedService.start()).toContain('workspace-1:connector-mission');
    await eventually(async () => (await restartedService.getMission('workspace-1', 'connector-mission')).status === 'completed');
    expect(broker.runtime.mutationCount).toBe(1);
  });
});
