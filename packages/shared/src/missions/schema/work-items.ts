import { THINKING_LEVEL_IDS } from "../../agent/thinking-levels.ts";
import { z } from "zod";
import type { PermissionMode } from "../../agent/mode-types.ts";
import { TaskExecutionSchema } from "../../tasks/schema.ts";

export const MISSION_SCHEMA_VERSION = 2 as const;

export const MISSION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const slug = (label: string) =>
  z.string().regex(MISSION_ID_RE, `${label} must be a lowercase slug (a-z, 0-9, hyphens)`);

export const MISSION_STATUSES = [
  'draft',
  'running',
  'correcting',
  'objective-review',
  'final-review',
  'paused',
  'blocked',
  'waiting-approval',
  'completed',
  'failed',
  'cancelled',
] as const;

export const WORK_ITEM_KINDS = [
  'objective',
  'task',
  'subtask',
  'integration',
  'correction',
  'objective-review',
  'final-review',
] as const;

export const WORK_ITEM_STATUSES = [
  'pending',
  'reserved',
  'running',
  'submitted',
  'verifying',
  'accepted',
  'rejected',
  'superseded',
  'blocked',
  'cancelled',
] as const;

export const AGENT_PROFILE_ROLES = ['planner', 'worker', 'reviewer', 'supervisor'] as const;

export const EVIDENCE_KINDS = ['test', 'artifact', 'state', 'receipt', 'source', 'diff', 'other'] as const;

export const WORK_ITEM_EFFECTS = ['read', 'workspace-write', 'external-mutation'] as const;

const MAX_CONNECTOR_PAYLOAD_BYTES = 64 * 1024;

const MAX_CONNECTOR_PAYLOAD_DEPTH = 12;

const MAX_CONNECTOR_PAYLOAD_FIELDS = 512;

const FORBIDDEN_STRUCTURED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validateStructuredConnectorPayload(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
  depth = 0,
  counter = { fields: 0 },
): void {
  if (depth > MAX_CONNECTOR_PAYLOAD_DEPTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Connector payload exceeds depth ${MAX_CONNECTOR_PAYLOAD_DEPTH}` });
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Connector payload numbers must be finite' });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateStructuredConnectorPayload(child, ctx, [...path, index], depth + 1, counter));
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Connector payload must contain JSON values only' });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    counter.fields += 1;
    if (counter.fields > MAX_CONNECTOR_PAYLOAD_FIELDS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Connector payload exceeds ${MAX_CONNECTOR_PAYLOAD_FIELDS} fields` });
      return;
    }
    if (FORBIDDEN_STRUCTURED_KEYS.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: `Forbidden connector payload key "${key}"` });
      continue;
    }
    validateStructuredConnectorPayload(child, ctx, [...path, key], depth + 1, counter);
  }
}

