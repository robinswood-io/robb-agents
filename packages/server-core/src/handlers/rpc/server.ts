import { existsSync } from 'node:fs'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { addWorkspace, setActiveWorkspace } from '@craft-agent/shared/config'
import { getDefaultWorkspacesDir, ensureDefaultWorkspacesDir } from '@craft-agent/shared/workspaces'
import { getLongRunningHealthSnapshot } from '@craft-agent/shared/processes'
import type { ServerStatus, ServerHealth } from '@craft-agent/core/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.CREATE_WORKSPACE,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.server.HOME_DIR,
] as const

export function registerServerHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx: ServerHandlerContext,
): void {
  const { sessionManager } = deps

  // -----------------------------------------------------------------------
  // Workspace discovery (moved from workspace.ts — server-level, no workspace context)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_WORKSPACES, async (requestContext) => {
    const allWorkspaces = sessionManager.getWorkspacesInfo()
    const workspaces = requestContext.allowedWorkspaceIds === '*'
      ? allWorkspaces
      : allWorkspaces.filter((workspace) => requestContext.allowedWorkspaceIds.includes(workspace.id))
    deps.platform.logger.info(`[server:getWorkspaces] returning ${workspaces.length} workspaces: ${JSON.stringify(workspaces.map(w => ({ id: w.id, name: w.name })))}`)
    return workspaces
  })

  server.handle(RPC_CHANNELS.server.CREATE_WORKSPACE, async (_ctx, name: string) => {
    if (!name?.trim()) throw new Error('Workspace name is required')
    const trimmed = name.trim()

    const slug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || 'workspace'

    ensureDefaultWorkspacesDir()
    const baseDir = getDefaultWorkspacesDir()
    let rootPath = join(baseDir, slug)
    let uniqueSlug = slug
    let counter = 1
    while (existsSync(rootPath)) {
      uniqueSlug = `${slug}-${counter++}`
      rootPath = join(baseDir, uniqueSlug)
    }

    const workspace = addWorkspace({ name: trimmed, rootPath })
    setActiveWorkspace(workspace.id)
    deps.platform.logger.info(`Created workspace "${trimmed}" at ${rootPath} (server:createWorkspace)`)

    const { rootPath: _rp, createdAt: _ca, ...info } = workspace
    return info
  })

  // -----------------------------------------------------------------------
  // Server Status
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_STATUS, async (requestContext) => {
    const allWorkspaces = sessionManager.getWorkspacesInfo()
    const workspaces = requestContext.allowedWorkspaceIds === '*'
      ? allWorkspaces
      : allWorkspaces.filter((workspace) => requestContext.allowedWorkspaceIds.includes(workspace.id))
    const workspaceStatuses = workspaces.map(ws => {
      const summary = sessionManager.getWorkspaceAutomationSummary(ws.id)
      return {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        activeSessions: sessionManager.getActiveSessionCount(ws.id),
        automationCount: summary.automationCount,
        schedulerRunning: summary.schedulerRunning,
      }
    })

    const mem = process.memoryUsage()
    const processHealth = getLongRunningHealthSnapshot()
    const status: ServerStatus = {
      serverId: serverCtx.serverId,
      version: deps.platform.appVersion,
      uptime: Math.round((Date.now() - serverCtx.startedAt) / 1000),
      connectedClients: serverCtx.getConnectedClientCount(),
      workspaces: workspaceStatuses,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
      },
      longRunning: {
        status: processHealth.status,
        parent: {
          pid: processHealth.parent.pid,
          cpuPercent: processHealth.parent.cpuPercent,
          cpuCount: processHealth.parent.cpuCount,
          rssBytes: processHealth.parent.rssBytes,
        },
        summary: processHealth.summary,
        processes: processHealth.processes.map((child) => ({
          id: child.id,
          kind: child.kind,
          ownerId: child.ownerId,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          status: child.status,
          idleForMs: child.idleForMs,
          maxIdleMs: child.maxIdleMs,
          ...(child.cpuPercent !== undefined ? { cpuPercent: child.cpuPercent } : {}),
          ...(child.rssBytes !== undefined ? { rssBytes: child.rssBytes } : {}),
          ...(child.terminationReason !== undefined ? { terminationReason: child.terminationReason } : {}),
        })),
        suspectedOrphanPids: processHealth.suspectedOrphanPids,
        ...(processHealth.reportError ? { reportError: processHealth.reportError } : {}),
      },
    }

    return status
  })

  // -----------------------------------------------------------------------
  // Server Health
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_HEALTH, async () => {
    return getHealthCheck(deps)
  })

  // -----------------------------------------------------------------------
  // Active Session Discovery
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_ACTIVE_SESSIONS, async (requestContext) => {
    const sessions = sessionManager.getActiveSessionsInfo()
    return requestContext.allowedWorkspaceIds === '*'
      ? sessions
      : sessions.filter((session) => requestContext.allowedWorkspaceIds.includes(session.workspaceId))
  })

  // -----------------------------------------------------------------------
  // Server Home Directory (REMOTE_ELIGIBLE — returns this server's home)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.HOME_DIR, async () => {
    return homedir()
  })
}

// ---------------------------------------------------------------------------
// Health check logic (reusable by both RPC handler and HTTP endpoint)
// ---------------------------------------------------------------------------

export function getHealthCheck(deps: {
  sessionManager: { getWorkspaces(): readonly unknown[] }
}): ServerHealth {
  const checks: ServerHealth['checks'] = []

  // Check 1: SessionManager is operational (has loaded workspaces)
  try {
    const workspaces = deps.sessionManager.getWorkspaces()
    checks.push({
      name: 'session_manager',
      status: 'pass',
      message: `${workspaces.length} workspace(s) loaded`,
    })
  } catch {
    checks.push({
      name: 'session_manager',
      status: 'fail',
      message: 'SessionManager not initialized',
    })
  }

  // Check 2: Memory usage (warn if heap exceeds 1.5GB)
  const mem = process.memoryUsage()
  const heapGB = mem.heapUsed / (1024 * 1024 * 1024)
  checks.push({
    name: 'memory',
    status: heapGB < 1.5 ? 'pass' : 'fail',
    message: `Heap: ${Math.round(heapGB * 100) / 100} GB`,
  })

  // Check 3: registered child processes, idle cleanup, and orphan detection.
  const processHealth = getLongRunningHealthSnapshot()
  checks.push({
    name: 'long_running_processes',
    status: processHealth.status === 'ok'
      ? 'pass'
      : processHealth.status === 'degraded'
        ? 'warn'
        : 'fail',
    message: `${processHealth.summary.running} running, ${processHealth.summary.failed} failed, ${processHealth.summary.suspectedOrphans} suspected orphan(s); parent CPU ${processHealth.parent.cpuPercent}% / RSS ${Math.round(processHealth.parent.rssBytes / (1024 * 1024))} MB${processHealth.reportError ? `; report error: ${processHealth.reportError}` : ''}`,
  })

  // Aggregate status
  const anyFail = checks.some(c => c.status === 'fail')
  const anyWarn = checks.some(c => c.status === 'warn')

  return {
    status: anyFail ? 'unhealthy' : anyWarn ? 'degraded' : 'ok',
    checks,
  }
}
