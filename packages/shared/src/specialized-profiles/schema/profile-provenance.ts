import { z } from "zod";
import { SPECIALIZED_PROFILE_VERSION_SCHEMA_VERSION, SpecializedAgentProfileDefinitionSchema, SpecializedProfileSourceRefSchema, identifier, profileId, timestamp } from './profile-definition.ts';

export const SpecializedProfileProvenanceSchema = z.object({
  method: z.enum(['mission-pattern', 'chat-pattern', 'manual', 'import']),
  proposedBy: z.object({
    kind: z.enum(['human', 'agent', 'service']),
    actorId: identifier('Proposer actor id'),
  }).strict(),
  generatedBy: z.object({
    name: identifier('Generator name'),
    version: z.string().trim().min(1).max(128),
  }).strict(),
  generatedAt: timestamp,
  analysisWindow: z.object({
    from: timestamp,
    to: timestamp,
  }).strict().optional(),
  sample: z.object({
    rawTaskCount: z.number().int().positive(),
    deduplicatedRootTaskCount: z.number().int().positive(),
  }).strict(),
  sources: z.array(SpecializedProfileSourceRefSchema).min(1).max(10_000),
}).strict().superRefine((provenance, ctx) => {
  if (provenance.sample.deduplicatedRootTaskCount > provenance.sample.rawTaskCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sample', 'deduplicatedRootTaskCount'],
      message: 'Deduplicated root task count cannot exceed raw task count',
    });
  }
  if (provenance.analysisWindow
    && Date.parse(provenance.analysisWindow.to) < Date.parse(provenance.analysisWindow.from)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['analysisWindow', 'to'],
      message: 'Analysis window end cannot precede its start',
    });
  }
  const hashes = new Set<string>();
  provenance.sources.forEach((source, index) => {
    if (hashes.has(source.sha256)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources', index, 'sha256'],
        message: 'Provenance source hashes must be unique',
      });
    }
    hashes.add(source.sha256);
  });
});

export type SpecializedProfileProvenance = z.infer<typeof SpecializedProfileProvenanceSchema>;

export const SpecializedProfileVersionSchema = z.object({
  schemaVersion: z.literal(SPECIALIZED_PROFILE_VERSION_SCHEMA_VERSION),
  profileId,
  version: z.number().int().positive(),
  definition: SpecializedAgentProfileDefinitionSchema,
  provenance: SpecializedProfileProvenanceSchema,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('initial'), reason: z.string().trim().min(1).max(2_000) }).strict(),
    z.object({
      kind: z.literal('revision'),
      previousVersion: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2_000),
    }).strict(),
    z.object({
      kind: z.literal('rollback'),
      previousVersion: z.number().int().positive(),
      rollbackOfVersion: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2_000),
    }).strict(),
  ]),
  createdAt: timestamp,
  createdBy: identifier('Version creator'),
}).strict().superRefine((version, ctx) => {
  if (version.version === 1 && version.change.kind !== 'initial') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['change'], message: 'Version 1 must be initial' });
  }
  if (version.version > 1 && version.change.kind === 'initial') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['change'], message: 'Only version 1 can be initial' });
  }
  if (version.change.kind !== 'initial' && version.change.previousVersion !== version.version - 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['change', 'previousVersion'],
      message: 'previousVersion must immediately precede the new version',
    });
  }
  if (version.change.kind === 'rollback' && version.change.rollbackOfVersion >= version.version) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['change', 'rollbackOfVersion'],
      message: 'Rollback target must be an earlier version',
    });
  }
});

export type SpecializedProfileVersion = z.infer<typeof SpecializedProfileVersionSchema>;