const StructuredConnectorPayloadSchema = z.record(z.string().min(1).max(128), z.unknown())
  .superRefine((payload, ctx) => {
    validateStructuredConnectorPayload(payload, ctx);
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_CONNECTOR_PAYLOAD_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Connector payload exceeds ${MAX_CONNECTOR_PAYLOAD_BYTES} bytes` });
    }
  });

export const MissionConnectorInvocationSchema = z.object({
  schemaVersion: z.literal(1),
  pack: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
  operationId: z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
  resourceType: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  resourceId: z.string().trim().min(1).max(512).optional(),
  payload: StructuredConnectorPayloadSchema,
  autonomy: z.enum(['A0', 'A1', 'A2', 'A3', 'A4']),
  receiptRequirementId: slug('connector receipt requirement id'),
  compensation: z.object({
    strategy: z.enum(['inverse-operation', 'restore-snapshot', 'manual']),
    operationId: z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
  }).strict().superRefine((compensation, ctx) => {
    if (compensation.strategy !== 'manual' && !compensation.operationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operationId'],
        message: `${compensation.strategy} compensation requires an operationId`,
      });
    }
  }),
}).strict();

export const MissionCriterionSchema = z.object({
  id: slug('criterion id'),
  description: z.string().min(1),
});

export const EvidenceRequirementSchema = z.object({
  id: slug('evidence requirement id'),
  description: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS).optional(),
});

export const EvidenceRefSchema = z.object({
  requirementId: slug('evidence requirement id'),
  uri: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS),
  description: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const WorkSubmissionSchema = z.object({
  summary: z.string().min(1),
  outputRefs: z.array(z.string().min(1)).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
});

/** Host-observed execution telemetry. Never sourced from agent-authored output. */
export const MissionAttemptTelemetrySchema = z.object({
  durationMs: z.number().int().nonnegative(),
  tokenUsage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    contextTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheCreationTokens: z.number().int().nonnegative().optional(),
    contextWindow: z.number().int().positive().optional(),
  }).superRefine((usage, ctx) => {
    if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalTokens'],
        message: 'totalTokens must equal inputTokens + outputTokens',
      });
    }
  }).optional(),
});

/** Stable, side-effect-free handle prepared before an executor starts work. */
export const MissionExecutionBindingSchema = z.object({
  executorKind: slug('executor kind'),
  executionId: z.string().min(1).max(512),
  /**
   * Host-owned ordinary Mission route admitted before the journal mutation and
   * persisted with the dispatch reservation. The runtime revalidates this
   * fingerprint immediately before execute and pins the effective session to
   * these exact route fields. Specialized profiles keep using their stronger
   * signed executionRouteSha256 binding below.
   */
  missionRoute: z.object({
    schemaVersion: z.literal(1),
    routeDecisionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    routeConfigIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
    connectionIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
    agentProfileId: slug('agent profile id'),
    connectionSlug: z.string().min(1),
    version: z.number().int().positive(),
    profile: z.enum(['maximum-quality', 'balanced']),
    origin: z.enum(['router', 'cost-control', 'conductor', 'mission']),
    requestedModel: z.string().min(1).optional(),
    model: z.string().min(1),
    thinkingLevel: z.enum(THINKING_LEVEL_IDS),
    measuredMissionUsd: z.number().finite().nonnegative(),
    projectedRemainingUsd: z.number().finite().nonnegative().optional(),
    effectiveSourceSlugs: z.array(z.string().min(1)),
    effectiveSourceBindings: z.array(z.object({
      slug: z.string().min(1),
      identitySha256: z.string().regex(/^[a-f0-9]{64}$/),
      authorityBindingId: z.string().min(1).optional(),
    }).strict()),
    cwd: z.string().min(1),
    runtimeIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().optional(),
  /**
   * Host-created fingerprint of the specialized profile and effective
   * capability envelope used during prepare. It is persisted with the
   * reservation so execute cannot reuse a session prepared under a different
   * envelope after restart or a host-state change.
   */
  specializedProfile: z.object({
    profileId: slug('specialized profile id'),
    profileVersion: z.number().int().positive(),
    versionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    capabilityEnvelopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    executionRouteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
});

export const AgentProfileSchema = z.object({
  id: slug('agent profile id'),
  role: z.enum(AGENT_PROFILE_ROLES),
  specialty: z.string().min(1),
  systemPrompt: z.string().min(1),
  skills: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  sources: z.array(z.string().min(1)).default([]),
  permissionMode: z.enum(['safe', 'ask', 'allow-all'] as const satisfies readonly PermissionMode[]).default('safe'),
  model: z.string().min(1).optional(),
  llmConnection: z.string().min(1).optional(),
  thinkingLevel: z.enum(THINKING_LEVEL_IDS).optional(),
});

export const MissionWorkItemSchema = z.object({
  id: slug('work item id'),
  kind: z.enum(WORK_ITEM_KINDS),
  title: z.string().min(1),
  prompt: z.string().min(1).optional(),
  parentId: slug('parent work item id').optional(),
  objectiveId: slug('objective work item id').optional(),
  dependsOn: z.array(slug('dependency work item id')).default([]),
  correctsWorkItemId: slug('corrected work item id').optional(),
  reviewTargetId: slug('review target id').optional(),
  acceptanceCriteria: z.array(MissionCriterionSchema).min(1),
  requiredEvidence: z.array(EvidenceRequirementSchema).default([]),
  agentProfileId: slug('agent profile id').optional(),
  effect: z.enum(WORK_ITEM_EFFECTS).default('read'),
  connectorInvocation: MissionConnectorInvocationSchema.optional(),
  execution: TaskExecutionSchema.optional(),
}).superRefine((item, ctx) => {
  const executing = ['task', 'subtask', 'integration', 'correction'].includes(item.kind);
  const reviewing = item.kind === 'objective-review' || item.kind === 'final-review';
  if (executing && !item.prompt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: `${item.kind} work requires a prompt` });
  }
  if (executing && !item.objectiveId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['objectiveId'], message: `${item.kind} work must belong to an objective` });
  }
  if (item.kind === 'correction' && !item.correctsWorkItemId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['correctsWorkItemId'], message: 'A correction must link to the rejected work item' });
  }
  if (item.kind !== 'correction' && item.correctsWorkItemId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['correctsWorkItemId'], message: 'Only correction work may declare correction lineage' });
  }
  if (reviewing && !item.reviewTargetId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewTargetId'], message: `${item.kind} must declare its review target` });
  }
  if (!reviewing && item.reviewTargetId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewTargetId'], message: 'Only review work may declare a review target' });
  }
  if (item.kind === 'objective' && item.objectiveId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['objectiveId'], message: 'An objective cannot belong to another objective' });
  }
  if (new Set(item.dependsOn).size !== item.dependsOn.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dependsOn'], message: 'Dependencies must be unique' });
  }
  const criterionIds = item.acceptanceCriteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['acceptanceCriteria'], message: 'Acceptance criterion ids must be unique per work item' });
  }
  const evidenceIds = item.requiredEvidence.map((requirement) => requirement.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredEvidence'], message: 'Evidence requirement ids must be unique per work item' });
  }
  if (item.effect === 'external-mutation') {
    if (!executing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effect'],
        message: 'Only executable work may declare an external mutation',
      });
    }
    if (item.execution) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution'],
        message: 'Brokered connector mutations cannot use the generic session execution envelope',
      });
    }
    if (!item.connectorInvocation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connectorInvocation'],
        message: 'External mutation work requires a structured brokered connector invocation',
      });
    } else {
      const receipt = item.requiredEvidence.find(({ id }) => id === item.connectorInvocation!.receiptRequirementId);
      if (!receipt || receipt.kind !== 'receipt') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredEvidence'],
          message: `External mutation work requires receipt evidence "${item.connectorInvocation.receiptRequirementId}"`,
        });
      }
    }
  } else if (item.connectorInvocation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectorInvocation'],
      message: 'Only external mutation work may declare a connector invocation',
    });
  }
});

export const MissionPolicySchema = z.object({
  maxConcurrentAgents: z.number().int().positive().max(24).default(4),
  maxCorrectionCycles: z.number().int().min(0).max(10).default(3),
  maxWorkItems: z.number().int().positive().max(512).default(128),
  maxDepth: z.number().int().positive().max(8).default(4),
  maxTechnicalAttempts: z.number().int().positive().max(10).default(3),
  /** Hard mission-local ceilings. Workspace governance may impose lower live limits. */
  maxTotalTokens: z.number().int().positive().optional(),
  maxTotalCostUsd: z.number().positive().optional(),
  /** Absolute host-enforced stop time. Offset is mandatory so recovery is timezone-stable. */
  deadline: z.string().datetime({ offset: true }).optional(),
  requireIndependentReview: z.literal(true).default(true),
  requireIndependentSupervisor: z.literal(true).default(true),
}).default({
  maxConcurrentAgents: 4,
  maxCorrectionCycles: 3,
  maxWorkItems: 128,
  maxDepth: 4,
  maxTechnicalAttempts: 3,
  requireIndependentReview: true,
  requireIndependentSupervisor: true,
});

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export type MissionCriterion = z.infer<typeof MissionCriterionSchema>;

export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export type WorkSubmission = z.infer<typeof WorkSubmissionSchema>;

export type MissionAttemptTelemetry = z.infer<typeof MissionAttemptTelemetrySchema>;

export type MissionExecutionBinding = z.infer<typeof MissionExecutionBindingSchema>;

export type MissionConnectorInvocation = z.infer<typeof MissionConnectorInvocationSchema>;

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export type MissionWorkItem = z.infer<typeof MissionWorkItemSchema>;

export type MissionPolicy = z.infer<typeof MissionPolicySchema>;
