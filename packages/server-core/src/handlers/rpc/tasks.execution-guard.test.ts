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
    fullAutonomyInherited: false,
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
  it('admits a read-only profile enforced by the persistent tool gateway', () => {
    const root = process.cwd()
    const decision = createProductionTaskExecutionGuard(root)(context(root))
    expect(decision.allowed).toBe(true)
  })

  it('admits path-scoped writes only in an executable permission mode', () => {
    const root = process.cwd()
    const guard = createProductionTaskExecutionGuard(root)

    expect(guard(context(root, {
      effect: 'workspace-write',
      permissionMode: 'allow-all',
      policy: { ...context(root).policy, allowedWritePaths: ['artifacts'] },
    })).allowed).toBe(true)
    expect(guard(context(root, {
      effect: 'workspace-write',
      permissionMode: 'ask',
      policy: { ...context(root).policy, allowedWritePaths: ['artifacts'] },
    })).allowed).toBe(true)
    expect(guard(context(root, {
      effect: 'workspace-write',
      permissionMode: 'safe',
      policy: { ...context(root).policy, allowedWritePaths: ['artifacts'] },
    })).allowed).toBe(false)
  })

  it('fails closed for external mutation, egress, resource, and invalid path policies', () => {
    const root = process.cwd()
    const guard = createProductionTaskExecutionGuard(root)

    expect(guard(context(root, {
      effect: 'external-mutation',
      permissionMode: 'allow-all',
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

  it('admits ordinary session egress and tools only after full autonomy inheritance', () => {
    const root = process.cwd()
    const guard = createProductionTaskExecutionGuard(root)
    const autonomous = context(root, {
      permissionMode: 'allow-all',
      fullAutonomyInherited: true,
      policy: {
        ...context(root).policy,
        networkAccess: 'allow-list',
        allowedHosts: ['api.example.com'],
      },
    })

    expect(guard(autonomous)).toEqual({ allowed: true })
    expect(guard({ ...autonomous, fullAutonomyInherited: false }).allowed).toBe(false)
  })
})
