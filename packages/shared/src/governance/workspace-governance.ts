import { z } from 'zod';
import {
  SPACE_KINDS,
  SPACE_ROLES,
  appendGovernanceAudit,
  authorizeSpaceAction,
  canAssignSpaceRole,
  verifyGovernanceAudit,
  type GovernanceAuditEvent,
  type SpaceManifest,
  type SpaceMember,
} from './space-governance.ts';

const GOVERNANCE_AUDIT_ACTIONS = [
  'member.role.changed',
  'policy.versioned',
  'playbook.versioned',
  'connection.versioned',
  'memory.exported',
  'memory.purged',
] as const;

const SpaceMemberSchema = z.object({
  actorId: z.string().trim().min(1),
  role: z.enum(SPACE_ROLES),
  assignedBy: z.string().trim().min(1),
  assignedAt: z.string().datetime(),
});

const SpaceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(1),
  kind: z.enum(SPACE_KINDS),
  name: z.string().trim().min(1),
  members: z.array(SpaceMemberSchema).min(1),
  memory: z.object({
    enabled: z.boolean(),
    retentionDays: z.number().int().min(1).max(3_650),
  }),
  createdBy: z.string().trim().min(1),
  createdAt: z.string().datetime(),
});

const GovernanceAuditEventSchema = z.object({
  sequence: z.number().int().positive(),
  spaceId: z.string().trim().min(1),
  action: z.enum(GOVERNANCE_AUDIT_ACTIONS),
  actorId: z.string().trim().min(1),
  targetId: z.string().trim().min(1),
  timestamp: z.string().datetime(),
  detailsHash: z.string().regex(/^[a-f0-9]{64}$/),
  previousHash: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const WorkspaceGovernanceBudgetsSchema = z.object({
  missionMaxTokens: z.number().int().positive().optional(),
  missionMaxCostUsd: z.number().positive().optional(),
  warningPercent: z.number().int().min(1).max(100).default(80),
});

export const WorkspaceGovernanceMutableSchema = z.object({
  members: z.array(SpaceMemberSchema).min(1),
  memory: SpaceManifestSchema.shape.memory,
  budgets: WorkspaceGovernanceBudgetsSchema,
});

export const WorkspaceGovernanceProfileSchema = z.object({
  schemaVersion: z.literal(1),
  space: SpaceManifestSchema,
  budgets: WorkspaceGovernanceBudgetsSchema,
  audit: z.array(GovernanceAuditEventSchema),
});

export type WorkspaceGovernanceBudgets = z.infer<typeof WorkspaceGovernanceBudgetsSchema>;
export type WorkspaceGovernanceMutable = z.infer<typeof WorkspaceGovernanceMutableSchema>;
export type WorkspaceGovernanceProfile = z.infer<typeof WorkspaceGovernanceProfileSchema>;

export function createDefaultWorkspaceGovernance(input: {
  workspaceId: string;
  workspaceName: string;
  createdAt: string;
  actorId?: string;
}): WorkspaceGovernanceProfile {
  const actorId = input.actorId ?? 'local-owner';
  return {
    schemaVersion: 1,
    space: {
      schemaVersion: 1,
      id: input.workspaceId,
      kind: 'personal',
      name: input.workspaceName,
      members: [
        {
          actorId,
          role: 'owner',
          assignedBy: actorId,
          assignedAt: input.createdAt,
        },
      ],
      memory: {
        enabled: true,
        retentionDays: 90,
      },
      createdBy: actorId,
      createdAt: input.createdAt,
    },
    budgets: {
      warningPercent: 80,
    },
    audit: [],
  };
}

export function parseWorkspaceGovernanceProfile(value: unknown): WorkspaceGovernanceProfile {
  const profile = WorkspaceGovernanceProfileSchema.parse(value);
  const actorIds = new Set<string>();
  for (const member of profile.space.members) {
    if (actorIds.has(member.actorId)) {
      throw new Error(`Duplicate governance member "${member.actorId}"`);
    }
    actorIds.add(member.actorId);
  }
  if (!profile.space.members.some((member) => member.role === 'owner')) {
    throw new Error('Governance requires at least one owner');
  }
  const auditVerification = verifyGovernanceAudit(profile.audit as GovernanceAuditEvent[]);
  if (!auditVerification.valid) {
    throw new Error(`Governance audit chain is invalid at sequence ${auditVerification.invalidSequence ?? 'unknown'}`);
  }
  return profile;
}

function memberMap(members: readonly SpaceMember[]): Map<string, SpaceMember> {
  return new Map(members.map((member) => [member.actorId, member]));
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

export function applyWorkspaceGovernanceUpdate(
  currentValue: unknown,
  updateValue: unknown,
  actorId: string,
  timestamp = new Date().toISOString(),
): WorkspaceGovernanceProfile {
  const current = parseWorkspaceGovernanceProfile(currentValue);
  const update = WorkspaceGovernanceMutableSchema.parse(updateValue);
  const nextMembers = update.members.map((member) => ({ ...member }));
  if (!nextMembers.some((member) => member.role === 'owner')) {
    throw new Error('Governance requires at least one owner');
  }
  if (!nextMembers.some((member) => member.actorId === current.space.createdBy && member.role === 'owner')) {
    throw new Error('The local workspace owner cannot be removed or demoted');
  }

  const currentMembers = memberMap(current.space.members as SpaceMember[]);
  const proposedMembers = memberMap(nextMembers as SpaceMember[]);
  if (currentMembers.size !== proposedMembers.size || stable(current.space.members) !== stable(nextMembers)) {
    for (const [memberId, proposed] of proposedMembers) {
      const previous = currentMembers.get(memberId);
      if (!previous || previous.role !== proposed.role) {
        if (!canAssignSpaceRole(current.space as SpaceManifest, actorId, proposed.role)) {
          throw new Error(`Actor "${actorId}" cannot assign role "${proposed.role}"`);
        }
      }
    }
    for (const [memberId, previous] of currentMembers) {
      if (!proposedMembers.has(memberId) && !canAssignSpaceRole(current.space as SpaceManifest, actorId, previous.role)) {
        throw new Error(`Actor "${actorId}" cannot remove role "${previous.role}"`);
      }
    }
  }

  const memoryChanged = stable(current.space.memory) !== stable(update.memory);
  const budgetsChanged = stable(current.budgets) !== stable(update.budgets);
  if ((memoryChanged || budgetsChanged) && !authorizeSpaceAction(current.space as SpaceManifest, actorId, 'policy.update')) {
    throw new Error(`Actor "${actorId}" cannot update governance policies`);
  }

  const audit = current.audit.map((event) => ({ ...event })) as GovernanceAuditEvent[];
  if (stable(current.space.members) !== stable(nextMembers)) {
    appendGovernanceAudit(audit, {
      spaceId: current.space.id,
      action: 'member.role.changed',
      actorId,
      targetId: 'members',
      details: stable(nextMembers),
      timestamp,
    });
  }
  if (memoryChanged) {
    appendGovernanceAudit(audit, {
      spaceId: current.space.id,
      action: 'policy.versioned',
      actorId,
      targetId: 'memory-retention',
      details: stable(update.memory),
      timestamp,
    });
  }
  if (budgetsChanged) {
    appendGovernanceAudit(audit, {
      spaceId: current.space.id,
      action: 'policy.versioned',
      actorId,
      targetId: 'mission-budgets',
      details: stable(update.budgets),
      timestamp,
    });
  }

  return parseWorkspaceGovernanceProfile({
    schemaVersion: 1,
    space: {
      ...current.space,
      members: nextMembers,
      memory: update.memory,
    },
    budgets: update.budgets,
    audit,
  });
}
