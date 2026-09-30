import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/files.ts';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_LEASE_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const capability = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);

export const MeshCapabilitySetSchema = z.array(capability).max(64)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
    message: 'Mesh capabilities must be unique',
  });

export const VerifiedMachineCapabilityAttestationSchema = z.object({
  schemaVersion: z.literal(1),
  verificationStatus: z.literal('verified'),
  source: z.enum(['device-attestation', 'host-resolver']),
  machineIdentityId: z.string().min(1),
  hostId: z.string().min(1),
  capabilities: MeshCapabilitySetSchema,
  verifierKeyId: z.string().min(1),
  verifiedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
}).strict();
export type VerifiedMachineCapabilityAttestation = z.infer<
  typeof VerifiedMachineCapabilityAttestationSchema
>;

export const MeshIdentitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('human'), id: z.string().min(1), tenantId: z.string().min(1),
    displayName: z.string().min(1).optional(), active: z.boolean(),
    federation: z.object({
      protocol: z.enum(['oidc', 'saml', 'scim']), issuer: z.string().min(1), subject: z.string().min(1),
      verifierKeyId: z.string().min(1), verifiedAt: z.string().datetime(), expiresAt: z.string().datetime().optional(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('machine'), id: z.string().min(1), tenantId: z.string().min(1),
    hostId: z.string().min(1), publicKeySha256: z.string().regex(SHA256), active: z.boolean(),
    /** Optional only for legacy identity records; a capable claim fails closed without it. */
    capabilityAttestation: VerifiedMachineCapabilityAttestationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('agent'), id: z.string().min(1), tenantId: z.string().min(1),
    delegatedByIdentityId: z.string().min(1), missionId: z.string().min(1),
    expiresAt: z.string().datetime(), active: z.boolean(),
  }).strict(),
]);

export type MeshIdentity = z.infer<typeof MeshIdentitySchema>;
export type MeshIdentityResolver = (identityId: string) => MeshIdentity | null;
export type MeshMachineIdentity = Extract<MeshIdentity, { kind: 'machine' }>;
/** Trusted host boundary. When configured, null is authoritative and fails closed. */
export type TrustedMachineCapabilityResolver = (
  identity: MeshMachineIdentity,
) => VerifiedMachineCapabilityAttestation | null;
/**
 * Resolves the human bound to server-controlled authentication context.
 * It deliberately accepts no identity selector from the Mission payload.
 */
export type TrustedHumanIdentityResolver = () => MeshIdentity | null;

export interface VerifiedFederatedClaims {
  /** Must be produced only after signature, issuer, audience and nonce verification. */
  verificationStatus: 'verified';
  protocol: 'oidc' | 'saml';
  tenantId: string;
  issuer: string;
  subject: string;
  audience: string;
  verifierKeyId: string;
  verifiedAt: string;
  expiresAt: string;
  displayName?: string;
}

/** Maps already-verified assertions without accepting a raw JWT/SAML document. */
export function identityFromVerifiedFederation(
  claims: VerifiedFederatedClaims,
  expectedAudience: string,
  now = new Date(),
): MeshIdentity {
  if (claims.verificationStatus !== 'verified') throw new Error('Federated assertion is not verified');
  if (claims.audience !== expectedAudience) throw new Error('Federated assertion audience does not match');
  if (new Date(claims.expiresAt).getTime() <= now.getTime()) throw new Error('Federated assertion is expired');
  return MeshIdentitySchema.parse({
    kind: 'human',
    id: `human:${sha256(`${claims.tenantId}\0${claims.issuer}\0${claims.subject}`)}`,
    tenantId: claims.tenantId,
    displayName: claims.displayName,
    active: true,
    federation: {
      protocol: claims.protocol,
      issuer: claims.issuer,
      subject: claims.subject,
      verifierKeyId: claims.verifierKeyId,
      verifiedAt: claims.verifiedAt,
      expiresAt: claims.expiresAt,
    },
  });
}

const ScimUserSchema = z.object({
  schemas: z.array(z.string()).min(1), id: z.string().min(1), userName: z.string().min(1),
  active: z.boolean().default(true), displayName: z.string().min(1).optional(),
}).strict();

