import { describe, expect, it } from 'bun:test';
import {
  applyWorkspaceGovernanceUpdate,
  createDefaultWorkspaceGovernance,
  parseWorkspaceGovernanceProfile,
} from './workspace-governance.ts';

describe('workspace governance profile', () => {
  it('creates a local owner with safe memory and warning defaults', () => {
    const profile = createDefaultWorkspaceGovernance({
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      createdAt: '2026-07-23T08:00:00.000Z',
    });

    expect(profile.space.members).toEqual([
      {
        actorId: 'local-owner',
        role: 'owner',
        assignedBy: 'local-owner',
        assignedAt: '2026-07-23T08:00:00.000Z',
      },
    ]);
    expect(profile.space.memory).toEqual({ enabled: true, retentionDays: 90 });
    expect(profile.budgets.warningPercent).toBe(80);
  });

  it('persists member, memory, and budget changes in a verifiable audit chain', () => {
    const profile = createDefaultWorkspaceGovernance({
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      createdAt: '2026-07-23T08:00:00.000Z',
    });
    const updated = applyWorkspaceGovernanceUpdate(
      profile,
      {
        members: [
          ...profile.space.members,
          {
            actorId: 'operator-1',
            role: 'operator',
            assignedBy: 'local-owner',
            assignedAt: '2026-07-23T09:00:00.000Z',
          },
        ],
        memory: { enabled: false, retentionDays: 30 },
        budgets: { missionMaxTokens: 100_000, missionMaxCostUsd: 25, warningPercent: 75 },
      },
      'local-owner',
      '2026-07-23T09:00:00.000Z',
    );

    expect(updated.audit).toHaveLength(3);
    expect(updated.audit.map((event) => event.targetId)).toEqual([
      'members',
      'memory-retention',
      'mission-budgets',
    ]);
    expect(() => parseWorkspaceGovernanceProfile(updated)).not.toThrow();
  });

  it('refuses to remove the local owner or accept a tampered audit chain', () => {
    const profile = createDefaultWorkspaceGovernance({
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      createdAt: '2026-07-23T08:00:00.000Z',
    });
    expect(() => applyWorkspaceGovernanceUpdate(
      profile,
      {
        members: [{
          actorId: 'operator-1',
          role: 'owner',
          assignedBy: 'local-owner',
          assignedAt: '2026-07-23T09:00:00.000Z',
        }],
        memory: profile.space.memory,
        budgets: profile.budgets,
      },
      'local-owner',
    )).toThrow('local workspace owner');

    const updated = applyWorkspaceGovernanceUpdate(
      profile,
      {
        members: profile.space.members,
        memory: { enabled: false, retentionDays: 30 },
        budgets: profile.budgets,
      },
      'local-owner',
    );
    const tampered = {
      ...updated,
      audit: updated.audit.map((event, index) => index === 0 ? { ...event, actorId: 'mallory' } : event),
    };
    expect(() => parseWorkspaceGovernanceProfile(tampered)).toThrow('audit chain is invalid');
  });
});
