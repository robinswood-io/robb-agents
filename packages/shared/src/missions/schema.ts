import { z } from 'zod';
import type { PermissionMode } from '../agent/mode-types.ts';
import { TaskExecutionSchema, type TaskExecution } from '../tasks/schema.ts';

export const MISSION_SCHEMA_VERSION = 2 as const;
export const MISSION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const slug = (label: string) =>
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
export const AGENT_MODEL_TIERS = ['fast', 'balanced', 'best'] as const;
export const EVIDENCE_KINDS = ['test', 'artifact', 'state', 'receipt', 'source', 'diff', 'other'] as const;
export const WORK_ITEM_EFFECTS = ['read', 'workspace-write', 'external-mutation'] as const;

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
  modelTier: z.enum(AGENT_MODEL_TIERS).default('balanced'),
  model: z.string().min(1).optional(),
  llmConnection: z.string().min(1).optional(),
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
});

export const MissionPolicySchema = z.object({
  maxConcurrentAgents: z.number().int().positive().max(24).default(4),
  maxCorrectionCycles: z.number().int().min(0).max(10).default(3),
  maxWorkItems: z.number().int().positive().max(512).default(128),
  maxDepth: z.number().int().positive().max(8).default(4),
  maxTechnicalAttempts: z.number().int().positive().max(10).default(3),
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

const INITIAL_WORK_ITEM_KINDS = new Set(['objective', 'task', 'subtask', 'integration']);

function findCycle(ids: string[], edges: (id: string) => readonly string[]): string[] | null {
  const state = new Map(ids.map((id) => [id, 0]));
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges(id)) {
      if (!state.has(next)) continue;
      if (state.get(next) === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (state.get(next) === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of ids) {
    if (state.get(id) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

export const MissionSpecSchema = z.object({
  schemaVersion: z.literal(MISSION_SCHEMA_VERSION),
  id: slug('mission id'),
  title: z.string().min(1),
  objective: z.string().min(1),
  projectId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  execution: TaskExecutionSchema.optional(),
  acceptanceCriteria: z.array(MissionCriterionSchema).min(1),
  originSessionId: z.string().min(1).optional(),
  plannerSessionId: z.string().min(1).optional(),
  plannerProfileId: slug('planner profile id'),
  defaultWorkerProfileId: slug('default worker profile id'),
  reviewerProfileId: slug('reviewer profile id'),
  supervisorProfileId: slug('supervisor profile id'),
  agentProfiles: z.array(AgentProfileSchema).min(4),
  policy: MissionPolicySchema,
  workItems: z.array(MissionWorkItemSchema).min(2),
}).superRefine((spec, ctx) => {
  const missionCriterionIds = spec.acceptanceCriteria.map((criterion) => criterion.id);
  if (new Set(missionCriterionIds).size !== missionCriterionIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['acceptanceCriteria'], message: 'Mission acceptance criterion ids must be unique' });
  }
  const profiles = new Map<string, z.infer<typeof AgentProfileSchema>>();
  spec.agentProfiles.forEach((profile, index) => {
    if (profiles.has(profile.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agentProfiles', index, 'id'], message: `Duplicate agent profile "${profile.id}"` });
    }
    profiles.set(profile.id, profile);
  });

  const roleRefs: Array<[keyof typeof spec, string, (typeof AGENT_PROFILE_ROLES)[number]]> = [
    ['plannerProfileId', spec.plannerProfileId, 'planner'],
    ['defaultWorkerProfileId', spec.defaultWorkerProfileId, 'worker'],
    ['reviewerProfileId', spec.reviewerProfileId, 'reviewer'],
    ['supervisorProfileId', spec.supervisorProfileId, 'supervisor'],
  ];
  for (const [field, id, role] of roleRefs) {
    const profile = profiles.get(id);
    if (!profile) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `Unknown agent profile "${id}"` });
    } else if (profile.role !== role) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `Profile "${id}" must have role ${role}` });
    }
  }
  if (new Set(roleRefs.map(([, id]) => id)).size !== roleRefs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agentProfiles'], message: 'Planner, worker, reviewer, and supervisor profiles must be distinct' });
  }

  if (spec.workItems.length > spec.policy.maxWorkItems) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems'], message: `Initial plan exceeds maxWorkItems (${spec.policy.maxWorkItems})` });
  }

  const items = new Map<string, z.infer<typeof MissionWorkItemSchema>>();
  spec.workItems.forEach((item, index) => {
    if (items.has(item.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems', index, 'id'], message: `Duplicate work item "${item.id}"` });
    }
    if (!INITIAL_WORK_ITEM_KINDS.has(item.kind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems', index, 'kind'], message: `${item.kind} items are controller-owned and cannot appear in the initial plan` });
    }
    items.set(item.id, item);
  });

  const objectives = new Set(spec.workItems.filter((item) => item.kind === 'objective').map((item) => item.id));
  for (const [index, item] of spec.workItems.entries()) {
    if (item.parentId && !items.has(item.parentId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems', index, 'parentId'], message: `Unknown parent "${item.parentId}"` });
    }
    if (item.parentId && item.objectiveId) {
      const parent = items.get(item.parentId);
      const parentObjectiveId = parent?.kind === 'objective' ? parent.id : parent?.objectiveId;
      if (parent && parentObjectiveId !== item.objectiveId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workItems', index, 'parentId'],
          message: `Parent "${item.parentId}" is outside objective "${item.objectiveId}"`,
        });
      }
    }
    for (const dependency of item.dependsOn) {
      if (dependency === item.id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems', index, 'dependsOn'], message: 'A work item cannot depend on itself' });
      } else if (!items.has(dependency)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems', index, 'dependsOn'], message: `Unknown dependency "${dependency}"` });
      }
    }
    if (item.objectiveId && !objectives.has(item.objectiveId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems', index, 'objectiveId'], message: `objectiveId "${item.objectiveId}" is not an objective` });
    }
    if (item.agentProfileId) {
      const profile = profiles.get(item.agentProfileId);
      if (!profile) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems', index, 'agentProfileId'], message: `Unknown agent profile "${item.agentProfileId}"` });
      } else if (profile.role !== 'worker') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems', index, 'agentProfileId'], message: 'Initial executable work must use a worker profile' });
      }
    }
    if (['task', 'subtask', 'integration'].includes(item.kind) && item.effect === 'workspace-write') {
      const execution = item.execution ?? spec.execution;
      if (!execution || execution.allowed_write_paths.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workItems', index, 'execution', 'allowed_write_paths'],
          message: 'Workspace-write work must declare at least one allowed write path',
        });
      }
      const profile = profiles.get(item.agentProfileId ?? spec.defaultWorkerProfileId);
      if (profile?.permissionMode === 'safe') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workItems', index, 'agentProfileId'],
          message: 'Workspace-write work cannot use a safe-mode worker profile',
        });
      }
    }
  }

  for (const objectiveId of objectives) {
    if (!spec.workItems.some((item) => item.objectiveId === objectiveId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems'], message: `Objective "${objectiveId}" has no executable work` });
    }
  }

  const ids = [...items.keys()];
  const dependencyCycle = findCycle(ids, (id) => items.get(id)?.dependsOn ?? []);
  if (dependencyCycle) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems'], message: `Dependency cycle: ${dependencyCycle.join(' -> ')}` });
  }
  const containmentCycle = findCycle(ids, (id) => {
    const parent = items.get(id)?.parentId;
    return parent ? [parent] : [];
  });
  if (containmentCycle) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems'], message: `Containment cycle: ${containmentCycle.join(' -> ')}` });
  }

  for (const item of spec.workItems) {
    let depth = 1;
    let parentId = item.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = items.get(parentId)?.parentId;
    }
    if (depth > spec.policy.maxDepth) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workItems'], message: `Work item "${item.id}" exceeds maxDepth (${spec.policy.maxDepth})` });
    }
  }
});

