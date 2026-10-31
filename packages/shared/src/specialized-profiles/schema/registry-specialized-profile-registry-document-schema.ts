import { z } from "zod";
import { canonicalSpecializedProfileRegistryPayloadHash } from './mutation-contracts.ts';
import { SpecializedProfileRegistryHeadSchema, SpecializedProfileRegistryPayloadSchema } from './registry.ts';

export const SpecializedProfileRegistryDocumentSchema = SpecializedProfileRegistryPayloadSchema.extend({
  head: SpecializedProfileRegistryHeadSchema,
}).strict().superRefine((registry, ctx) => {
  const ids = new Set<string>();
  registry.profiles.forEach((profile, index) => {
    if (ids.has(profile.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', index, 'id'], message: 'Profile ids must be unique' });
    }
    ids.add(profile.id);
  });
  if (registry.head.revision !== registry.revision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['head', 'revision'], message: 'Registry head revision must match the document revision' });
  }
  if (registry.head.documentSha256 !== canonicalSpecializedProfileRegistryPayloadHash(registry)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['head', 'documentSha256'], message: 'Registry document digest does not match its payload' });
  }
});

export type SpecializedProfileRegistryDocument = z.infer<typeof SpecializedProfileRegistryDocumentSchema>;
