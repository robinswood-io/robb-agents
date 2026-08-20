import { describe, expect, it } from 'bun:test';
import { resolveSubagentAutonomy } from './autonomy-inheritance.ts';

describe('subagent autonomy inheritance', () => {
  it('grants full autonomy only for Execute plus the external-action opt-in', () => {
    expect(resolveSubagentAutonomy({
      workspacePermissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
    })).toMatchObject({
      permissionMode: 'allow-all',
      grantsFullToolAndNetworkAccess: true,
      reason: 'inherited-full-autonomy',
    });

    expect(resolveSubagentAutonomy({
      workspacePermissionMode: 'allow-all',
      externalActionPolicy: 'confirm',
    })).toMatchObject({
      permissionMode: 'safe',
      grantsFullToolAndNetworkAccess: false,
    });
  });

  it('uses the parent before the workspace and never escalates Ask or Safe', () => {
    expect(resolveSubagentAutonomy({
      workspacePermissionMode: 'allow-all',
      parentPermissionMode: 'ask',
      externalActionPolicy: 'allow-in-execute',
      requestedPermissionMode: 'allow-all',
    })).toMatchObject({
      authorityPermissionMode: 'ask',
      permissionMode: 'ask',
      grantsFullToolAndNetworkAccess: false,
    });

    expect(resolveSubagentAutonomy({
      workspacePermissionMode: 'allow-all',
      parentPermissionMode: 'safe',
      externalActionPolicy: 'allow-in-execute',
      requestedPermissionMode: 'allow-all',
    })).toMatchObject({
      permissionMode: 'safe',
      grantsFullToolAndNetworkAccess: false,
    });
  });

  it('preserves an explicitly stricter child request under a fully autonomous parent', () => {
    const context = {
      parentPermissionMode: 'allow-all' as const,
      externalActionPolicy: 'allow-in-execute' as const,
    };
    expect(resolveSubagentAutonomy({ ...context, requestedPermissionMode: 'ask' }))
      .toMatchObject({ permissionMode: 'ask', grantsFullToolAndNetworkAccess: false });
    expect(resolveSubagentAutonomy({ ...context, requestedPermissionMode: 'safe' }))
      .toMatchObject({ permissionMode: 'safe', grantsFullToolAndNetworkAccess: false });
  });

  it('fails closed when configuration is absent', () => {
    expect(resolveSubagentAutonomy({})).toEqual({
      authorityPermissionMode: 'safe',
      permissionMode: 'safe',
      grantsFullToolAndNetworkAccess: false,
      reason: 'strict-default',
    });
    expect(resolveSubagentAutonomy({
      parentPermissionMode: 'ask',
      externalActionPolicy: 'allow-in-execute',
    })).toMatchObject({
      permissionMode: 'safe',
      grantsFullToolAndNetworkAccess: false,
      reason: 'strict-default',
    });
  });
});
