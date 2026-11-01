import { createHash } from "node:crypto";
import { z } from "zod";
import type { MeshIdentity, VerifiedFederatedClaims } from './contracts.ts';
import { MeshIdentitySchema, VerifiedMachineCapabilityAttestationSchema } from './contracts.ts';
import { sha256 } from './mission-queue.ts';

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
