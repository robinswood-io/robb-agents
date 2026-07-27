import { describe, expect, it } from 'bun:test';
import {
  appendGovernanceAudit,
  authorizeSpaceAction,
  canAssignSpaceRole,
  createSpaceMemoryEntry,
  exportSpaceMemory,
  purgeSpaceMemory,
  verifyGovernanceAudit,
  versionSpaceResource,
  type GovernanceAuditEvent,
  type SpaceManifest,
} from './space-governance.ts';

const space: SpaceManifest = {
  schemaVersion: 1,
  id: 'client-acme',
  kind: 'client',
  name: 'Acme',
  createdBy: 'alice',
  createdAt: '2026-07-23T08:00:00.000Z',
  memory: { enabled: true, retentionDays: 90 },
  members: [
    { actorId: 'alice', role: 'owner', assignedBy: 'alice', assignedAt: '2026-07-23T08:00:00.000Z' },
    { actorId: 'adam', role: 'admin', assignedBy: 'alice', assignedAt: '2026-07-23T08:00:00.000Z' },
    { actorId: 'olivia', role: 'operator', assignedBy: 'adam', assignedAt: '2026-07-23T08:00:00.000Z' },
    { actorId: 'victor', role: 'validator', assignedBy: 'alice', assignedAt: '2026-07-23T08:00:00.000Z' },
    { actorId: 'riley', role: 'reader', assignedBy: 'adam', assignedAt: '2026-07-23T08:00:00.000Z' },
  ],
};

describe('space governance', () => {
  it('enforces the sensitive-operation RBAC matrix', () => {
    expect(authorizeSpaceAction(space, 'alice', 'space.manage-members')).toBe(true);
    expect(authorizeSpaceAction(space, 'adam', 'policy.update')).toBe(true);
    expect(authorizeSpaceAction(space, 'adam', 'space.manage-members')).toBe(false);
    expect(authorizeSpaceAction(space, 'olivia', 'mission.run')).toBe(true);
    expect(authorizeSpaceAction(space, 'olivia', 'mission.kill-switch')).toBe(true);
    expect(authorizeSpaceAction(space, 'olivia', 'mission.approve')).toBe(false);
    expect(authorizeSpaceAction(space, 'victor', 'mission.approve')).toBe(true);
    expect(authorizeSpaceAction(space, 'riley', 'memory.export')).toBe(false);
    expect(canAssignSpaceRole(space, 'adam', 'owner')).toBe(false);
    expect(canAssignSpaceRole(space, 'alice', 'owner')).toBe(true);
  });

  it('versions policies with visible authorship and an unbroken predecessor hash', () => {
    const first = versionSpaceResource({
      id: 'routing',
      spaceId: space.id,
      kind: 'policy',
      content: '{"mode":"safe"}',
      authorId: 'adam',
      createdAt: '2026-07-23T09:00:00.000Z',
    });
    const second = versionSpaceResource({
      id: 'routing',
      spaceId: space.id,
      kind: 'policy',
      content: '{"mode":"ask"}',
      authorId: 'alice',
      createdAt: '2026-07-23T10:00:00.000Z',
      previous: first,
    });
    expect(second.version).toBe(2);
    expect(second.authorId).toBe('alice');
    expect(second.previousVersionHash).toBe(first.contentHash);
  });

  it('keeps memory provenance, honors disable/retention, redacts secrets, and supports targeted purge', () => {
    const entry = createSpaceMemoryEntry({
      id: 'mem-1',
      spaceId: space.id,
      content: 'API_KEY=super-secret-value and decision: use Bun',
      sensitivity: 'confidential',
      retentionDays: 30,
      secretReferenceIds: ['credential://openai/main'],
      provenance: {
        sourceType: 'mission',
        sourceId: 'mission-1',
        authorId: 'olivia',
        createdAt: '2026-07-23T10:00:00.000Z',
      },
    });
    const exported = exportSpaceMemory(space, 'adam', [entry], new Date('2026-07-24T10:00:00.000Z'));
    expect(exported).toHaveLength(1);
    expect(exported[0]?.content).toContain('[REDACTED]');
    expect(exported[0]?.provenance.authorId).toBe('olivia');
    expect('secretReferenceIds' in (exported[0] ?? {})).toBe(false);

    const disabled = { ...space, memory: { ...space.memory, enabled: false } };
    expect(exportSpaceMemory(disabled, 'adam', [entry])).toEqual([]);

    const purged = purgeSpaceMemory(space, 'alice', [entry], ['mem-1']);
    expect(purged.purgedIds).toEqual(['mem-1']);
    expect(purged.kept).toEqual([]);
    expect(() => purgeSpaceMemory(space, 'riley', [entry])).toThrow('not authorized');
  });

  it('detects mutations in the append-only governance audit hash chain', () => {
    const events: GovernanceAuditEvent[] = [];
    appendGovernanceAudit(events, {
      spaceId: space.id,
      action: 'member.role.changed',
      actorId: 'alice',
      targetId: 'olivia',
      details: 'operator -> validator',
      timestamp: '2026-07-23T10:00:00.000Z',
    });
    appendGovernanceAudit(events, {
      spaceId: space.id,
      action: 'policy.versioned',
      actorId: 'adam',
      targetId: 'routing',
      details: 'version 2',
      timestamp: '2026-07-23T10:05:00.000Z',
    });
    expect(verifyGovernanceAudit(events)).toEqual({ valid: true });

    const tampered = events.map((event) => ({ ...event }));
    const first = tampered[0];
    if (first) first.actorId = 'mallory';
    expect(verifyGovernanceAudit(tampered)).toEqual({ valid: false, invalidSequence: 1 });
  });
});