export const CriterionVerdictSchema = z.object({
  criterionId: slug('criterion id'),
  result: z.enum(['pass', 'fail', 'inconclusive']),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  explanation: z.string().min(1),
});

export const CorrectionBriefSchema = z.object({
  correctsWorkItemId: slug('corrected work item id'),
  title: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  acceptanceCriteria: z.array(MissionCriterionSchema).min(1).optional(),
  agentProfileId: slug('agent profile id').optional(),
});

export const StructuredMissionVerdictSchema = z.object({
  targetType: z.enum(['objective', 'mission']),
  targetId: slug('verdict target id'),
  result: z.enum(['pass', 'fail', 'inconclusive']),
  summary: z.string().min(1),
  criteria: z.array(CriterionVerdictSchema).min(1),
  affectedWorkItemIds: z.array(slug('affected work item id')).default([]),
  corrections: z.array(CorrectionBriefSchema).default([]),
}).superRefine((verdict, ctx) => {
  const criterionIds = verdict.criteria.map((criterion) => criterion.criterionId);
  if (new Set(criterionIds).size !== criterionIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'Criterion verdict ids must be unique' });
  }
  if (new Set(verdict.affectedWorkItemIds).size !== verdict.affectedWorkItemIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedWorkItemIds'], message: 'Affected work item ids must be unique' });
  }
  const correctionTargets = verdict.corrections.map((correction) => correction.correctsWorkItemId);
  if (new Set(correctionTargets).size !== correctionTargets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['corrections'], message: 'Only one correction brief is allowed per affected work item' });
  }
  if (verdict.result === 'pass' && (verdict.affectedWorkItemIds.length > 0 || verdict.corrections.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedWorkItemIds'], message: 'A PASS verdict cannot request corrections' });
  }
  if (verdict.result === 'fail' && verdict.affectedWorkItemIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedWorkItemIds'], message: 'A FAIL verdict must identify affected work' });
  }
  if (verdict.result === 'pass' && verdict.criteria.some((criterion) => criterion.result !== 'pass')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'Every criterion must pass when the verdict is PASS' });
  }
  if (verdict.result === 'fail' && !verdict.criteria.some((criterion) => criterion.result === 'fail')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'A FAIL verdict must fail at least one criterion' });
  }
  if (verdict.result === 'inconclusive' && !verdict.criteria.some((criterion) => criterion.result === 'inconclusive')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'An INCONCLUSIVE verdict must mark at least one criterion inconclusive' });
  }
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
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type MissionWorkItem = z.infer<typeof MissionWorkItemSchema>;
export type MissionPolicy = z.infer<typeof MissionPolicySchema>;
export type MissionSpec = z.infer<typeof MissionSpecSchema>;
export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;
export type CorrectionBrief = z.infer<typeof CorrectionBriefSchema>;
export type StructuredMissionVerdict = z.infer<typeof StructuredMissionVerdictSchema>;
export type MissionExecutionPolicy = TaskExecution;

export function parseMissionSpec(value: unknown) {
  return MissionSpecSchema.safeParse(value);
}
