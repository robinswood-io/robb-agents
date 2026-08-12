/**
 * Server-level types for headless server operations.
 *
 * These types are used by the `server:` RPC namespace for
 * server status, health checks, active session discovery,
 * and headless configuration bootstrap.
 */

// ---------------------------------------------------------------------------
// Server Status & Health
// ---------------------------------------------------------------------------

export interface ServerStatus {
  serverId: string
  version: string
  uptime: number              // seconds since bootstrap
  connectedClients: number
  workspaces: {
    id: string
    name: string
    slug: string
    activeSessions: number
    automationCount: number
    schedulerRunning: boolean
  }[]
  memory: {
    heapUsed: number          // bytes
    heapTotal: number
    rss: number
  }
  /** Process-lifecycle telemetry for the server and its registered children. */
  longRunning: ServerLongRunningHealth
}

export interface ServerLongRunningProcess {
  id: string
  kind: string
  ownerId: string
  pid?: number
  status: 'running' | 'terminating' | 'exited' | 'failed'
  idleForMs: number
  maxIdleMs: number
  cpuPercent?: number
  rssBytes?: number
  terminationReason?: string
}

export interface ServerLongRunningHealth {
  status: 'ok' | 'degraded' | 'unhealthy'
  parent: {
    pid: number
    cpuPercent: number
    cpuCount: number
    rssBytes: number
  }
  summary: {
    tracked: number
    running: number
    terminating: number
    failed: number
    suspectedOrphans: number
  }
  processes: ServerLongRunningProcess[]
  suspectedOrphanPids: number[]
  reportError?: string
}

export interface ServerHealth {
  status: 'ok' | 'degraded' | 'unhealthy'
  checks: {
    name: string
    status: 'pass' | 'warn' | 'fail'
    message?: string
  }[]
}

// ---------------------------------------------------------------------------
// Active Session Discovery
// ---------------------------------------------------------------------------

/** Session processing state — typed union, not stringly. */
export type SessionProcessingStatus =
  | 'idle'
  | 'processing'
  | 'waiting_input'
  | 'error'
  | 'completed'

/** Server-level active session info (cross-workspace, client-safe). */
export interface ActiveSessionInfo {
  sessionId: string
  workspaceId: string
  workspaceName: string
  title?: string
  status: SessionProcessingStatus
  triggeredBy?: {
    automationName: string
    timestamp: number
  }
  createdAt: number
}
