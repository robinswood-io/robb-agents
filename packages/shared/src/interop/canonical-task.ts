import type {
  TaskResultsDto,
  TaskRunSnapshotDto,
} from '../protocol/dto.ts'
import type {
  AgentTaskSnapshot,
  AgentTaskStatus,
} from './agent-interop.ts'

export type CanonicalArtifactPart =
  | { kind: 'text'; text: string }
  | { kind: 'uri'; uri: string }
  | { kind: 'data'; mediaType: string; base64: string }

/**
 * Protocol-neutral artifact. MCP, A2A and AG-UI adapters must map this shape
 * instead of inventing protocol-specific task output contracts.
 */
export interface CanonicalTaskArtifact {
  id: string
  name: string
  mediaType: string
  createdAt: string
  parts: CanonicalArtifactPart[]
  metadata?: Record<string, string | number | boolean>
}

export interface CanonicalTaskSnapshot extends AgentTaskSnapshot {
  runId: string
  taskSlug: string
  /** Exact internal lifecycle state, retained even when a protocol has fewer states. */
  lifecycleStatus: TaskRunSnapshotDto['status']
  artifacts: CanonicalTaskArtifact[]
  progress: {
    total: number
    completed: number
    failed: number
    active: number
    percent: number
  }
}

export type McpCanonicalTaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type A2ACanonicalTaskState =
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'

function canonicalStatus(status: TaskRunSnapshotDto['status']): AgentTaskStatus {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'canceled'
    case 'waiting-approval':
      return 'waiting-approval'
    case 'paused':
      return 'running'
    default:
      return 'running'
  }
}

function statusTimestamp(value: string | undefined): string {
  if (value && Number.isFinite(Date.parse(value))) return value
  return new Date(0).toISOString()
}

function artifactTimestamp(results: TaskResultsDto | undefined): string {
  return statusTimestamp(results?.controlRoom?.latestEventAt)
}

export function taskResultsToCanonicalArtifacts(
  runId: string,
  results: TaskResultsDto | undefined,
): CanonicalTaskArtifact[] {
  if (!results) return []
  const createdAt = artifactTimestamp(results)
  const artifacts: CanonicalTaskArtifact[] = []

  if (results.reportMarkdown?.trim()) {
    artifacts.push({
      id: `${runId}:report`,
      name: 'run-report.md',
      mediaType: 'text/markdown',
      createdAt,
      parts: [{ kind: 'text', text: results.reportMarkdown }],
      metadata: { artifactType: 'report' },
    })
  }

  for (const node of results.nodes) {
    if (!node.output?.trim()) continue
    artifacts.push({
      id: `${runId}:node:${node.id}`,
      name: `${node.id}.md`,
      mediaType: 'text/markdown',
      createdAt,
      parts: [{ kind: 'text', text: node.output }],
      metadata: {
        artifactType: 'node-output',
        nodeId: node.id,
        nodeState: node.state,
      },
    })
  }

  return artifacts
}

/**
 * Convert the durable internal run into the single task envelope consumed by
 * all external protocol adapters.
 */
export function toCanonicalTaskSnapshot(
  run: TaskRunSnapshotDto,
  results?: TaskResultsDto,
  revision = 1,
): CanonicalTaskSnapshot {
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error('Canonical task revision must be a positive integer')
  }
  const completed = run.nodes.filter((node) => node.state === 'done' || node.state === 'skipped').length
  const failed = run.nodes.filter((node) => node.state === 'failed' || node.state === 'cancelled').length
  const active = run.nodes.filter((node) => node.state === 'running').length
  const total = run.nodes.length
  const percent = total === 0 ? 0 : Math.round((completed / total) * 10_000) / 100
  const updatedAt = results?.controlRoom?.latestEventAt
    ?? artifactTimestamp(results)

  return {
    id: run.taskId,
    runId: run.runId,
    taskSlug: run.slug,
    lifecycleStatus: run.status,
    status: canonicalStatus(run.status),
    revision,
    updatedAt,
    artifacts: taskResultsToCanonicalArtifacts(run.runId, results),
    progress: { total, completed, failed, active, percent },
    output: {
      tokensUsed: run.tokensUsed,
      runStatus: run.status,
      ...(results?.verdict ? { verdict: results.verdict } : {}),
    },
    ...(run.status === 'failed' && results?.verdict?.reason
      ? { error: results.verdict.reason }
      : {}),
  }
}

export function toMcpCanonicalTaskStatus(status: AgentTaskStatus): McpCanonicalTaskStatus {
  switch (status) {
    case 'queued':
    case 'running':
      return 'working'
    case 'waiting-approval':
      return 'input_required'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'cancelled'
  }
}

export function toA2ACanonicalTaskState(status: AgentTaskStatus): A2ACanonicalTaskState {
  switch (status) {
    case 'queued':
    case 'running':
      return 'TASK_STATE_WORKING'
    case 'waiting-approval':
      return 'TASK_STATE_INPUT_REQUIRED'
    case 'completed':
      return 'TASK_STATE_COMPLETED'
    case 'failed':
      return 'TASK_STATE_FAILED'
    case 'canceled':
      return 'TASK_STATE_CANCELED'
  }
}
