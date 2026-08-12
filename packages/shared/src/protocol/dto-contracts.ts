import { z } from 'zod'
import type {
  MissionControlSnapshotDto,
  MissionReplayPlanDto,
  DurableTaskSnapshotDto,
  TaskResultsDto,
  TaskRunSnapshotDto,
} from './dto'

const taskNodeStateSchema = z.enum([
  'pending',
  'waiting-approval',
  'running',
  'done',
  'failed',
  'cancelled',
  'skipped',
])

const taskRunStatusSchema = z.enum([
  'running',
  'paused',
  'waiting-approval',
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
  dependsOn: z.array(z.string().min(1)).optional(),
  attempt: z.number().int().nonnegative().optional(),
  proofHash: z.string().min(1).optional(),
  evidenceRefs: z.array(z.string().min(1)).optional(),
  repair: z.strictObject({
    allowed: z.boolean(),
    reason: z.string().min(1),
  }).optional(),
})

const taskVerdictSchema = z.strictObject({
  result: z.enum(['pass', 'fail', 'unparsed']),
  reason: z.string().optional(),
  nodes: z.array(z.string().min(1)).optional(),
})

const durableTaskExternalRefsSchema = z.strictObject({
  craftTaskId: z.string().min(1).optional(),
  googleTaskId: z.string().min(1).optional(),
  temporalWorkflowId: z.string().min(1).optional(),
})

const durableTaskSnapshotDtoSchema: z.ZodType<DurableTaskSnapshotDto> = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  slug: z.string().min(1),
  revision: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string(),
  acceptanceCriteria: z.string(),
  sources: z.array(z.string()),
  projectId: z.string().min(1).optional(),
  executor: z.strictObject({
    runner: z.enum(['conduct', 'orchestrate']),
    agent: z.string().min(1),
    wrapper: z.string().min(1),
    model: z.string().min(1).optional(),
    llmConnection: z.string().min(1).optional(),
  }),
  status: z.enum(['ready', 'running', 'paused', 'waiting-approval', 'verifying', 'completed', 'failed', 'stopped', 'archived']),
  archived: z.boolean(),
  archivedAt: z.iso.datetime().optional(),
  graph: z.strictObject({
    nodes: z.array(z.strictObject({
      id: z.string().min(1),
      title: z.string().min(1),
      kind: z.string().min(1),
      dependsOn: z.array(z.string()),
      state: taskNodeStateSchema,
      attempt: z.number().int().nonnegative(),
      sessionId: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      connectionSlug: z.string().min(1).optional(),
      effect: z.enum(['read', 'workspace-write', 'external-mutation']),
      outputAvailable: z.boolean(),
      evidenceRefs: z.array(z.string()),
      proofHash: z.string().min(1).optional(),
      repair: z.strictObject({ allowed: z.boolean(), reason: z.string().min(1) }),
    })),
    edges: z.array(z.strictObject({ from: z.string().min(1), to: z.string().min(1) })),
  }),
  linkedSessions: z.strictObject({
    orchestratorSessionId: z.string().min(1).optional(),
    nodes: z.array(z.strictObject({ nodeId: z.string().min(1), sessionId: z.string().min(1) })),
  }),
  latestRunId: z.string().min(1).optional(),
  result: z.strictObject({
    verification: z.enum(['not-verified', 'verified', 'rejected', 'inconclusive']),
    summary: z.string(),
    output: z.string().optional(),
  }),
  evidenceRefs: z.array(z.string()),
  userEvidence: z.strictObject({
    actionRequested: z.string(),
    actionAttempted: z.array(z.string()),
    mutationsApplied: z.array(z.string()),
    userVerification: z.string(),
    remainingLimitations: z.array(z.string()),
  }),
  nextAction: z.string(),
  externalRefs: durableTaskExternalRefsSchema,
  visualState: z.strictObject({
    tone: z.enum(['neutral', 'info', 'warning', 'success', 'danger', 'muted']),
    label: z.string().min(1),
    progressPercent: z.number().min(0).max(100),
    attentionRequired: z.boolean(),
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
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
  task: durableTaskSnapshotDtoSchema.optional(),
  userEvidence: z.strictObject({
    actionRequested: z.string(),
    actionAttempted: z.array(z.string()),
    mutationsApplied: z.array(z.string()),
    userVerification: z.string(),
    remainingLimitations: z.array(z.string()),
  }).optional(),
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