/** SCIM provisioning boundary; caller must authenticate the provisioner first. */
export function identityFromVerifiedScim(input: {
  provisionerVerified: true;
  tenantId: string;
  issuer: string;
  verifierKeyId: string;
  user: unknown;
  verifiedAt?: string;
}): MeshIdentity {
  if (input.provisionerVerified !== true) throw new Error('SCIM provisioner is not verified');
  const user = ScimUserSchema.parse(input.user);
  if (!user.schemas.includes('urn:ietf:params:scim:schemas:core:2.0:User')) {
    throw new Error('SCIM core User schema is required');
  }
  return MeshIdentitySchema.parse({
    kind: 'human', id: `human:${sha256(`${input.tenantId}\0${input.issuer}\0${user.id}`)}`,
    tenantId: input.tenantId, displayName: user.displayName ?? user.userName, active: user.active,
    federation: {
      protocol: 'scim', issuer: input.issuer, subject: user.id,
      verifierKeyId: input.verifierKeyId, verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    },
  });
}

export function identityFromVerifiedDeviceAttestation(input: {
  attestationVerified: true;
  tenantId: string;
  machineId: string;
  hostId: string;
  publicKeySpki: Uint8Array;
} & ({
  attestedCapabilities: string[];
  capabilityVerifierKeyId: string;
  capabilitiesVerifiedAt: string;
  capabilitiesExpiresAt?: string;
} | {
  /** Compatibility mapping only; capable mission claims will reject this identity. */
  attestedCapabilities?: undefined;
  capabilityVerifierKeyId?: never;
  capabilitiesVerifiedAt?: never;
  capabilitiesExpiresAt?: never;
})): MeshIdentity {
  if (input.attestationVerified !== true) throw new Error('Device attestation is not verified');
  if (input.publicKeySpki.byteLength < 32) throw new Error('Attested device public key is invalid');
  const capabilityAttestation = input.attestedCapabilities
    ? VerifiedMachineCapabilityAttestationSchema.parse({
      schemaVersion: 1,
      verificationStatus: 'verified',
      source: 'device-attestation',
      machineIdentityId: input.machineId,
      hostId: input.hostId,
      capabilities: input.attestedCapabilities,
      verifierKeyId: input.capabilityVerifierKeyId,
      verifiedAt: input.capabilitiesVerifiedAt,
      ...(input.capabilitiesExpiresAt ? { expiresAt: input.capabilitiesExpiresAt } : {}),
    })
    : undefined;
  if (capabilityAttestation?.expiresAt
    && Date.parse(capabilityAttestation.expiresAt) <= Date.parse(capabilityAttestation.verifiedAt)) {
    throw new Error('Device capability attestation expiry is invalid');
  }
  return MeshIdentitySchema.parse({
    kind: 'machine', id: input.machineId, tenantId: input.tenantId,
    hostId: input.hostId, publicKeySha256: createHash('sha256').update(input.publicKeySpki).digest('hex'),
    active: true,
    ...(capabilityAttestation ? { capabilityAttestation } : {}),
  });
}

export function delegateMissionAgentIdentity(input: {
  agentId: string;
  tenantId: string;
  missionId: string;
  delegatedBy: MeshIdentity;
  expiresAt: string;
  now?: Date;
}): MeshIdentity {
  const delegatedBy = MeshIdentitySchema.parse(input.delegatedBy);
  if (!delegatedBy.active || delegatedBy.tenantId !== input.tenantId) {
    throw new Error('Agent delegator is inactive or belongs to another tenant');
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(input.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt > now.getTime() + 24 * 60 * 60_000) {
    throw new Error('Agent delegation must expire within 24 hours');
  }
  return MeshIdentitySchema.parse({
    kind: 'agent', id: input.agentId, tenantId: input.tenantId,
    delegatedByIdentityId: delegatedBy.id, missionId: input.missionId,
    expiresAt: input.expiresAt, active: true,
  });
}

export const MissionQueueEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  missionId: z.string().min(1),
  workspaceId: z.string().min(1),
  tenantId: z.string().min(1),
  createdByHumanIdentityId: z.string().min(1),
  createdAt: z.string().datetime(),
  priority: z.number().int().min(0).max(100),
  requiredCapabilities: MeshCapabilitySetSchema,
  dataResidencyHostIds: z.array(z.string().min(1)).min(1).max(64),
  missionSpecSha256: z.string().regex(SHA256),
  containsBusinessContent: z.literal(false),
}).strict();

export type MissionQueueEnvelope = z.infer<typeof MissionQueueEnvelopeSchema>;

/** Client-facing queue input. The durable creator id is resolved out of band. */
export const MissionQueueEnqueueInputSchema = MissionQueueEnvelopeSchema
  .omit({ createdByHumanIdentityId: true })
  .strict();
export type MissionQueueEnqueueInput = z.infer<typeof MissionQueueEnqueueInputSchema>;

