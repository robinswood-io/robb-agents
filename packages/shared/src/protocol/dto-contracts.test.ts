import { describe, expect, test } from 'bun:test'
import type {
  MissionControlSnapshotDto,
  MissionReplayPlanDto,
  TaskResultsDto,
  TaskRunSnapshotDto,
} from './dto'
import {
  parseMissionControlSnapshotDto,
  parseMissionReplayPlanDto,
  parseTaskResultsDto,
  parseTaskRunSnapshotDto,
} from './dto-contracts'

const controlRoom = {
  schemaVersion: 1,
  missionId: 'mission-1',
  runId: 'run-1',
  title: 'Contract mission',
  objective: 'Prove the portable wire contract',
  status: 'waiting-approval',
  progress: {
    total: 2,
    completed: 1,
    failed: 0,
    running: 0,
    pending: 1,
    percent: 50,
  },
  budget: {
    maxTokens: 10_000,
    maxCost: 5,
    currency: 'EUR',
    tokensUsed: 4_000,
    costUsed: 2.5,
  },
  evaluation: {
    status: 'pending',
    acceptance: 'not-evaluated',
    evaluatedNodes: 1,
    successfulNodes: 1,
    failedNodes: 0,
    nodeSuccessRate: 100,
    safetyIssueCount: 0,
    evidenceCount: 1,
    failures: [],
  },
  cost: {
    status: 'within-budget',
    currency: 'EUR',
    used: 2.5,
    limit: 5,
    remaining: 2.5,
    percentUsed: 50,
    warningPercent: 80,
  },
  approvals: [{
    requestId: 'approval-1',
    nodeId: 'publish',
    reason: 'External mutation',
    impact: 'high',
    owner: 'validator-1',
    status: 'pending',
    requestedAt: '2026-07-23T12:00:00.000Z',
  }],
  blockers: [{
    id: 'approval:approval-1',
    cause: 'External mutation',
    owner: 'validator-1',
    resolution: 'Approve or reject the request',
    status: 'open',
    nodeId: 'publish',
  }],
  nextActions: ['Resolve approval approval-1'],
  eventCount: 5,
  latestEventAt: '2026-07-23T12:00:00.000Z',
} satisfies MissionControlSnapshotDto

const replayPlan = {
  sourceRunId: 'run-1',
  safeByDefault: true,
  nodes: [{
    nodeId: 'research',
    action: 'reuse',
    reason: 'Confirmed read result',
    effect: 'read',
  }, {
    nodeId: 'publish',
    action: 'block',
    reason: 'External mutation requires review',
    effect: 'external-mutation',
  }],
  requiresApproval: true,
  blockedNodeIds: ['publish'],
} satisfies MissionReplayPlanDto

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

describe('protocol DTO runtime contracts', () => {
  test('accepts task snapshots from both Electron RPC and a headless protocol bridge', () => {
    const electronProducer = {
      slug: 'contract-mission',
      runId: 'run-1',
      taskId: 'task-1',
      status: 'running',
      orchestratorSessionId: 'session-1',
      nodes: [{ id: 'research', state: 'done', sessionId: 'child-1', attempt: 1 }],
      tokensUsed: 2_400,
    } satisfies TaskRunSnapshotDto
    const headlessProducer = {
      slug: 'contract-mission',
      runId: 'run-2',
      taskId: 'task-1',
      status: 'paused',
      nodes: [{ id: 'publish', state: 'pending', attempt: 0 }],
      tokensUsed: 0,
    } satisfies TaskRunSnapshotDto

    expect(parseTaskRunSnapshotDto(jsonRoundTrip(electronProducer))).toEqual(electronProducer)
    expect(parseTaskRunSnapshotDto(jsonRoundTrip(headlessProducer))).toEqual(headlessProducer)
  })

  test('round-trips the Control Room and replay safety envelopes without losing evidence', () => {
    expect(parseMissionControlSnapshotDto(jsonRoundTrip(controlRoom))).toEqual(controlRoom)
    expect(parseMissionReplayPlanDto(jsonRoundTrip(replayPlan))).toEqual(replayPlan)
  })

  test('accepts a durable results document and rejects silent wire-contract drift', () => {
    const result = {
      slug: 'contract-mission',
      runId: 'run-1',
      runIds: ['run-1'],
      verdict: { result: 'pass', reason: 'Acceptance verified' },
      verdicts: [{ result: 'pass', reason: 'Acceptance verified' }],
      repair: { used: 0, max: 2 },
      runStatus: 'completed',
      acceptanceCriteria: 'Every protocol vector passes',
      controlRoom,
      replayPlan,
      reportMarkdown: '# Contract mission',
      nodes: [{
        id: 'research',
        title: 'Research',
        state: 'done',
        sessionId: 'child-1',
        output: 'Evidence',
      }],
    } satisfies TaskResultsDto

    expect(parseTaskResultsDto(jsonRoundTrip(result))).toEqual(result)
    expect(() => parseTaskResultsDto({
      ...result,
      unexpectedWireField: true,
    })).toThrow()
    expect(() => parseMissionControlSnapshotDto({
      ...controlRoom,
      progress: { ...controlRoom.progress, percent: 101 },
    })).toThrow()
  })
})
