import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MissionQueueEnqueueInputSchema,
  SovereignMissionQueue,
  delegateMissionAgentIdentity,
  identityFromVerifiedDeviceAttestation,
  identityFromVerifiedFederation,
  type MeshIdentity,
  type MeshMissionLease,
  type MissionQueueEnqueueInput,
  type VerifiedMachineCapabilityAttestation,
} from './sovereign-team-mesh.ts';

const hash = 'a'.repeat(64);
const machine = (
  id: string,
  hostId: string,
  capabilities: string[] | null = ['local-files'],
): Extract<MeshIdentity, { kind: 'machine' }> => ({
  kind: 'machine', id, tenantId: 'tenant-1', hostId,
  publicKeySha256: hash, active: true,
  ...(capabilities !== null ? {
    capabilityAttestation: {
      schemaVersion: 1, verificationStatus: 'verified', source: 'device-attestation',
      machineIdentityId: id, hostId, capabilities, verifierKeyId: 'device-attestor-key-1',
      verifiedAt: '2026-08-20T09:00:00.000Z', expiresAt: '2026-08-20T12:00:00.000Z',
    },
  } : {}),
});

function human(
  id = 'human-trusted',
  options: { tenantId?: string; active?: boolean; expiresAt?: string } = {},
): MeshIdentity {
  return {
    kind: 'human', id, tenantId: options.tenantId ?? 'tenant-1', active: options.active ?? true,
    federation: {
      protocol: 'oidc', issuer: 'https://idp.example', subject: id, verifierKeyId: 'idp-key-1',
      verifiedAt: '2026-08-20T09:00:00.000Z', expiresAt: options.expiresAt ?? '2026-08-20T12:00:00.000Z',
    },
  };
}

function enqueueInput(id = 'mission-1') {
  return MissionQueueEnqueueInputSchema.parse({
    schemaVersion: 1, missionId: id, workspaceId: 'workspace-1', tenantId: 'tenant-1',
    createdAt: '2026-08-20T10:00:00.000Z', priority: 50,
    requiredCapabilities: ['local-files'], dataResidencyHostIds: ['host-a', 'host-b'],
    missionSpecSha256: hash, containsBusinessContent: false,
  });
}

const leaseOperations = [
  {
    name: 'heartbeat',
    invoke: (queue: SovereignMissionQueue, missionId: string, lease: MeshMissionLease) => {
      queue.heartbeat(missionId, lease, 1_000);
    },
  },
  {
    name: 'assertFence',
    invoke: (queue: SovereignMissionQueue, missionId: string, lease: MeshMissionLease) => {
      queue.assertFence(missionId, lease);
    },
  },
  {
    name: 'release',
    invoke: (queue: SovereignMissionQueue, missionId: string, lease: MeshMissionLease) => {
      queue.release(missionId, lease, 'retry');
    },
  },
] as const;