const MeshLeaseSchema = z.object({
  leaseId: z.string().uuid(), ownerIdentityId: z.string().min(1), hostId: z.string().min(1),
  fencingToken: z.number().int().positive(), acquiredAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
export type MeshMissionLease = z.infer<typeof MeshLeaseSchema>;

const MeshClaimInputSchema = z.object({
  missionId: z.string().min(1),
  machineIdentityId: z.string().min(1),
  hostId: z.string().min(1),
  ttlMs: z.number().int().positive().max(MAX_LEASE_MS),
}).strict();

const QueueRecordSchema = z.object({
  envelope: MissionQueueEnvelopeSchema,
  status: z.enum(['queued', 'leased', 'completed', 'cancelled']),
  lastFencingToken: z.number().int().nonnegative(),
  lease: MeshLeaseSchema.optional(),
  completedAt: z.string().datetime().optional(),
}).strict();

const MeshSnapshotSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  records: z.record(z.string(), QueueRecordSchema),
  revokedIdentityIds: z.record(z.string(), z.string().datetime()),
}).strict();
type MeshSnapshot = z.infer<typeof MeshSnapshotSchema>;

function emptySnapshot(): MeshSnapshot {
  return { schemaVersion: 1, revision: 0, records: {}, revokedIdentityIds: {} };
}

/**
 * Durable metadata-only queue with monotonic fencing tokens. Mission specs,
 * prompts, file paths and connector payloads cannot enter its strict envelope.
 */
export class SovereignMissionQueue {
  private readonly lockPath: string;

  constructor(
    private readonly path: string,
    /** Trusted identity registry populated only after federation/device verification. */
    private readonly resolveIdentity: MeshIdentityResolver,
    /** Trusted, request-scoped authentication boundary for queue creation. */
    private readonly resolveAuthenticatedHumanIdentity: TrustedHumanIdentityResolver,
    private readonly nowMs: () => number = Date.now,
    /** When supplied, this host resolver is authoritative over embedded capability attestations. */
    private readonly resolveMachineCapabilities?: TrustedMachineCapabilityResolver,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lockPath = `${path}.lock`;
  }

  enqueue(input: MissionQueueEnqueueInput): void {
    const parsed = MissionQueueEnqueueInputSchema.parse(input);
    const resolvedCreator = this.resolveAuthenticatedHumanIdentity();
    if (!resolvedCreator) throw new Error('Authenticated human identity is unavailable');
    const creator = MeshIdentitySchema.parse(resolvedCreator);
    if (creator.kind !== 'human') throw new Error('Only an authenticated human identity may enqueue a Mission');
    if (!creator.active) throw new Error('Authenticated human identity is inactive');
    if (creator.tenantId !== parsed.tenantId) throw new Error('Authenticated human identity tenant does not match');
    if (creator.federation.expiresAt
      && new Date(creator.federation.expiresAt).getTime() <= this.nowMs()) {
      throw new Error('Authenticated human identity is expired');
    }
    const envelope = MissionQueueEnvelopeSchema.parse({
      ...parsed,
      createdByHumanIdentityId: creator.id,
    });
    this.update((snapshot) => {
      if (snapshot.revokedIdentityIds[creator.id]) throw new Error('Authenticated human identity is revoked');
      if (snapshot.records[envelope.missionId]) throw new Error(`Mission ${envelope.missionId} is already queued`);
      snapshot.records[envelope.missionId] = { envelope, status: 'queued', lastFencingToken: 0 };
    });
  }

