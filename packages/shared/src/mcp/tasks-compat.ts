import type { CanonicalTaskSnapshot } from '../interop/canonical-task.ts'
import { toMcpCanonicalTaskStatus } from '../interop/canonical-task.ts'
import { MCP_TASKS_EXTENSION, type McpWireEra } from './protocol-eras.ts'

export type McpTaskWireStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface McpJsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface McpTaskWireBase {
  taskId: string
  status: McpTaskWireStatus
  statusMessage?: string
  createdAt: string
  lastUpdatedAt: string
}

/** Task object used by the experimental core Tasks primitive in MCP 2025-11-25. */
export interface McpLegacyTaskWire extends McpTaskWireBase {
  ttl: number
}

/** Flat task/result object used by the io.modelcontextprotocol/tasks extension. */
export interface McpModernTaskWire extends McpTaskWireBase {
  resultType: 'task' | 'complete'
  ttlMs: number | null
  pollIntervalMs?: number
  inputRequests?: Record<string, unknown>
  result?: unknown
  error?: McpJsonRpcError
}

interface McpTaskProjectionBaseOptions {
  createdAt?: string
  pollIntervalMs?: number
}

export interface McpLegacyTaskProjectionOptions extends McpTaskProjectionBaseOptions {
  era: 'legacy'
  ttlMs: number
}

export interface McpModernTaskProjectionOptions extends McpTaskProjectionBaseOptions {
  era: 'modern'
  operation: 'create' | 'get'
  ttlMs: number | null
  inputRequests?: Record<string, unknown>
  result?: unknown
  error?: McpJsonRpcError
}

export type McpTaskProjectionOptions =
  | McpLegacyTaskProjectionOptions
  | McpModernTaskProjectionOptions

export interface McpTasksExtensionDescriptor {
  /** Null in 2025, where Tasks was an experimental core primitive. */
  extensionId: typeof MCP_TASKS_EXTENSION | null
  era: McpWireEra
  methods: readonly string[]
}

/**
 * Runtime-neutral descriptor used by adapters without importing either SDK
 * generation's removed/experimental Tasks registry.
 */
export const MCP_TASKS_COMPATIBILITY: Readonly<Record<McpWireEra, McpTasksExtensionDescriptor>> = {
  legacy: {
    extensionId: null,
    era: 'legacy',
    methods: ['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel'],
  },
  modern: {
    extensionId: MCP_TASKS_EXTENSION,
    era: 'modern',
    methods: ['tasks/get', 'tasks/update', 'tasks/cancel'],
  },
}

function validTimestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO-8601 timestamp`)
  }
  return value
}

function validTtl(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('MCP task TTL must be a non-negative safe integer or null')
  }
  return value
}

function validPollInterval(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('MCP task poll interval must be a non-negative safe integer')
  }
  return value
}

export function projectCanonicalTaskToMcp(
  snapshot: CanonicalTaskSnapshot,
  options: McpLegacyTaskProjectionOptions,
): McpLegacyTaskWire
export function projectCanonicalTaskToMcp(
  snapshot: CanonicalTaskSnapshot,
  options: McpModernTaskProjectionOptions,
): McpModernTaskWire
export function projectCanonicalTaskToMcp(
  snapshot: CanonicalTaskSnapshot,
  options: McpTaskProjectionOptions,
): McpLegacyTaskWire | McpModernTaskWire {
  const createdAt = validTimestamp(options.createdAt ?? snapshot.updatedAt, 'MCP task createdAt')
  const lastUpdatedAt = validTimestamp(snapshot.updatedAt, 'MCP task lastUpdatedAt')
  const pollIntervalMs = validPollInterval(options.pollIntervalMs)
  const common: McpTaskWireBase = {
    taskId: snapshot.id,
    status: toMcpCanonicalTaskStatus(snapshot.status),
    ...(snapshot.error ? { statusMessage: snapshot.error } : {}),
    createdAt,
    lastUpdatedAt,
  }

  if (options.era === 'legacy') {
    return {
      ...common,
      ttl: validTtl(options.ttlMs) as number,
    }
  }

  const modern: McpModernTaskWire = {
    ...common,
    resultType: options.operation === 'create' ? 'task' : 'complete',
    ttlMs: validTtl(options.ttlMs),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  }
  if (options.operation === 'create') return modern

  if (modern.status === 'completed') {
    modern.result = Object.hasOwn(options, 'result') ? options.result : (snapshot.output ?? {})
  } else if (modern.status === 'failed') {
    modern.error = options.error ?? {
      code: -32603,
      message: snapshot.error ?? 'Task failed',
    }
  } else if (modern.status === 'input_required') {
    modern.inputRequests = options.inputRequests ?? {}
  }
  return modern
}
