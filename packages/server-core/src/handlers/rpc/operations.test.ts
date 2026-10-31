import { afterEach, describe, expect, it } from 'bun:test';
import {
  clearRobbOperationsExtension,
  registerRobbOperationsExtension,
  type OperationsSettingsDto,
} from '@craft-agent/shared/operations';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { RequestContext, RpcServer } from '../../transport/types.ts';
import type { HandlerDeps } from '../handler-deps.ts';
import { registerOperationsHandlers } from './operations.ts';

function context(roles: string[] = ['owner']): RequestContext {
  return {
    clientId: 'client-1',
    workspaceId: 'workspace-1',
    webContentsId: null,
    actorId: 'transport-authenticated-owner',
    roles,
    authorizationGeneration: 1,
    allowedWorkspaceIds: ['workspace-1'],
  };
}

function harness() {
  const handlers = new Map<string, (ctx: RequestContext, ...args: unknown[]) => unknown>();
  const server: RpcServer = {
    handle: (channel, handler) => { handlers.set(channel, handler as (ctx: RequestContext, ...args: unknown[]) => unknown); },
    push: () => undefined,
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  };
  registerOperationsHandlers(server, {} as HandlerDeps);
  return handlers;
}

afterEach(async () => clearRobbOperationsExtension());

describe('Robb Operations RPC', () => {
  it('reports the capability as unavailable in the OSS-only host', async () => {
    const handler = harness().get(RPC_CHANNELS.operations.GET_STATUS)!;
    expect(await handler(context(), 'workspace-1')).toEqual({ available: false });
  });

  it('uses transport identity and privileged roles to resolve approvals', async () => {
    let actor = '';
    registerRobbOperationsExtension({
      apiVersion: 1,
      id: 'operations-rpc-test',
      edition: 'commercial',
      beforeTurn: () => ({ decision: 'allow' }),
      beforeTool: () => ({ decision: 'allow' }),
      onRuntimeEvent: () => undefined,
      getSnapshot: workspaceId => ({ workspaceId, available: true }),
      resolveApproval: (_workspaceId, _approvalId, _approved, actorId) => {
        actor = actorId;
        return true;
      },
    });
    const handlers = harness();
    expect(await handlers.get(RPC_CHANNELS.operations.GET_STATUS)!(context(), 'workspace-1'))
      .toEqual({
        available: true,
        extensionId: 'operations-rpc-test',
        snapshot: { workspaceId: 'workspace-1', available: true },
      });
    expect(await handlers.get(RPC_CHANNELS.operations.RESOLVE_APPROVAL)!(
      context(['validator']),
      'workspace-1',
      { approvalId: 'ops_123', approved: true },
    )).toEqual({ resolved: true });
    expect(actor).toBe('transport-authenticated-owner');
  });

  it('returns and updates validated budget settings with authenticated ownership', async () => {
    let updatedBy = '';
    let current: OperationsSettingsDto = {
      budgets: {
        warningAction: 'notify',
        hardLimitAction: 'notify',
        sessionWarningUsd: 8,
        sessionHardUsd: 25,
        missionWarningUsd: 30,
        missionHardUsd: 75,
        workspaceDailyWarningUsd: 120,
        workspaceDailyHardUsd: 250,
      },
    };
    registerRobbOperationsExtension({
      apiVersion: 1,
      id: 'operations-settings-test',
      edition: 'commercial',
      beforeTurn: () => ({ decision: 'allow' }),
      beforeTool: () => ({ decision: 'allow' }),
      onRuntimeEvent: () => undefined,
      getSettings: () => current,
      updateSettings: (_workspaceId, settings, actorId) => {
        updatedBy = actorId;
        current = settings;
        return settings;
      },
    });
    const handlers = harness();
    const status = await handlers.get(RPC_CHANNELS.operations.GET_STATUS)!(context(), 'workspace-1');
    expect(status).toMatchObject({ available: true, settings: current });

    const next = {
      budgets: { ...current.budgets, hardLimitAction: 'block' as const },
    };
    expect(await handlers.get(RPC_CHANNELS.operations.UPDATE_SETTINGS)!(context(), 'workspace-1', next))
      .toEqual(next);
    expect(updatedBy).toBe('transport-authenticated-owner');
  });

  it('rejects unprivileged and over-posted approval requests', async () => {
    registerRobbOperationsExtension({
      apiVersion: 1,
      id: 'operations-rpc-test',
      edition: 'commercial',
      beforeTurn: () => ({ decision: 'allow' }),
      beforeTool: () => ({ decision: 'allow' }),
      onRuntimeEvent: () => undefined,
      resolveApproval: () => true,
    });
    const handler = harness().get(RPC_CHANNELS.operations.RESOLVE_APPROVAL)!;
    await expect(handler(context(['viewer']), 'workspace-1', {
      approvalId: 'ops_123', approved: true,
    })).rejects.toThrow('owner, admin or validator');
    await expect(handler(context(), 'workspace-1', {
      approvalId: 'ops_123', approved: true, actorId: 'forged',
    })).rejects.toThrow('Invalid Robb Operations approval request');
  });

  it('rejects unprivileged or malformed settings updates', async () => {
    registerRobbOperationsExtension({
      apiVersion: 1,
      id: 'operations-settings-test',
      edition: 'commercial',
      beforeTurn: () => ({ decision: 'allow' }),
      beforeTool: () => ({ decision: 'allow' }),
      onRuntimeEvent: () => undefined,
      updateSettings: (_workspaceId, settings) => settings,
    });
    const handler = harness().get(RPC_CHANNELS.operations.UPDATE_SETTINGS)!;
    const valid = {
      budgets: {
        warningAction: 'notify', hardLimitAction: 'notify',
        sessionWarningUsd: 8, sessionHardUsd: 25,
        missionWarningUsd: 30, missionHardUsd: 75,
        workspaceDailyWarningUsd: 120, workspaceDailyHardUsd: 250,
      },
    };
    await expect(handler(context(['viewer']), 'workspace-1', valid)).rejects.toThrow('owner or admin');
    await expect(handler(context(), 'workspace-1', {
      ...valid,
      budgets: { ...valid.budgets, hardLimitAction: 'ignore', forged: true },
    })).rejects.toThrow('Invalid Robb Operations settings');
  });
});
