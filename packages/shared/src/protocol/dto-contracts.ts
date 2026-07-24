import { z } from 'zod'
import type {
  MissionControlSnapshotDto,
  MissionReplayPlanDto,
  TaskResultsDto,
  TaskRunSnapshotDto,
} from './dto'

const taskNodeStateSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
  'skipped',
])

const taskRunStatusSchema = z.enum([
  'running',
  'paused',
  'verifying',
  'stopped',
  'completed',
  'failed',
])

export const TaskNodeRunStateDtoSchema = z.strictObject({
  id: z.string().min(1),
  state: taskNodeStateSchema,
  sessionId: z.string().min(1).optional(),
  attempt: z.number().int().nonnegative(),
})

export const TaskRunSnapshotDtoSchema = z.strictObject({
  slug: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  status: taskRunStatusSchema,
  orchestratorSessionId: z.string().min(1).optional(),
  nodes: z.array(TaskNodeRunStateDtoSchema),
  tokensUsed: z.number().int().nonnegative(),
})

const missionApprovalSchema = z.strictObject({
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  reason: z.string().min(1),
  impact: z.enum(['low', 'medium', 'high', 'critical']),
  owner: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected']),
  actor: z.string().min(1).optional(),
  comment: z.string().optional(),
  requestedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().optional(),
})

const missionBlockerSchema = z.strictObject({
  id: z.string().min(1),
  cause: z.string().min(1),
  owner: z.string().min(1),
  resolution: z.string().min(1),
  status: z.enum(['open', 'resolved']),
  nodeId: z.string().min(1).optional(),
})

export const MissionControlSnapshotDtoSchema = z.strictObject({
  schemaVersion: z.literal(1),
  missionId: z.string().min(1),
  runId: z.string().min(1),
  title: z.string().min(1),
  objective: z.string(),
  status: z.enum([
    'not-started',
    'running',
    'paused',
    'waiting-approval',
    'verifying',
    'completed',
    'failed',
    'stopped',
  ]),
  progress: z.strictObject({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  }),
  budget: z.strictObject({
    maxTokens: z.number().int().nonnegative().optional(),
    maxCost: z.number().nonnegative().optional(),
    currency: z.enum(['USD', 'EUR']).optional(),
    tokensUsed: z.number().int().nonnegative().optional(),
    costUsed: z.number().nonnegative().optional(),
  }),
  evaluation: z.strictObject({
    status: z.enum(['not-evaluated', 'pending', 'passing', 'failing']),
    acceptance: z.enum(['not-evaluated', 'pass', 'fail', 'unparsed']),
    evaluatedNodes: z.number().int().nonnegative(),
    successfulNodes: z.number().int().nonnegative(),
    failedNodes: z.number().int().nonnegative(),
    nodeSuccessRate: z.number().min(0).max(100).optional(),
    safetyIssueCount: z.number().int().nonnegative(),
    evidenceCount: z.number().int().nonnegative(),
    failures: z.array(z.string()),
  }),
  cost: z.strictObject({
    status: z.enum(['untracked', 'tracking', 'within-budget', 'warning', 'exceeded']),
    currency: z.enum(['USD', 'EUR']),
    used: z.number().nonnegative().optional(),
    limit: z.number().nonnegative().optional(),
    remaining: z.number().optional(),
    percentUsed: z.number().nonnegative().optional(),
    warningPercent: z.number().min(0).max(100),
  }),
  deadline: z.iso.datetime().optional(),
  approvals: z.array(missionApprovalSchema),
  blockers: z.array(missionBlockerSchema),
  nextActions: z.array(z.string()),
  eventCount: z.number().int().nonnegative(),
  latestEventAt: z.iso.datetime().optional(),
})

export const MissionReplayPlanDtoSchema = z.strictObject({
  sourceRunId: z.string().min(1),
  safeByDefault: z.boolean(),
  nodes: z.array(z.strictObject({
    nodeId: z.string().min(1),
    action: z.enum(['reuse', 'retry', 'block']),
    reason: z.string().min(1),
    effect: z.enum(['read', 'workspace-write', 'external-mutation']),
  })),
  requiresApproval: z.boolean(),
  blockedNodeIds: z.array(z.string().min(1)),
})

const taskResultNodeSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  state: taskNodeStateSchema,
  sessionId: z.string().min(1).optional(),
  output: z.string().optional(),
})

const taskVerdictSchema = z.strictObject({
  result: z.enum(['pass', 'fail', 'unparsed']),
  reason: z.string().optional(),
  nodes: z.array(z.string().min(1)).optional(),
})

export const TaskResultsDtoSchema = z.strictObject({
  slug: z.string().min(1),
  runId: z.string().min(1).nullable(),
  runIds: z.array(z.string().min(1)),
  verdict: taskVerdictSchema.optional(),
  verdicts: z.array(taskVerdictSchema).optional(),
  repair: z.strictObject({
    used: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }).optional(),
  runStatus: taskRunStatusSchema.optional(),
  acceptanceCriteria: z.string().optional(),
  controlRoom: MissionControlSnapshotDtoSchema.optional(),
  replayPlan: MissionReplayPlanDtoSchema.optional(),
  reportMarkdown: z.string().optional(),
  nodes: z.array(taskResultNodeSchema),
})

export function parseTaskRunSnapshotDto(input: unknown): TaskRunSnapshotDto {
  return TaskRunSnapshotDtoSchema.parse(input)
}

export function parseMissionControlSnapshotDto(input: unknown): MissionControlSnapshotDto {
  return MissionControlSnapshotDtoSchema.parse(input)
}

export function parseMissionReplayPlanDto(input: unknown): MissionReplayPlanDto {
  return MissionReplayPlanDtoSchema.parse(input)
}

export function parseTaskResultsDto(input: unknown): TaskResultsDto {
  return TaskResultsDtoSchema.parse(input)
}
