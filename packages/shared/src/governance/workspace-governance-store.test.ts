import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultWorkspaceGovernance } from './workspace-governance.ts';
import {
  GovernanceRevisionConflictError,
  WorkspaceGovernanceStore,
} from './workspace-governance-store.ts';

const roots: string[] = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'robb-governance-store-'));
  roots.push(root);
  const profile = createDefaultWorkspaceGovernance({
    workspaceId: 'ws-shared',
    workspaceName: 'Shared workspace',
    createdAt: '2026-07-23T08:00:00.000Z',
  });
  return { root, profile };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('WorkspaceGovernanceStore', () => {
  it('shares an atomic 0600 document between independent store instances', async () => {
    const { root, profile } = createFixture();
    const first = new WorkspaceGovernanceStore(root, {
      now: () => new Date('2026-07-23T09:00:00.000Z'),
    });
    const second = new WorkspaceGovernanceStore(root);

    const created = await first.loadOrCreate(profile);
    const loaded = await second.load();

    expect(loaded).toEqual(created);
    expect(statSync(first.documentPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.robb')).mode & 0o777).toBe(0o700);
  });

  it('rejects a stale writer with the current revision', async () => {
    const { root, profile } = createFixture();
    const first = new WorkspaceGovernanceStore(root);
    const second = new WorkspaceGovernanceStore(root);
    const created = await first.loadOrCreate(profile);

    const updated = await first.update(created.revision, 'local-owner', {
      members: created.profile.space.members,
      memory: { enabled: false, retentionDays: 30 },
      budgets: created.profile.budgets,
    });

    try {
      await second.update(created.revision, 'local-owner', {
        members: created.profile.space.members,
        memory: created.profile.space.memory,
        budgets: { ...created.profile.budgets, missionMaxTokens: 10_000 },
      });
      throw new Error('Expected the stale governance update to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceRevisionConflictError);
      if (error instanceof GovernanceRevisionConflictError) {
        expect(error.actualRevision).toBe(updated.revision);
      }
    }
  });

  it('enforces workspace RBAC inside the shared transaction', async () => {
    const { root, profile } = createFixture();
    const store = new WorkspaceGovernanceStore(root);
    const created = await store.loadOrCreate(profile);
    const assignedAt = '2026-07-23T09:00:00.000Z';
    const withOperator = await store.update(created.revision, 'local-owner', {
      members: [
        ...created.profile.space.members,
        {
          actorId: 'operator-1',
          role: 'operator',
          assignedBy: 'local-owner',
          assignedAt,
        },
      ],
      memory: created.profile.space.memory,
      budgets: created.profile.budgets,
    });

    await expect(store.update(withOperator.revision, 'operator-1', {
      members: withOperator.profile.space.members,
      memory: withOperator.profile.space.memory,
      budgets: { ...withOperator.profile.budgets, missionMaxCostUsd: 5 },
    })).rejects.toThrow('cannot update governance policies');
  });
});
