import { KeyObject } from "node:crypto";
import { z } from "zod";

const SHA256 = /^[a-f0-9]{64}$/;

const BASE64URL_ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

const identifier = (label: string) => z.string().trim().min(1, `${label} is required`).max(256);

const version = z.string().trim().min(1).max(128);

export const LearningTrajectorySourceSchema = z.object({
  eventSha256: z.string().regex(SHA256),
  kind: z.enum(['decision', 'tool-result', 'critique', 'outcome']),
  redacted: z.literal(true),
}).strict();

export type LearningTrajectorySource = z.infer<typeof LearningTrajectorySourceSchema>;

export const LearningTrajectorySchema = z.array(LearningTrajectorySourceSchema).min(1).max(10_000)
  .superRefine((sources, ctx) => {
    const hashes = new Set<string>();
    for (let index = 0; index < sources.length; index += 1) {
      const hash = sources[index]!.eventSha256;
      if (hashes.has(hash)) {
        ctx.addIssue({ code: 'custom', path: [index, 'eventSha256'], message: 'Learning trajectory hashes must be unique' });
      }
      hashes.add(hash);
    }
  });

export const VerifiedLearningProposalSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: identifier('Proposal id'),
  workspaceId: identifier('Workspace id'),
  artifact: z.object({
    kind: z.enum(['playbook', 'skill']),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(128),
    baseVersion: version,
    candidateVersion: version,
    candidateContentSha256: z.string().regex(SHA256),
  }).strict().refine((artifact) => artifact.baseVersion !== artifact.candidateVersion, {
    message: 'Candidate version must differ from base version', path: ['candidateVersion'],
  }),
  provenance: z.object({
    missionId: identifier('Mission id'),
    proofPassportId: identifier('Proof Passport id'),
    proofPassportSha256: z.string().regex(SHA256),
    trajectory: LearningTrajectorySchema,
  }).strict(),
  privacy: z.object({
    redacted: z.literal(true),
    secretScanPassed: z.literal(true),
    candidateContentStored: z.literal(false),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict();

export type VerifiedLearningProposal = z.infer<typeof VerifiedLearningProposalSchema>;

export type VerifiedLearningAction =
  | 'proposed'
  | 'eval-passed'
  | 'human-approved'
  | 'canary-passed'
  | 'canary-failed'
  | 'rolled-back'
  | 'revoked';

const LearningSignatureSchema = z.object({
  algorithm: z.literal('Ed25519'),
  keyId: identifier('Learning key id'),
  value: z.string().regex(BASE64URL_ED25519_SIGNATURE),
}).strict();

const LearningEventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  proposalId: identifier('Proposal id'),
  actorId: identifier('Actor id'),
  occurredAt: z.string().datetime(),
  previousHash: z.string().regex(SHA256).nullable(),
  signature: LearningSignatureSchema,
}).strict();

export const VerifiedLearningEventSchema = z.discriminatedUnion('action', [
  LearningEventBaseSchema.extend({
    action: z.literal('proposed'),
    payload: z.object({ proposal: VerifiedLearningProposalSchema }).strict(),
  }),
  LearningEventBaseSchema.extend({
    action: z.literal('eval-passed'),
    payload: z.object({
      evalRunId: identifier('Eval run id'),
      evalReportSha256: z.string().regex(SHA256),
      baselineRunId: identifier('Baseline run id').optional(),
      passRate: z.number().min(0).max(1),
      policyComplianceRate: z.number().min(0).max(1),
    }).strict(),
  }),
  LearningEventBaseSchema.extend({
    action: z.literal('human-approved'),
    payload: z.object({
      reviewerId: identifier('Reviewer id'),
      reviewerIdentitySha256: z.string().regex(SHA256),
      rationaleSha256: z.string().regex(SHA256),
    }).strict(),
  }),
  LearningEventBaseSchema.extend({
    action: z.union([z.literal('canary-passed'), z.literal('canary-failed')]),
    payload: z.object({
      tokenReduction: z.number().finite(),
      interventionReduction: z.number().finite(),
      qualityRegression: z.number().finite(),
      securityViolations: z.number().int().nonnegative(),
    }).strict(),
  }),
  LearningEventBaseSchema.extend({
    action: z.union([z.literal('rolled-back'), z.literal('revoked')]),
    payload: z.object({ reasonSha256: z.string().regex(SHA256) }).strict(),
  }),
]);

export type VerifiedLearningEvent = z.infer<typeof VerifiedLearningEventSchema>;

export interface LearningEventSigner {
  actorId: string;
  keyId: string;
  privateKey: KeyObject | string | Uint8Array;
}

export type LearningKeyResolver = (keyId: string, actorId: string) => KeyObject | null;

export const LearningActorRoleSchema = z.enum(['proposer', 'evaluator', 'reviewer', 'operator']);

export type LearningActorRole = z.infer<typeof LearningActorRoleSchema>;

const LearningIdentityBaseSchema = z.object({
  verificationStatus: z.literal('host-resolved'),
  actorId: identifier('Actor id'),
  workspaceId: identifier('Workspace id'),
  active: z.boolean(),
  keyIds: z.array(identifier('Learning key id')).min(1).max(16)
    .refine((keyIds) => new Set(keyIds).size === keyIds.length, 'Learning identity key ids must be unique'),
}).strict();

export const HostVerifiedLearningIdentitySchema = z.discriminatedUnion('kind', [
  LearningIdentityBaseSchema.extend({
    kind: z.literal('human'),
    role: LearningActorRoleSchema,
    humanAuthentication: z.object({
      assurance: z.literal('host-attested'),
      verifierId: identifier('Human authentication verifier id'),
      authenticatedAt: z.string().datetime(),
      expiresAt: z.string().datetime().optional(),
    }).strict(),
  }),
  LearningIdentityBaseSchema.extend({
    kind: z.literal('service'),
    role: z.enum(['proposer', 'evaluator', 'operator']),
  }),
  LearningIdentityBaseSchema.extend({
    kind: z.literal('agent'),
    role: z.enum(['proposer', 'evaluator', 'operator']),
  }),
]);

export type HostVerifiedLearningIdentity = z.infer<typeof HostVerifiedLearningIdentitySchema>;

/**
 * Trusted host boundary. The resolver, not this module, authenticates people and
 * binds identities to keys. Raw client claims must never be returned directly.
 */
export type LearningIdentityResolver = (
  actorId: string,
  keyId: string,
) => HostVerifiedLearningIdentity | null;

export interface VerifiedLearningAuthority {
  resolveKey: LearningKeyResolver;
  resolveIdentity: LearningIdentityResolver;
}

export type VerifiedLearningState =
  | 'proposed'
  | 'evaluated'
  | 'approved'
  | 'canary-passed'
  | 'rollback-required'
  | 'rolled-back'
  | 'revoked';

export interface VerifiedLearningProjection {
  proposal: VerifiedLearningProposal;
  state: VerifiedLearningState;
  participants: {
    proposerActorId: string;
    evaluatorActorId?: string;
    reviewerActorId?: string;
  };
  publicationMode: 'proposal-only';
  automaticPublication: false;
}

export type UnsignedLearningEvent = {
  schemaVersion: 1;
  sequence: number;
  proposalId: string;
  action: VerifiedLearningAction;
  actorId: string;
  occurredAt: string;
  previousHash: string | null;
  payload: Record<string, unknown>;
};
