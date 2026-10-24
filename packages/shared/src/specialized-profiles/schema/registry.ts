import { z } from "zod";
import { SHA256_RE, SPECIALIZED_PROFILE_REGISTRY_ANCHOR_SCHEMA_VERSION, SPECIALIZED_PROFILE_REGISTRY_HEAD_SCHEMA_VERSION, SPECIALIZED_PROFILE_REGISTRY_SCHEMA_VERSION, identifier, timestamp } from './profile-definition.ts';
import { SpecializedProfileRecordSchema } from './profile-record.ts';

export const SpecializedProfileRegistryAuthorityAttestationSchema = z.object({
  scheme: z.literal('hmac-sha256'),
  keyId: identifier('Authority key id'),
  sha256: z.string().regex(SHA256_RE),
}).strict();

export type SpecializedProfileRegistryAuthorityAttestation = z.infer<
  typeof SpecializedProfileRegistryAuthorityAttestationSchema
>;

export const SpecializedProfileRegistryHeadSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_REGISTRY_HEAD_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  documentSha256: z.string().regex(SHA256_RE),
  previousDocumentSha256: z.string().regex(SHA256_RE).nullable(),
  authority: SpecializedProfileRegistryAuthorityAttestationSchema,
}).strict();

export type SpecializedProfileRegistryHead = z.infer<typeof SpecializedProfileRegistryHeadSchema>;

export const SpecializedProfileRegistryPayloadSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_REGISTRY_SCHEMA_VERSION),
  workspaceId: identifier('Workspace id'),
  revision: z.number().int().nonnegative(),
  updatedAt: timestamp,
  updatedBy: identifier('Registry actor id'),
  profiles: z.array(SpecializedProfileRecordSchema).max(10_000),
}).strict();

export const SpecializedProfileRegistryAnchorRefSchema = z.object({
  revision: z.number().int().nonnegative(),
  documentSha256: z.string().regex(SHA256_RE),
}).strict();

export type SpecializedProfileRegistryAnchorRef = z.infer<typeof SpecializedProfileRegistryAnchorRefSchema>;

export const SpecializedProfileRegistryAnchorPayloadSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_REGISTRY_ANCHOR_SCHEMA_VERSION),
  workspaceId: identifier('Workspace id'),
  committed: SpecializedProfileRegistryAnchorRefSchema.nullable(),
  pending: SpecializedProfileRegistryAnchorRefSchema.optional(),
  updatedAt: timestamp,
}).strict();

export const SpecializedProfileRegistryAnchorSchema = SpecializedProfileRegistryAnchorPayloadSchema.extend({
  authority: SpecializedProfileRegistryAuthorityAttestationSchema,
}).strict().superRefine((anchor, ctx) => {
  if (anchor.pending) {
    const expectedRevision = (anchor.committed?.revision ?? -1) + 1;
    if (anchor.pending.revision !== expectedRevision) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending', 'revision'], message: 'Pending registry anchor must immediately follow the committed head' });
    }
    if (anchor.pending.documentSha256 === anchor.committed?.documentSha256) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending', 'documentSha256'], message: 'Pending registry anchor must identify a new document' });
    }
  }
});

export type SpecializedProfileRegistryAnchor = z.infer<typeof SpecializedProfileRegistryAnchorSchema>;
