import { describe, expect, it } from 'bun:test'
import type { TaskExecutionGuardContext } from '../../tasks'
import { createProductionTaskExecutionGuard } from './tasks'

function context(root: string, overrides: Partial<TaskExecutionGuardContext> = {}): TaskExecutionGuardContext {
  return {
    workspaceId: 'ws',
    missionId: 'mission',
    runId: 'run',
    nodeId: 'node',
    idempotencyKey: 'key',
    workingDirectory: root,
    effect: 'read',
    permissionMode: 'safe',
    policy: {
      workspaceRoot: root,
      allowedReadPaths: ['.'],
      allowedWritePaths: [],
      networkAccess: 'disabled',
      allowedHosts: [],
      maxCpuPercent: 100,
      maxMemoryMb: 1024,
      timeoutMs: 60_000,
    },
    resourceLimitsExplicit: false,
    ...overrides,
  }
}

describe('production task execution guard', () => {
  it('fails closed for a read-only profile whose path and egress controls are not enforced', () => {
    const root = process.cwd()
    const decision = createProductionTaskExecutionGuard(root)(context(root))
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('Path-scoped read')
    }
  })

  it('fails closed for write, egress, resource, and path policies not enforced by the local host', () => {
    const root = process.cwd()
    const guard = createProductionTaskExecutionGuard(root)

    expect(guard(context(root, {
      effect: 'workspace-write',
      permissionMode: 'allow-all',
      policy: { ...context(root).policy, allowedWritePaths: ['artifacts'] },
    })).allowed).toBe(false)
    expect(guard(context(root, {
      policy: {
        ...context(root).policy,
        networkAccess: 'allow-list',
        allowedHosts: ['api.example.com'],
      },
    })).allowed).toBe(false)
    expect(guard(context(root, { resourceLimitsExplicit: true })).allowed).toBe(false)
    expect(guard(context(root, { workingDirectory: '../outside' })).allowed).toBe(false)
  })
})