  claim(input: {
    missionId: string;
    machineIdentityId: string;
    hostId: string;
    ttlMs: number;
  }): MeshMissionLease {
    const parsedInput = MeshClaimInputSchema.parse(input);
    const resolved = this.resolveIdentity(parsedInput.machineIdentityId);
    if (!resolved) throw new Error('Mesh machine identity is not registered');
    const identity = MeshIdentitySchema.parse(resolved);
    if (identity.kind !== 'machine') throw new Error('Only an attested machine identity may claim a Mission lease');
    if (identity.id !== parsedInput.machineIdentityId) {
      throw new Error('Resolved machine identity does not match the requested identity');
    }
    if (!identity.active) throw new Error('Mesh identity is inactive');
    if (identity.hostId !== parsedInput.hostId) throw new Error('Attested machine host does not match the lease host');
    let result!: MeshMissionLease;
    this.update((snapshot) => {
      const record = requireRecord(snapshot, parsedInput.missionId);
      if (snapshot.revokedIdentityIds[identity.id]) throw new Error('Mesh identity is revoked');
      if (identity.tenantId !== record.envelope.tenantId) throw new Error('Mesh identity tenant does not match');
      if (!record.envelope.dataResidencyHostIds.includes(parsedInput.hostId)) throw new Error('Host does not hold the mission data');
      assertRequiredMachineCapabilities(
        identity,
        record.envelope.requiredCapabilities,
        this.resolveMachineCapabilities,
        this.nowMs(),
      );
      if (record.status === 'completed' || record.status === 'cancelled') throw new Error(`Mission is ${record.status}`);
      const now = this.nowMs();
      if (record.lease && new Date(record.lease.expiresAt).getTime() > now) {
        if (record.lease.ownerIdentityId === identity.id && record.lease.hostId === parsedInput.hostId) {
          result = record.lease;
          return;
        }
        throw new Error('Mission already has an active lease');
      }
      const fencingToken = record.lastFencingToken + 1;
      const timestamp = new Date(now).toISOString();
      result = {
        leaseId: randomUUID(), ownerIdentityId: identity.id, hostId: parsedInput.hostId,
        fencingToken, acquiredAt: timestamp, heartbeatAt: timestamp,
        expiresAt: new Date(now + parsedInput.ttlMs).toISOString(),
      };
      record.status = 'leased';
      record.lastFencingToken = fencingToken;
      record.lease = result;
    });
    return result;
  }

  heartbeat(missionId: string, lease: MeshMissionLease, ttlMs: number): MeshMissionLease {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_MS) throw new Error('Heartbeat TTL is invalid');
    let result!: MeshMissionLease;
    this.update((snapshot) => {
      const record = requireRecord(snapshot, missionId);
      const now = this.nowMs();
      assertActiveLease(snapshot, record, lease, now);
      const attestation = resolveEligibleLeaseOwner(
        snapshot,
        record,
        lease,
        this.resolveIdentity,
        this.resolveMachineCapabilities,
        now,
      );
      const requestedExpiry = now + ttlMs;
      if (attestation?.expiresAt && requestedExpiry > Date.parse(attestation.expiresAt)) {
        throw new Error('Heartbeat TTL exceeds the machine capability attestation lifetime');
      }
      result = {
        ...record.lease!,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(requestedExpiry).toISOString(),
      };
      record.lease = result;
    });
    return result;
  }

  assertFence(missionId: string, lease: MeshMissionLease): void {
    const snapshot = this.read();
    const record = requireRecord(snapshot, missionId);
    const now = this.nowMs();
    assertActiveLease(snapshot, record, lease, now);
    resolveEligibleLeaseOwner(
      snapshot,
      record,
      lease,
      this.resolveIdentity,
      this.resolveMachineCapabilities,
      now,
    );
  }

  release(missionId: string, lease: MeshMissionLease, outcome: 'completed' | 'retry'): void {
    this.update((snapshot) => {
      const record = requireRecord(snapshot, missionId);
      const now = this.nowMs();
      assertActiveLease(snapshot, record, lease, now);
      resolveEligibleLeaseOwner(
        snapshot,
        record,
        lease,
        this.resolveIdentity,
        this.resolveMachineCapabilities,
        now,
      );
      record.lease = undefined;
      record.status = outcome === 'completed' ? 'completed' : 'queued';
      if (outcome === 'completed') record.completedAt = new Date(now).toISOString();
    });
  }

  revokeIdentity(identityId: string): void {
    if (!identityId.trim()) throw new Error('Identity id is required');
    this.update((snapshot) => { snapshot.revokedIdentityIds[identityId] = new Date(this.nowMs()).toISOString(); });
  }

  list(): Array<{ envelope: MissionQueueEnvelope; status: string; lease?: MeshMissionLease }> {
    const snapshot = this.read();
    return Object.values(snapshot.records)
      .map((record) => ({ envelope: record.envelope, status: record.status, lease: record.lease }))
      .sort((left, right) => right.envelope.priority - left.envelope.priority
        || left.envelope.createdAt.localeCompare(right.envelope.createdAt));
  }

  private read(): MeshSnapshot {
    if (!existsSync(this.path)) return emptySnapshot();
    return MeshSnapshotSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  private update(mutator: (snapshot: MeshSnapshot) => void): void {
    withLock(this.lockPath, () => {
      const snapshot = this.read();
      mutator(snapshot);
      snapshot.revision += 1;
      atomicWriteFileSync(this.path, `${JSON.stringify(MeshSnapshotSchema.parse(snapshot), null, 2)}\n`);
    });
  }
}

function requireRecord(snapshot: MeshSnapshot, missionId: string) {
  const record = snapshot.records[missionId];
  if (!record) throw new Error(`Mission ${missionId} is not queued`);
  return record;
}

