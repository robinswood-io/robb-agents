import { createHash, randomUUID } from 'node:crypto';

export const SPACE_KINDS = ['personal', 'team', 'client'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

export const SPACE_ROLES = ['owner', 'admin', 'operator', 'validator', 'reader'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const SPACE_ACTIONS = [
  'space.read',
  'space.manage-members',
  'policy.read',
  'policy.update',
  'playbook.read',
  'playbook.update',
  'connection.read',
  'connection.update',
  'mission.read',
  'mission.run',
  'mission.approve',
  'mission.cancel',
  'memory.read',
  'memory.write',
  'memory.export',
  'memory.delete',
  'audit.read',
] as const;
export type SpaceAction = (typeof SPACE_ACTIONS)[number];

const READER_ACTIONS = new Set<SpaceAction>([
  'space.read',
  'policy.read',
  'playbook.read',
  'connection.read',
  'mission.read',
  'memory.read',
  'audit.read',
]);

const ROLE_ACTIONS: Record<SpaceRole, ReadonlySet<SpaceAction>> = {
  reader: READER_ACTIONS,
  validator: new Set([...READER_ACTIONS, 'mission.approve']),
  operator: new Set([...READER_ACTIONS, 'mission.run', 'mission.cancel', 'memory.write']),
  admin: new Set([
    ...SPACE_ACTIONS.filter((action) => action !== 'space.manage-members'),
  ]),
  owner: new Set(SPACE_ACTIONS),
};

export interface SpaceMember {
  actorId: string;
  role: SpaceRole;
  assignedBy: string;
  assignedAt: string;
}

export interface SpaceManifest {
  schemaVersion: 1;
  id: string;
  kind: SpaceKind;
  name: string;
  members: SpaceMember[];
  memory: {
    enabled: boolean;
    retentionDays: number;
  };
  createdBy: string;
  createdAt: string;
}

export function authorizeSpaceAction(space: SpaceManifest, actorId: string, action: SpaceAction): boolean {
  const role = space.members.find((member) => member.actorId === actorId)?.role;
  return role ? ROLE_ACTIONS[role].has(action) : false;
}

export function assertSpaceAction(space: SpaceManifest, actorId: string, action: SpaceAction): void {
  if (!authorizeSpaceAction(space, actorId, action)) {
    throw new Error(`Actor "${actorId}" is not authorized for "${action}" in space "${space.id}"`);
  }
}

/** Admins can manage non-owner memberships; only an owner can assign or remove an owner. */
export function canAssignSpaceRole(space: SpaceManifest, actorId: string, role: SpaceRole): boolean {
  const actorRole = space.members.find((member) => member.actorId === actorId)?.role;
  if (actorRole === 'owner') return true;
  return actorRole === 'admin' && role !== 'owner';
}

export type GovernedResourceKind = 'policy' | 'playbook' | 'connection';

export interface VersionedSpaceResource {
  id: string;
  spaceId: string;
  kind: GovernedResourceKind;
  version: number;
  contentHash: string;
  authorId: string;
  createdAt: string;
  previousVersionHash?: string;
}

export function versionSpaceResource(input: {
  id: string;
  spaceId: string;
  kind: GovernedResourceKind;
  content: string;
  authorId: string;
  createdAt?: string;
  previous?: VersionedSpaceResource;
}): VersionedSpaceResource {
  if (input.previous && (input.previous.id !== input.id || input.previous.spaceId !== input.spaceId || input.previous.kind !== input.kind)) {
    throw new Error('A governed resource version must keep the same id, space, and kind');
  }
  return {
    id: input.id,
    spaceId: input.spaceId,
    kind: input.kind,
    version: (input.previous?.version ?? 0) + 1,
    contentHash: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    authorId: input.authorId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.previous ? { previousVersionHash: input.previous.contentHash } : {}),
  };
}

export type MemorySensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

export interface MemoryProvenance {
  sourceType: 'user' | 'session' | 'mission' | 'document' | 'import';
  sourceId: string;
  authorId: string;
  createdAt: string;
}

export interface SpaceMemoryEntry {
  id: string;
  spaceId: string;
  content: string;
  sensitivity: MemorySensitivity;
  provenance: MemoryProvenance;
  retentionUntil: string;
  /** Opaque credential references only. Secret values are never part of the memory model. */
  secretReferenceIds: string[];
}

const SECRET_PATTERNS = [
  /\b(?:sk|sk-proj|sk-ant|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}\b/gi,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
  /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^@\s]+@/gi,
] as const;

export function redactSecretLikeMaterial(content: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, '[REDACTED]'), content);
}