describe('Sovereign Team Mesh', () => {
  it('maps only verified, audience-bound, unexpired federation claims', () => {
    expect(identityFromVerifiedFederation({
      verificationStatus: 'verified', protocol: 'oidc', tenantId: 'tenant-1', issuer: 'https://idp.example',
      subject: 'user-1', audience: 'robb', verifierKeyId: 'idp-key-1',
      verifiedAt: '2026-08-20T10:00:00.000Z', expiresAt: '2026-08-20T12:00:00.000Z',
    }, 'robb', new Date('2026-08-20T11:00:00.000Z'))).toMatchObject({ kind: 'human', active: true });
    expect(() => identityFromVerifiedFederation({
      verificationStatus: 'verified', protocol: 'saml', tenantId: 'tenant-1', issuer: 'idp', subject: 'user',
      audience: 'wrong', verifierKeyId: 'key', verifiedAt: '2026-08-20T10:00:00.000Z', expiresAt: '2026-08-20T12:00:00.000Z',
    }, 'robb', new Date('2026-08-20T11:00:00.000Z'))).toThrow(/audience/);
    const attested = identityFromVerifiedDeviceAttestation({
      attestationVerified: true, tenantId: 'tenant-1', machineId: 'machine-1', hostId: 'host-a',
      publicKeySpki: new Uint8Array(64).fill(7),
      attestedCapabilities: ['local-files'], capabilityVerifierKeyId: 'device-attestor-key-1',
      capabilitiesVerifiedAt: '2026-08-20T10:00:00.000Z',
      capabilitiesExpiresAt: '2026-08-20T12:00:00.000Z',
    });
    expect(delegateMissionAgentIdentity({
      agentId: 'agent-1', tenantId: 'tenant-1', missionId: 'mission-1', delegatedBy: attested,
      expiresAt: '2026-08-20T12:00:00.000Z', now: new Date('2026-08-20T11:00:00.000Z'),
    })).toMatchObject({ kind: 'agent', delegatedByIdentityId: 'machine-1', missionId: 'mission-1' });
  });

  it('keeps the queue metadata-only and fences failover across two data-local hosts', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-team-mesh-'));
    let now = Date.parse('2026-08-20T10:00:00.000Z');
    const identities = new Map<string, MeshIdentity>([
      ['machine-a', machine('machine-a', 'host-a')],
      ['machine-b', machine('machine-b', 'host-b')],
    ]);
    const queue = new SovereignMissionQueue(
      join(root, '.robb', 'mesh.json'),
      (identityId) => identities.get(identityId) ?? null,
      () => human(),
      () => now,
    );
    queue.enqueue(enqueueInput());
    const first = queue.claim({ missionId: 'mission-1', machineIdentityId: 'machine-a', hostId: 'host-a', ttlMs: 1_000 });
    now += 1_001;
    const failover = queue.claim({ missionId: 'mission-1', machineIdentityId: 'machine-b', hostId: 'host-b', ttlMs: 1_000 });
    expect(failover.fencingToken).toBe(first.fencingToken + 1);
    expect(() => queue.assertFence('mission-1', first)).toThrow(/fence|expired/);
    queue.assertFence('mission-1', failover);
    expect(queue.list()[0]?.envelope).not.toHaveProperty('objective');
    expect(() => MissionQueueEnqueueInputSchema.parse({
      ...enqueueInput('bad'), objective: 'sensitive content',
    })).toThrow();
    expect(() => queue.claim({
      missionId: 'mission-1', machineIdentityId: 'machine-a', hostId: 'host-b', ttlMs: 1_000,
    })).toThrow(/host/);
    expect(() => queue.claim({
      missionId: 'mission-1', machineIdentityId: 'unregistered', hostId: 'host-a', ttlMs: 1_000,
    })).toThrow(/not registered/);
  });

  it('fails closed on absent or insufficient capabilities and accepts exact or superset attestations', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-team-mesh-capabilities-'));
    const now = Date.parse('2026-08-20T10:00:00.000Z');
    const makeQueue = (
      missionId: string,
      resolvedMachine: MeshIdentity,
      resolveCapabilities?: () => VerifiedMachineCapabilityAttestation | null,
    ) => {
      const queue = new SovereignMissionQueue(
        join(root, `${missionId}.json`),
        (identityId) => identityId === resolvedMachine.id ? resolvedMachine : null,
        () => human(),
        () => now,
        resolveCapabilities ? () => resolveCapabilities() : undefined,
      );
      queue.enqueue(enqueueInput(missionId));
      return queue;
    };

    const absent = makeQueue('capability-absent', machine('machine-absent', 'host-a', null));
    expect(() => absent.claim({
      missionId: 'capability-absent', machineIdentityId: 'machine-absent', hostId: 'host-a', ttlMs: 1_000,
    })).toThrow(/unavailable/);

    const insufficient = makeQueue('capability-insufficient', machine('machine-insufficient', 'host-a', ['network']));
    expect(() => insufficient.claim({
      missionId: 'capability-insufficient', machineIdentityId: 'machine-insufficient', hostId: 'host-a', ttlMs: 1_000,
    })).toThrow(/do not satisfy/);

    const exact = makeQueue('capability-exact', machine('machine-exact', 'host-a', ['local-files']));
    expect(exact.claim({
      missionId: 'capability-exact', machineIdentityId: 'machine-exact', hostId: 'host-a', ttlMs: 1_000,
    })).toMatchObject({ ownerIdentityId: 'machine-exact', hostId: 'host-a' });

    const superset = makeQueue(
      'capability-superset',
      machine('machine-superset', 'host-a', ['local-files', 'network', 'gpu']),
    );
    expect(superset.claim({
      missionId: 'capability-superset', machineIdentityId: 'machine-superset', hostId: 'host-a', ttlMs: 1_000,
    })).toMatchObject({ ownerIdentityId: 'machine-superset', hostId: 'host-a' });
  });

  it('treats a configured host capability resolver as authoritative and never delegates a machine lease to an agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-team-mesh-host-capabilities-'));
    const now = Date.parse('2026-08-20T10:00:00.000Z');
    const embedded = machine('machine-host-resolved', 'host-a', ['network']);
    const hostAttestation: VerifiedMachineCapabilityAttestation = {
      schemaVersion: 1, verificationStatus: 'verified', source: 'host-resolver',
      machineIdentityId: 'machine-host-resolved', hostId: 'host-a', capabilities: ['local-files'],
      verifierKeyId: 'host-capability-key-1', verifiedAt: '2026-08-20T09:00:00.000Z',
      expiresAt: '2026-08-20T12:00:00.000Z',
    };
    const resolvedQueue = new SovereignMissionQueue(
      join(root, 'resolved.json'),
      (identityId) => identityId === embedded.id ? embedded : null,
      () => human(),
      () => now,
      () => hostAttestation,
    );
    resolvedQueue.enqueue(enqueueInput('host-resolved'));
    expect(resolvedQueue.claim({
      missionId: 'host-resolved', machineIdentityId: embedded.id, hostId: 'host-a', ttlMs: 1_000,
    })).toMatchObject({ ownerIdentityId: embedded.id });

    const denyQueue = new SovereignMissionQueue(
      join(root, 'resolver-deny.json'),
      (identityId) => identityId === embedded.id ? machine(embedded.id, 'host-a', ['local-files']) : null,
      () => human(),
      () => now,
      () => null,
    );
    denyQueue.enqueue(enqueueInput('resolver-deny'));
    expect(() => denyQueue.claim({
      missionId: 'resolver-deny', machineIdentityId: embedded.id, hostId: 'host-a', ttlMs: 1_000,
    })).toThrow(/unavailable/);

    const delegatedAgent = delegateMissionAgentIdentity({
      agentId: 'agent-delegated', tenantId: 'tenant-1', missionId: 'delegated-agent',
      delegatedBy: machine('machine-delegator', 'host-a', ['local-files']),
      expiresAt: '2026-08-20T11:00:00.000Z', now: new Date(now),
    });
    const delegatedQueue = new SovereignMissionQueue(
      join(root, 'delegated.json'),
      (identityId) => identityId === delegatedAgent.id ? delegatedAgent : null,
      () => human(),
      () => now,
    );
    delegatedQueue.enqueue(enqueueInput('delegated-agent'));
    expect(() => delegatedQueue.claim({
      missionId: 'delegated-agent', machineIdentityId: delegatedAgent.id, hostId: 'host-a', ttlMs: 1_000,
    })).toThrow(/Only an attested machine/);
  });

  for (const operation of leaseOperations) {
    it(`${operation.name} re-resolves and revalidates the machine identity at operation time`, () => {
      const root = mkdtempSync(join(tmpdir(), `robb-team-mesh-${operation.name}-identity-`));
      const now = Date.parse('2026-08-20T10:00:00.000Z');
      const missionId = `${operation.name}-identity`;
      const eligible = machine('machine-live', 'host-a');
      let resolved: MeshIdentity | null = eligible;
      const queue = new SovereignMissionQueue(
        join(root, 'mesh.json'),
        () => resolved,
        () => human(),
        () => now,
      );
      queue.enqueue(enqueueInput(missionId));
      const lease = queue.claim({
        missionId, machineIdentityId: eligible.id, hostId: 'host-a', ttlMs: 5_000,
      });

      resolved = null;
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/not registered/);
      resolved = machine('machine-substituted', 'host-a');
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/binding/);
      resolved = { ...eligible, active: false };
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/inactive/);
      resolved = { ...eligible, tenantId: 'tenant-2' };
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/tenant/);
      resolved = machine(eligible.id, 'host-b');
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/host/);
      resolved = machine(eligible.id, 'host-a', ['network']);
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/do not satisfy/);
      resolved = eligible;
      expect(() => operation.invoke(queue, missionId, lease)).not.toThrow();
    });

    it(`${operation.name} rejects capability resolver withdrawal, expiry and identity revocation`, () => {
      const root = mkdtempSync(join(tmpdir(), `robb-team-mesh-${operation.name}-trust-`));
      let now = Date.parse('2026-08-20T10:00:00.000Z');
      const missionId = `${operation.name}-trust`;
      const eligible = machine('machine-trust', 'host-a', ['network']);
      let attestation: VerifiedMachineCapabilityAttestation | null = {
        schemaVersion: 1, verificationStatus: 'verified', source: 'host-resolver',
        machineIdentityId: eligible.id, hostId: 'host-a', capabilities: ['local-files'],
        verifierKeyId: 'host-key-1', verifiedAt: '2026-08-20T09:00:00.000Z',
        expiresAt: '2026-08-20T10:00:01.000Z',
      };
      const queue = new SovereignMissionQueue(
        join(root, 'mesh.json'),
        () => eligible,
        () => human(),
        () => now,
        () => attestation,
      );
      queue.enqueue(enqueueInput(missionId));
      const lease = queue.claim({
        missionId, machineIdentityId: eligible.id, hostId: 'host-a', ttlMs: 5_000,
      });

      attestation = null;
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/unavailable/);
      attestation = {
        schemaVersion: 1, verificationStatus: 'verified', source: 'host-resolver',
        machineIdentityId: eligible.id, hostId: 'host-a', capabilities: ['network'],
        verifierKeyId: 'host-key-1', verifiedAt: '2026-08-20T09:00:00.000Z',
        expiresAt: '2026-08-20T10:00:01.000Z',
      };
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/do not satisfy/);
      attestation = {
        ...attestation,
        capabilities: ['local-files'],
      };
      now = Date.parse('2026-08-20T10:00:01.000Z');
      expect(() => operation.invoke(queue, missionId, lease)).toThrow(/expired/);

      const revokedMissionId = `${operation.name}-revoked`;
      now = Date.parse('2026-08-20T10:00:00.000Z');
      attestation = {
        ...attestation,
        expiresAt: '2026-08-20T10:01:00.000Z',
      };
      queue.enqueue(enqueueInput(revokedMissionId));
      const revokedLease = queue.claim({
        missionId: revokedMissionId, machineIdentityId: eligible.id, hostId: 'host-a', ttlMs: 5_000,
      });
      queue.revokeIdentity(eligible.id);
      expect(() => operation.invoke(queue, revokedMissionId, revokedLease)).toThrow(/revoked/);
    });
  }

  it('refuses a heartbeat whose requested lease would outlive the capability attestation', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-team-mesh-heartbeat-attestation-bound-'));
    let now = Date.parse('2026-08-20T10:00:00.000Z');
    const baseIdentity = machine('machine-bounded', 'host-a');
    const eligible: Extract<MeshIdentity, { kind: 'machine' }> = {
      ...baseIdentity,
      capabilityAttestation: {
        ...baseIdentity.capabilityAttestation!,
        expiresAt: '2026-08-20T10:00:45.000Z',
      },
    };
    const queue = new SovereignMissionQueue(
      join(root, 'mesh.json'),
      () => eligible,
      () => human(),
      () => now,
    );
    queue.enqueue(enqueueInput('heartbeat-bounded'));
    const lease = queue.claim({
      missionId: 'heartbeat-bounded', machineIdentityId: eligible.id, hostId: 'host-a', ttlMs: 30_000,
    });
    now += 10_000;
    expect(() => queue.heartbeat('heartbeat-bounded', lease, 60_000)).toThrow(/attestation lifetime/);
    const renewed = queue.heartbeat('heartbeat-bounded', lease, 30_000);
    expect(renewed.expiresAt).toBe('2026-08-20T10:00:40.000Z');
  });

  it('produces no duplicate fencing token across 1,000 failovers and revokes immediately', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-team-mesh-failover-'));
    let now = Date.parse('2026-08-20T10:00:00.000Z');
    const identities = new Map<string, MeshIdentity>([
      ['machine-a', machine('machine-a', 'host-a')],
      ['machine-b', machine('machine-b', 'host-b')],
    ]);
    const queue = new SovereignMissionQueue(
      join(root, 'mesh.json'),
      (identityId) => identities.get(identityId) ?? null,
      () => human(),
      () => now,
    );
    queue.enqueue(enqueueInput());
    const tokens = new Set<number>();
    let last;
    for (let index = 0; index < 1_000; index += 1) {
      const host = index % 2 === 0 ? 'host-a' : 'host-b';
      const machineIdentityId = host === 'host-a' ? 'machine-a' : 'machine-b';
      last = queue.claim({ missionId: 'mission-1', machineIdentityId, hostId: host, ttlMs: 1 });
      tokens.add(last.fencingToken);
      now += 2;
    }
    expect(tokens.size).toBe(1_000);
    queue.revokeIdentity(last!.ownerIdentityId);
    expect(() => queue.assertFence('mission-1', last!)).toThrow(/revoked/);
  });

  it('derives the durable creator only from the trusted authentication resolver', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-team-mesh-creator-'));
    const trustedCreator = human('human:canonical');
    let resolverCalls = 0;
    const queue = new SovereignMissionQueue(
      join(root, 'mesh.json'),
      () => null,
      () => {
        resolverCalls += 1;
        return trustedCreator;
      },
      () => Date.parse('2026-08-20T10:00:00.000Z'),
    );

    const compileTimeForgery: MissionQueueEnqueueInput = {
      ...enqueueInput('compile-time-forgery'),
      // @ts-expect-error The creator is resolver-derived and is not part of enqueue input.
      createdByHumanIdentityId: 'human:attacker',
    };
    void compileTimeForgery;

    expect(() => queue.enqueue({
      ...enqueueInput('runtime-forgery'),
      createdByHumanIdentityId: 'human:attacker',
    } as unknown as MissionQueueEnqueueInput)).toThrow();
    expect(resolverCalls).toBe(0);

    queue.enqueue(enqueueInput());
    expect(resolverCalls).toBe(1);
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]?.envelope.createdByHumanIdentityId).toBe('human:canonical');
  });

  it('fails closed when the trusted resolver cannot supply an eligible human', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-team-mesh-creator-denials-'));
    let resolvedCreator: MeshIdentity | null = null;
    const queue = new SovereignMissionQueue(
      join(root, 'mesh.json'),
      () => null,
      () => resolvedCreator,
      () => Date.parse('2026-08-20T10:00:00.000Z'),
    );

    expect(() => queue.enqueue(enqueueInput('missing'))).toThrow(/unavailable/);
    resolvedCreator = machine('machine-creator', 'host-a');
    expect(() => queue.enqueue(enqueueInput('machine'))).toThrow(/human/);
    resolvedCreator = human('human-inactive', { active: false });
    expect(() => queue.enqueue(enqueueInput('inactive'))).toThrow(/inactive/);
    resolvedCreator = human('human-other-tenant', { tenantId: 'tenant-2' });
    expect(() => queue.enqueue(enqueueInput('cross-tenant'))).toThrow(/tenant/);
    resolvedCreator = human('human-expired', { expiresAt: '2026-08-20T09:59:59.999Z' });
    expect(() => queue.enqueue(enqueueInput('expired'))).toThrow(/expired/);
    resolvedCreator = human('human-revoked');
    queue.revokeIdentity(resolvedCreator.id);
    expect(() => queue.enqueue(enqueueInput('revoked'))).toThrow(/revoked/);
    expect(queue.list()).toHaveLength(0);
  });
});
