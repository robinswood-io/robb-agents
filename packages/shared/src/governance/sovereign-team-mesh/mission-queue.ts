import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "../../utils/files.ts";
import type { MeshIdentity, MeshIdentityResolver, MeshMachineIdentity, MeshMissionLease, MeshSnapshot, MissionQueueEnqueueInput, MissionQueueEnvelope, TrustedHumanIdentityResolver, TrustedMachineCapabilityResolver, VerifiedMachineCapabilityAttestation } from './contracts.ts';
import { LOCK_STALE_MS, MAX_LEASE_MS, MeshClaimInputSchema, MeshIdentitySchema, MeshSnapshotSchema, MissionQueueEnqueueInputSchema, MissionQueueEnvelopeSchema, QueueRecordSchema, VerifiedMachineCapabilityAttestationSchema } from './contracts.ts';

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

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