export function createSpaceMemoryEntry(input: {
  spaceId: string;
  content: string;
  sensitivity: MemorySensitivity;
  provenance: Omit<MemoryProvenance, 'createdAt'> & { createdAt?: string };
  retentionDays: number;
  secretReferenceIds?: string[];
  id?: string;
}): SpaceMemoryEntry {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1) {
    throw new Error('Memory retentionDays must be a positive integer');
  }
  const createdAt = input.provenance.createdAt ?? new Date().toISOString();
  const retentionUntil = new Date(Date.parse(createdAt) + input.retentionDays * 86_400_000).toISOString();
  return {
    id: input.id ?? randomUUID(),
    spaceId: input.spaceId,
    content: redactSecretLikeMaterial(input.content),
    sensitivity: input.sensitivity,
    provenance: {
      sourceType: input.provenance.sourceType,
      sourceId: input.provenance.sourceId,
      authorId: input.provenance.authorId,
      createdAt,
    },
    retentionUntil,
    secretReferenceIds: [...(input.secretReferenceIds ?? [])],
  };
}

export function activeSpaceMemory(
  space: SpaceManifest,
  entries: SpaceMemoryEntry[],
  now = new Date(),
): SpaceMemoryEntry[] {
  if (!space.memory.enabled) return [];
  const timestamp = now.getTime();
  return entries.filter((entry) => entry.spaceId === space.id && Date.parse(entry.retentionUntil) > timestamp);
}

export interface ExportedMemoryEntry {
  id: string;
  content: string;
  sensitivity: MemorySensitivity;
  provenance: MemoryProvenance;
  retentionUntil: string;
}

export function exportSpaceMemory(
  space: SpaceManifest,
  actorId: string,
  entries: SpaceMemoryEntry[],
  now = new Date(),
): ExportedMemoryEntry[] {
  assertSpaceAction(space, actorId, 'memory.export');
  return activeSpaceMemory(space, entries, now).map((entry) => ({
    id: entry.id,
    content: redactSecretLikeMaterial(entry.content),
    sensitivity: entry.sensitivity,
    provenance: entry.provenance,
    retentionUntil: entry.retentionUntil,
  }));
}

export function purgeSpaceMemory(
  space: SpaceManifest,
  actorId: string,
  entries: SpaceMemoryEntry[],
  entryIds?: string[],
): { kept: SpaceMemoryEntry[]; purgedIds: string[] } {
  assertSpaceAction(space, actorId, 'memory.delete');
  const targets = entryIds ? new Set(entryIds) : null;
  const purgedIds: string[] = [];
  const kept = entries.filter((entry) => {
    const purge = entry.spaceId === space.id && (!targets || targets.has(entry.id));
    if (purge) purgedIds.push(entry.id);
    return !purge;
  });
  return { kept, purgedIds };
}

export type GovernanceAuditAction =
  | 'member.role.changed'
  | 'policy.versioned'
  | 'playbook.versioned'
  | 'connection.versioned'
  | 'memory.exported'
  | 'memory.purged';

export interface GovernanceAuditEvent {
  sequence: number;
  spaceId: string;
  action: GovernanceAuditAction;
  actorId: string;
  targetId: string;
  timestamp: string;
  detailsHash: string;
  previousHash: string;
  hash: string;
}

function auditEventHash(event: Omit<GovernanceAuditEvent, 'hash'>): string {
  const canonical = [
    event.sequence,
    event.spaceId,
    event.action,
    event.actorId,
    event.targetId,
    event.timestamp,
    event.detailsHash,
    event.previousHash,
  ].join('\u001f');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function appendGovernanceAudit(
  events: GovernanceAuditEvent[],
  input: {
    spaceId: string;
    action: GovernanceAuditAction;
    actorId: string;
    targetId: string;
    details: string;
    timestamp?: string;
  },
): GovernanceAuditEvent {
  const base: Omit<GovernanceAuditEvent, 'hash'> = {
    sequence: events.length + 1,
    spaceId: input.spaceId,
    action: input.action,
    actorId: input.actorId,
    targetId: input.targetId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    detailsHash: createHash('sha256').update(input.details, 'utf8').digest('hex'),
    previousHash: events.at(-1)?.hash ?? 'GENESIS',
  };
  const event = { ...base, hash: auditEventHash(base) };
  events.push(event);
  return event;
}

export function verifyGovernanceAudit(events: GovernanceAuditEvent[]): {
  valid: boolean;
  invalidSequence?: number;
} {
  let previousHash = 'GENESIS';
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    const { hash, ...base } = event;
    if (event.sequence !== index + 1 || event.previousHash !== previousHash || auditEventHash(base) !== hash) {
      return { valid: false, invalidSequence: event.sequence };
    }
    previousHash = hash;
  }
  return { valid: true };
}