function assertRequiredMachineCapabilities(
  identity: MeshMachineIdentity,
  requiredCapabilities: string[],
  trustedResolver: TrustedMachineCapabilityResolver | undefined,
  now: number,
): VerifiedMachineCapabilityAttestation | undefined {
  if (requiredCapabilities.length === 0) return undefined;
  let resolved: VerifiedMachineCapabilityAttestation | null | undefined;
  try {
    // A configured resolver is authoritative. Its null result must never fall
    // back to a stale capability set embedded in the identity registry.
    resolved = trustedResolver ? trustedResolver(identity) : identity.capabilityAttestation;
  } catch {
    throw new Error('Attested machine capabilities could not be resolved');
  }
  if (!resolved) throw new Error('Attested machine capabilities are unavailable');
  const parsed = VerifiedMachineCapabilityAttestationSchema.safeParse(resolved);
  if (!parsed.success) throw new Error('Attested machine capabilities are invalid');
  const attestation = parsed.data;
  if (attestation.machineIdentityId !== identity.id || attestation.hostId !== identity.hostId) {
    throw new Error('Machine capability attestation binding is invalid');
  }
  if (Date.parse(attestation.verifiedAt) > now) {
    throw new Error('Machine capability attestation is not yet valid');
  }
  if (attestation.expiresAt && Date.parse(attestation.expiresAt) <= now) {
    throw new Error('Machine capability attestation is expired');
  }
  const capabilities = new Set(attestation.capabilities);
  if (requiredCapabilities.some((required) => !capabilities.has(required))) {
    throw new Error('Attested machine capabilities do not satisfy the Mission requirements');
  }
  return attestation;
}

function resolveEligibleLeaseOwner(
  snapshot: MeshSnapshot,
  record: z.infer<typeof QueueRecordSchema>,
  lease: MeshMissionLease,
  resolveIdentity: MeshIdentityResolver,
  resolveMachineCapabilities: TrustedMachineCapabilityResolver | undefined,
  now: number,
): VerifiedMachineCapabilityAttestation | undefined {
  let resolved: MeshIdentity | null;
  try {
    resolved = resolveIdentity(lease.ownerIdentityId);
  } catch {
    throw new Error('Mesh lease owner identity could not be resolved');
  }
  if (!resolved) throw new Error('Mesh lease owner identity is not registered');
  const parsed = MeshIdentitySchema.safeParse(resolved);
  if (!parsed.success) throw new Error('Mesh lease owner identity is invalid');
  const identity = parsed.data;
  if (identity.kind !== 'machine') throw new Error('Mesh lease owner is no longer an attested machine');
  if (identity.id !== lease.ownerIdentityId) throw new Error('Mesh lease owner identity binding is invalid');
  if (!identity.active) throw new Error('Mesh lease owner identity is inactive');
  if (snapshot.revokedIdentityIds[identity.id]) throw new Error('Mesh lease owner is revoked');
  if (identity.tenantId !== record.envelope.tenantId) {
    throw new Error('Mesh lease owner tenant does not match');
  }
  if (identity.hostId !== lease.hostId) throw new Error('Mesh lease owner host does not match');
  if (!record.envelope.dataResidencyHostIds.includes(identity.hostId)) {
    throw new Error('Mesh lease owner host no longer holds the mission data');
  }
  return assertRequiredMachineCapabilities(
    identity,
    record.envelope.requiredCapabilities,
    resolveMachineCapabilities,
    now,
  );
}

function assertActiveLease(
  snapshot: MeshSnapshot,
  record: z.infer<typeof QueueRecordSchema>,
  lease: MeshMissionLease,
  now: number,
): void {
  const active = record.lease;
  if (!active
    || active.leaseId !== lease.leaseId
    || active.fencingToken !== lease.fencingToken
    || active.ownerIdentityId !== lease.ownerIdentityId
    || active.hostId !== lease.hostId) throw new Error('Mesh lease fence does not match');
  if (snapshot.revokedIdentityIds[lease.ownerIdentityId]) throw new Error('Mesh lease owner is revoked');
  if (new Date(active.expiresAt).getTime() <= now) throw new Error('Mesh lease is expired');
}

function withLock<T>(path: string, operation: () => T): T {
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { descriptor = openSync(path, 'wx', 0o600); break; } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
      } catch (nested) { if (errorCode(nested) !== 'ENOENT') throw nested; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (descriptor === undefined) throw new Error('Sovereign mission queue lock is unavailable');
  try {
    writeSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(path); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : undefined;
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
