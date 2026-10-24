import { z } from "zod";
import { TaskExecutionSchema, type TaskExecution } from "../../tasks/schema.ts";
import { AGENT_PROFILE_ROLES, AgentProfileSchema, MISSION_SCHEMA_VERSION, MissionCriterionSchema, MissionPolicySchema, MissionWorkItemSchema, slug } from './work-items.ts';

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

export type MissionSpec = z.infer<typeof MissionSpecSchema>;

export type MissionExecutionPolicy = TaskExecution;

export function parseMissionSpec(value: unknown) {
  return MissionSpecSchema.safeParse(value);
}
