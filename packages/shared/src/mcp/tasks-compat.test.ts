import { describe, expect, it } from 'bun:test'

import type { CanonicalTaskSnapshot } from '../interop/canonical-task.ts'
import {
  MCP_TASKS_COMPATIBILITY,
  projectCanonicalTaskToMcp,
} from './tasks-compat.ts'

const completed: CanonicalTaskSnapshot = {
  id: 'task-1',
  runId: 'run-1',
  taskSlug: 'quality-audit',
  lifecycleStatus: 'completed',
  status: 'completed',
  revision: 2,
  updatedAt: '2026-08-20T12:00:01.000Z',
  artifacts: [],
  progress: { total: 1, completed: 1, failed: 0, active: 0, percent: 100 },
  output: { content: [{ type: 'text', text: 'done' }] },
}

describe('MCP Tasks dual-era projection', () => {
  it('projects a 2025 task without leaking 2026 result fields', () => {
    const task = projectCanonicalTaskToMcp(completed, {
      era: 'legacy',
      ttlMs: 60_000,
      createdAt: '2026-08-20T12:00:00.000Z',
    })

    expect(task).toMatchObject({
      taskId: 'task-1',
      status: 'completed',
      ttl: 60_000,
    })
    expect(task).not.toHaveProperty('ttlMs')
    expect(task).not.toHaveProperty('resultType')
  })

  it('projects the flat 2026 create handle and completed tasks/get result', () => {
    const created = projectCanonicalTaskToMcp(completed, {
      era: 'modern',
      operation: 'create',
      ttlMs: null,
      pollIntervalMs: 250,
    })
    const fetched = projectCanonicalTaskToMcp(completed, {
      era: 'modern',
      operation: 'get',
      ttlMs: null,
    })

    expect(created).toMatchObject({
      resultType: 'task',
      taskId: 'task-1',
      ttlMs: null,
      pollIntervalMs: 250,
    })
    expect(created).not.toHaveProperty('result')
    expect(fetched).toMatchObject({
      resultType: 'complete',
      status: 'completed',
      result: completed.output,
    })
  })

  it('carries outstanding input requests only on a modern tasks/get response', () => {
    const waiting: CanonicalTaskSnapshot = {
      ...completed,
      lifecycleStatus: 'waiting-approval',
      status: 'waiting-approval',
      output: undefined,
    }
    const task = projectCanonicalTaskToMcp(waiting, {
      era: 'modern',
      operation: 'get',
      ttlMs: 60_000,
      inputRequests: {
        approval: { method: 'elicitation/create', params: { message: 'Approve?' } },
      },
    })

    expect(task.status).toBe('input_required')
    expect(task.resultType).toBe('complete')
    expect(task.inputRequests).toHaveProperty('approval')
  })

  it('keeps removed and replacement task methods isolated by era', () => {
    expect(MCP_TASKS_COMPATIBILITY.legacy.extensionId).toBeNull()
    expect(MCP_TASKS_COMPATIBILITY.modern.extensionId).toBe('io.modelcontextprotocol/tasks')
    expect(MCP_TASKS_COMPATIBILITY.legacy.methods).toContain('tasks/result')
    expect(MCP_TASKS_COMPATIBILITY.modern.methods).toContain('tasks/update')
    expect(MCP_TASKS_COMPATIBILITY.modern.methods).not.toContain('tasks/result')
    expect(MCP_TASKS_COMPATIBILITY.modern.methods).not.toContain('tasks/list')
  })

  it('rejects invalid task timing data', () => {
    expect(() => projectCanonicalTaskToMcp(completed, {
      era: 'modern',
      operation: 'get',
      ttlMs: -1,
    })).toThrow('non-negative safe integer')
  })
})
