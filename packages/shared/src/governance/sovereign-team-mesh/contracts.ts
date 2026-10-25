import { z } from "zod";

const SHA256 = /^[a-f0-9]{64}$/;

export const MAX_LEASE_MS = 60_000;

export const LOCK_STALE_MS = 30_000;

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

export const MeshClaimInputSchema = z.object({
  missionId: z.string().min(1),
  machineIdentityId: z.string().min(1),
  hostId: z.string().min(1),
  ttlMs: z.number().int().positive().max(MAX_LEASE_MS),
}).strict();

export const QueueRecordSchema = z.object({
  envelope: MissionQueueEnvelopeSchema,
  status: z.enum(['queued', 'leased', 'completed', 'cancelled']),
  lastFencingToken: z.number().int().nonnegative(),
  lease: MeshLeaseSchema.optional(),
  completedAt: z.string().datetime().optional(),
}).strict();

export const MeshSnapshotSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  records: z.record(z.string(), QueueRecordSchema),
  revokedIdentityIds: z.record(z.string(), z.string().datetime()),
}).strict();

export type MeshSnapshot = z.infer<typeof MeshSnapshotSchema>;
