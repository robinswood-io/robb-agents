import { describe, expect, it } from 'bun:test'
import type {
  TaskResultsDto,
  TaskRunSnapshotDto,
} from '../protocol/dto.ts'
import {
  taskResultsToCanonicalArtifacts,
  toA2ACanonicalTaskState,
  toCanonicalTaskSnapshot,
  toMcpCanonicalTaskStatus,
} from './canonical-task.ts'

const run: TaskRunSnapshotDto = {
  slug: 'quality-audit',
  runId: 'run-1',
  taskId: 'task-1',
  status: 'completed',
  nodes: [
    { id: 'collect', state: 'done', attempt: 1 },
    { id: 'verify', state: 'done', attempt: 1 },
  ],
  tokensUsed: 1_200,
}

const results: TaskResultsDto = {
  slug: 'quality-audit',
  runId: 'run-1',
  runIds: ['run-1'],
  verdict: { result: 'pass', reason: 'All checks passed' },
  reportMarkdown: '# Audit\n\nPassed.',
  nodes: [
    {
      id: 'collect',
      title: 'Collect evidence',
      state: 'done',
      output: 'Evidence bundle',
    },
    {
      id: 'verify',
      title: 'Verify',
      state: 'done',
      output: 'Verified',
    },
  ],
}

describe('canonical task interoperability contract', () => {
  it('converts one internal run into a protocol-neutral snapshot and artifacts', () => {
    const snapshot = toCanonicalTaskSnapshot(run, results, 3)
    expect(snapshot).toMatchObject({
      id: 'task-1',
      runId: 'run-1',
      taskSlug: 'quality-audit',
      status: 'completed',
      revision: 3,
      progress: {
        total: 2,
        completed: 2,
        failed: 0,
        active: 0,
        percent: 100,
      },
      output: {
        tokensUsed: 1_200,
        runStatus: 'completed',
        verdict: { result: 'pass' },
      },
    })
    expect(snapshot.artifacts.map((artifact) => artifact.id)).toEqual([
      'run-1:report',
      'run-1:node:collect',
      'run-1:node:verify',
    ])
  })

  it('uses the same lifecycle semantics for MCP Tasks and A2A', () => {
    expect(toMcpCanonicalTaskStatus('waiting-approval')).toBe('input_required')
    expect(toA2ACanonicalTaskState('waiting-approval')).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(toMcpCanonicalTaskStatus('canceled')).toBe('cancelled')
    expect(toA2ACanonicalTaskState('canceled')).toBe('TASK_STATE_CANCELED')
  })

  it('retains exact internal approval and pause states before protocol projection', () => {
    const waiting = toCanonicalTaskSnapshot({
      ...run,
      status: 'waiting-approval',
    })
    const paused = toCanonicalTaskSnapshot({
      ...run,
      status: 'paused',
    })

    expect(waiting.lifecycleStatus).toBe('waiting-approval')
    expect(waiting.status).toBe('waiting-approval')
    expect(toMcpCanonicalTaskStatus(waiting.status)).toBe('input_required')
    expect(toA2ACanonicalTaskState(waiting.status)).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(paused.lifecycleStatus).toBe('paused')
    expect(paused.status).toBe('running')
    expect(toMcpCanonicalTaskStatus(paused.status)).toBe('working')
    expect(toA2ACanonicalTaskState(paused.status)).toBe('TASK_STATE_WORKING')
  })

  it('omits empty node outputs from the shared artifact list', () => {
    expect(taskResultsToCanonicalArtifacts('run-2', {
      ...results,
      reportMarkdown: undefined,
      nodes: [
        { id: 'empty', title: 'Empty', state: 'done', output: '  ' },
        { id: 'kept', title: 'Kept', state: 'done', output: 'Result' },
      ],
    })).toHaveLength(1)
  })

  it('rejects non-monotonic revisions', () => {
    expect(() => toCanonicalTaskSnapshot(run, results, 0)).toThrow(
      'Canonical task revision must be a positive integer',
    )
  })
})
