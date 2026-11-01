import { z } from "zod";
import { SHA256_RE, SpecializedProfileStateSchema, identifier, profileId, timestamp } from './profile-definition.ts';

export const SpecializedProfileHumanApprovalReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: identifier('Approval receipt id'),
  profileId,
  profileVersion: z.number().int().positive(),
  transition: z.object({
    from: SpecializedProfileStateSchema,
    to: z.enum(['opt-in', 'canary', 'default']),
  }).strict(),
  decision: z.literal('approved'),
  reviewer: z.object({
    kind: z.literal('human'),
    actorId: identifier('Human reviewer actor id'),
  }).strict(),
  authentication: z.object({
    assurance: z.enum(['webauthn', 'os-session', 'oauth-recent']),
    verifierId: identifier('Authentication verifier id'),
    eventId: identifier('Authentication event id'),
    authenticatedAt: timestamp,
  }).strict(),
  authorizationContext: z.object({
    registryRevision: z.number().int().nonnegative(),
    registryHeadSha256: z.string().regex(SHA256_RE),
    lifecycleEntryTransitionSequence: z.number().int().positive(),
    evaluationIds: z.array(identifier('Evaluation id')).max(100),
  }).strict(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  rationale: z.string().trim().min(1).max(4_000),
  evidence: z.array(z.object({
    uri: z.string().trim().min(1).max(2_048),
    sha256: z.string().regex(SHA256_RE),
  }).strict()).min(1).max(100),
}).strict().superRefine((receipt, ctx) => {
  if (Date.parse(receipt.authentication.authenticatedAt) > Date.parse(receipt.issuedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authentication', 'authenticatedAt'],
      message: 'Human authentication cannot occur after receipt issuance',
    });
  }
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Approval receipt expiry must follow issuance',
    });
  }
});

export type SpecializedProfileHumanApprovalReceipt = z.infer<typeof SpecializedProfileHumanApprovalReceiptSchema>;

export const SpecializedProfileTransitionSchema = z.object({
  sequence: z.number().int().positive(),
  profileVersion: z.number().int().positive(),
  from: SpecializedProfileStateSchema.nullable(),
  to: SpecializedProfileStateSchema,
  occurredAt: timestamp,
  actorId: identifier('Transition actor id'),
  reason: z.string().trim().min(1).max(4_000),
  evaluationIds: z.array(identifier('Evaluation id')).max(100).default([]),
  approvalReceipt: SpecializedProfileHumanApprovalReceiptSchema.optional(),
}).strict();

export type SpecializedProfileTransition = z.infer<typeof SpecializedProfileTransitionSchema>;
