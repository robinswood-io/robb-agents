import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ExecutionTelemetryCorrelation,
  ExecutionTelemetryEvent,
} from '@craft-agent/core/types'

type OtlpScalar = string | number | boolean
type OtlpSignal = 'logs' | 'traces' | 'metrics'
type TelemetryOutcome = 'success' | 'cancelled' | 'failed'

interface OtlpAttribute {
  key: string
  value: {
    stringValue?: string
    intValue?: string
    doubleValue?: number
    boolValue?: boolean
  }
}

export interface AdvancedTelemetryCorrelation {
  /** Durable run identifier shared by every session participating in a run. */
  runId?: string
  /** Generation identifier shared by generation and nested tool events. */
  generationId?: string
  /** Explicit W3C-compatible trace ID, or an opaque ID that will be hashed. */
  traceId?: string
  /** Explicit W3C-compatible span ID, or an opaque ID that will be hashed. */
  spanId?: string
  /** Parent span ID. Explicit correlation always wins over inferred hierarchy. */
  parentSpanId?: string
  /** Evaluation run identifier used to correlate online and offline quality signals. */
  evalRunId?: string
}

export type TelemetryCorrelation =
  ExecutionTelemetryCorrelation
  & AdvancedTelemetryCorrelation

export type CoreExecutionTelemetryEvent =
  ExecutionTelemetryEvent
  & { correlation: TelemetryCorrelation }

interface ExtendedTelemetryBase {
  schemaVersion: 1
  eventId: string
  timestamp: number
  correlation: TelemetryCorrelation
}

export interface RunTelemetryEvent extends ExtendedTelemetryBase {
  name: 'run.started' | 'run.completed'
  outcome?: TelemetryOutcome
  durationMs?: number
}

export interface GenerationTelemetryEvent extends ExtendedTelemetryBase {
  name:
    | 'generation.started'
    | 'generation.completed'
    | 'generation.failed'
    | 'generation.cancelled'
  providerType?: string
  model?: string
  outcome?: TelemetryOutcome
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  cacheHit?: boolean
  errorCode?: string
}

export interface RetryTelemetryEvent extends ExtendedTelemetryBase {
  name: 'retry.recorded'
  component: 'generation' | 'tool' | 'export' | 'provider' | string
  attempt: number
  delayMs?: number
  reasonCode?: string
  exhausted?: boolean
}

export interface CompactionTelemetryEvent extends ExtendedTelemetryBase {
  name: 'compaction.recorded'
  inputTokens?: number
  outputTokens?: number
  reclaimedTokens?: number
  durationMs?: number
  strategy?: string
}

export interface MemoryTelemetryEvent extends ExtendedTelemetryBase {
  name: 'memory.retrieval'
  strategy: string
  candidateCount?: number
  selectedCount?: number
  durationMs?: number
  cacheHit?: boolean
}

export interface EvalTelemetryEvent extends ExtendedTelemetryBase {
  name: 'eval.recorded'
  corpusId: string
  caseId?: string
  graderType?: 'deterministic' | 'state' | 'trajectory' | 'llm' | 'combined'
  passed?: boolean
  score?: number
  durationMs?: number
}

export type ExtendedExecutionTelemetryEvent =
  | RunTelemetryEvent
  | GenerationTelemetryEvent
  | RetryTelemetryEvent
  | CompactionTelemetryEvent
  | MemoryTelemetryEvent
  | EvalTelemetryEvent

export type RobbExecutionTelemetryEvent =
  | CoreExecutionTelemetryEvent
  | ExtendedExecutionTelemetryEvent

export interface OtlpBatchConfig {
  enabled?: boolean
  maxBatchSize?: number
  flushIntervalMs?: number
  maxQueueSize?: number
  maxRetries?: number
  retryBaseMs?: number
  /** JSONL spool containing only already-whitelisted OTLP payloads. */
  spoolPath?: string
  maxSpoolBytes?: number
}

export interface OtlpTelemetryConfig {
  enabled: boolean
  endpoint: string
  serviceName: string
  serviceVersion?: string
  headers?: Readonly<Record<string, string>>
  signals?: {
    logs?: boolean
    traces?: boolean
    metrics?: boolean
  }
  batch?: OtlpBatchConfig
}

export interface ExecutionTelemetrySink {
  emit(event: RobbExecutionTelemetryEvent): Promise<void>
}

export type TelemetryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface OtlpPayloads {
  logs?: Record<string, unknown>
  traces?: Record<string, unknown>
  metrics?: Record<string, unknown>
}

export interface TelemetrySinkStats {
  queued: number
  exported: number
  spooled: number
  dropped: number
  exportFailures: number
}

interface ResolvedBatchConfig {
  enabled: boolean
  maxBatchSize: number
  flushIntervalMs: number
  maxQueueSize: number
  maxRetries: number
  retryBaseMs: number
  spoolPath?: string
  maxSpoolBytes: number
}

function parseOtlpHeaders(raw: string | undefined): Readonly<Record<string, string>> | undefined {
  if (!raw?.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value !== 'string'
        || key.trim().length === 0
        || /[\r\n]/.test(key)
        || /[\r\n]/.test(value)
      ) {
        return undefined
      }
      headers[key] = value
    }
    return headers
  } catch {
    return undefined
  }
}

function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback
}

/**
 * Resolve a workspace-scoped, opt-in OTLP configuration.
 *
 * Required environment variables:
 * - ROBB_OTLP_ENDPOINT
 * - ROBB_OTLP_ENABLED_WORKSPACES (comma-separated workspace IDs or `*`)
 *
 * Optional:
 * - ROBB_OTLP_HEADERS_JSON
 * - ROBB_OTLP_SERVICE_NAME
 * - ROBB_OTLP_SERVICE_VERSION
 * - ROBB_OTLP_SIGNALS (logs,traces,metrics)
 * - ROBB_OTLP_BATCH_SIZE / ROBB_OTLP_FLUSH_INTERVAL_MS
 * - ROBB_OTLP_MAX_QUEUE_SIZE / ROBB_OTLP_MAX_RETRIES / ROBB_OTLP_RETRY_BASE_MS
 * - ROBB_OTLP_SPOOL_PATH / ROBB_OTLP_MAX_SPOOL_BYTES
 */
export function resolveOtlpTelemetryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  workspaceId: string,
): OtlpTelemetryConfig {
  const endpoint = environment.ROBB_OTLP_ENDPOINT?.trim() ?? ''
  const enabledWorkspaces = (environment.ROBB_OTLP_ENABLED_WORKSPACES ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const enabled = isHttpEndpoint(endpoint)
    && (enabledWorkspaces.includes('*') || enabledWorkspaces.includes(workspaceId))
  const requestedSignals = new Set(
    (environment.ROBB_OTLP_SIGNALS ?? 'logs,traces,metrics')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  )
  const headers = parseOtlpHeaders(environment.ROBB_OTLP_HEADERS_JSON)
  const spoolPath = environment.ROBB_OTLP_SPOOL_PATH?.trim()

  return {
    enabled,
    endpoint,
    serviceName: environment.ROBB_OTLP_SERVICE_NAME?.trim() || 'robb-agents',
    ...(environment.ROBB_OTLP_SERVICE_VERSION?.trim()
      ? { serviceVersion: environment.ROBB_OTLP_SERVICE_VERSION.trim() }
      : {}),
    ...(headers ? { headers } : {}),
    signals: {
      logs: requestedSignals.has('logs'),
      traces: requestedSignals.has('traces'),
      metrics: requestedSignals.has('metrics'),
    },
    batch: {
      enabled: environment.ROBB_OTLP_BATCH_ENABLED?.trim().toLowerCase() !== 'false',
      maxBatchSize: positiveInteger(environment.ROBB_OTLP_BATCH_SIZE, 32, 1_000),
      flushIntervalMs: positiveInteger(environment.ROBB_OTLP_FLUSH_INTERVAL_MS, 1_000, 60_000),
      maxQueueSize: positiveInteger(environment.ROBB_OTLP_MAX_QUEUE_SIZE, 512, 100_000),
      maxRetries: positiveInteger(environment.ROBB_OTLP_MAX_RETRIES, 3, 10),
      retryBaseMs: positiveInteger(environment.ROBB_OTLP_RETRY_BASE_MS, 250, 60_000),
      ...(spoolPath ? { spoolPath } : {}),
      maxSpoolBytes: positiveInteger(
        environment.ROBB_OTLP_MAX_SPOOL_BYTES,
        5 * 1024 * 1024,
        1024 * 1024 * 1024,
      ),
    },
  }
}

function resolveBatchConfig(config: OtlpTelemetryConfig): ResolvedBatchConfig {
  return {
    enabled: config.batch?.enabled ?? false,
    maxBatchSize: Math.max(1, config.batch?.maxBatchSize ?? 32),
    flushIntervalMs: Math.max(1, config.batch?.flushIntervalMs ?? 1_000),
    maxQueueSize: Math.max(1, config.batch?.maxQueueSize ?? 512),
    maxRetries: Math.max(0, config.batch?.maxRetries ?? 3),
    retryBaseMs: Math.max(1, config.batch?.retryBaseMs ?? 250),
    ...(config.batch?.spoolPath?.trim()
      ? { spoolPath: config.batch.spoolPath.trim() }
      : {}),
    maxSpoolBytes: Math.max(1_024, config.batch?.maxSpoolBytes ?? 5 * 1024 * 1024),
  }
}

function toUnixNano(timestamp: number): string {
  return (BigInt(Math.max(0, Math.trunc(timestamp))) * 1_000_000n).toString()
}

function attribute(key: string, value: OtlpScalar | undefined): OtlpAttribute | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } }
  return { key, value: { doubleValue: value } }
}

function compactAttributes(values: Array<OtlpAttribute | undefined>): OtlpAttribute[] {
  return values.filter((value): value is OtlpAttribute => value !== undefined)
}

function eventAttributes(event: RobbExecutionTelemetryEvent): OtlpAttribute[] {
  const shared = compactAttributes([
    attribute('robb.schema_version', event.schemaVersion),
    attribute('robb.event_id', event.eventId),
    attribute('robb.event_name', event.name),
    attribute('robb.workspace_id', event.correlation.workspaceId),
    attribute('robb.run_id', event.correlation.runId),
    attribute('robb.mission_id', event.correlation.missionId),
    attribute('robb.session_id', event.correlation.sessionId),
    attribute('robb.turn_id', event.correlation.turnId),
    attribute('robb.generation_id', event.correlation.generationId),
    attribute('robb.tool_call_id', event.correlation.toolCallId),
    attribute('robb.eval_run_id', event.correlation.evalRunId),
  ])

  switch (event.name) {
    case 'run.started':
    case 'run.completed':
    case 'session.started':
    case 'session.completed':
    case 'turn.started':
    case 'turn.completed':
      return [...shared, ...compactAttributes([
        attribute('robb.outcome', event.outcome),
        attribute('robb.duration_ms', event.durationMs),
      ])]
    case 'generation.started':
    case 'generation.completed':
    case 'generation.failed':
    case 'generation.cancelled':
      return [...shared, ...compactAttributes([
        attribute('gen_ai.system', event.providerType),
        attribute('gen_ai.request.model', event.model),
        attribute('robb.outcome', event.outcome),
        attribute('robb.duration_ms', event.durationMs),
        attribute('robb.input_tokens', event.inputTokens),
        attribute('robb.output_tokens', event.outputTokens),
        attribute('robb.cached_input_tokens', event.cachedInputTokens),
        attribute('robb.cache_write_tokens', event.cacheWriteTokens),
        attribute('robb.reasoning_tokens', event.reasoningTokens),
        attribute('robb.cache_hit', event.cacheHit),
        attribute('robb.error_code', event.errorCode),
      ])]
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return [...shared, ...compactAttributes([
        attribute('gen_ai.tool.name', event.toolName),
        attribute('robb.tool_name', event.toolName),
        attribute('robb.outcome', event.outcome),
        attribute('robb.duration_ms', event.durationMs),
        attribute('robb.error_code', event.errorCode),
      ])]
    case 'routing.selected':
    case 'routing.fallback':
      return [...shared, ...compactAttributes([
        attribute('robb.connection_slug', event.connectionSlug),
        attribute('gen_ai.system', event.providerType),
        attribute('gen_ai.request.model', event.model),
        attribute('robb.sensitivity', event.sensitivity),
        attribute('robb.policy_rule_ids', event.policyRuleIds?.join(',')),
        attribute('robb.fallback_reason', event.fallbackReason),
      ])]
    case 'permission.requested':
    case 'permission.resolved':
      return [...shared, ...compactAttributes([
        attribute('robb.permission_kind', event.permissionKind),
        attribute('robb.permission_resolution', event.resolution),
        attribute('robb.duration_ms', event.durationMs),
      ])]
    case 'cost.recorded':
      return [...shared, ...compactAttributes([
        attribute('robb.cost_source', event.source),
        attribute('robb.estimated_cost_usd', event.estimatedCostUsd),
        attribute('robb.actual_cost_usd', event.actualCostUsd),
        attribute('robb.estimated_cost_eur', event.estimatedCostEur),
        attribute('robb.actual_cost_eur', event.actualCostEur),
        attribute('robb.pricing_catalog_version', event.pricingCatalogVersion),
        attribute('robb.exchange_rate_as_of', event.exchangeRateAsOf),
        attribute('robb.exchange_rate_source', event.exchangeRateSource),
      ])]
    case 'retry.recorded':
      return [...shared, ...compactAttributes([
        attribute('robb.retry_component', event.component),
        attribute('robb.retry_attempt', event.attempt),
        attribute('robb.retry_delay_ms', event.delayMs),
        attribute('robb.retry_reason_code', event.reasonCode),
        attribute('robb.retry_exhausted', event.exhausted),
      ])]
    case 'compaction.recorded':
      return [...shared, ...compactAttributes([
        attribute('robb.compaction_strategy', event.strategy),
        attribute('robb.input_tokens', event.inputTokens),
        attribute('robb.output_tokens', event.outputTokens),
        attribute('robb.reclaimed_tokens', event.reclaimedTokens),
        attribute('robb.duration_ms', event.durationMs),
      ])]
    case 'memory.retrieval':
      return [...shared, ...compactAttributes([
        attribute('robb.memory_strategy', event.strategy),
        attribute('robb.memory_candidate_count', event.candidateCount),
        attribute('robb.memory_selected_count', event.selectedCount),
        attribute('robb.duration_ms', event.durationMs),
        attribute('robb.cache_hit', event.cacheHit),
      ])]
    case 'eval.recorded':
      return [...shared, ...compactAttributes([
        attribute('robb.eval_corpus_id', event.corpusId),
        attribute('robb.eval_case_id', event.caseId),
        attribute('robb.eval_grader_type', event.graderType),
        attribute('robb.eval_passed', event.passed),
        attribute('robb.eval_score', event.score),
        attribute('robb.duration_ms', event.durationMs),
      ])]
  }
}

function resourceAttributes(config: OtlpTelemetryConfig): OtlpAttribute[] {
  return compactAttributes([
    attribute('service.name', config.serviceName),
    attribute('service.version', config.serviceVersion),
    attribute('telemetry.sdk.name', 'robb-agents'),
  ])
}

function metricPoint(
  name: string,
  unit: string,
  value: number,
  timeUnixNano: string,
  attributes: OtlpAttribute[],
  kind: 'gauge' | 'sum' = 'gauge',
): Record<string, unknown> {
  const dataPoint = {
    attributes,
    timeUnixNano,
    ...(Number.isInteger(value) ? { asInt: String(value) } : { asDouble: value }),
  }
  return kind === 'sum'
    ? {
        name,
        unit,
        sum: {
          aggregationTemporality: 1,
          isMonotonic: true,
          dataPoints: [dataPoint],
        },
      }
    : { name, unit, gauge: { dataPoints: [dataPoint] } }
}

function tokenMetric(
  tokenType: string,
  value: number | undefined,
  timeUnixNano: string,
  attributes: OtlpAttribute[],
): Record<string, unknown> | undefined {
  if (typeof value !== 'number') return undefined
  return metricPoint(
    'gen_ai.client.token.usage',
    'token',
    value,
    timeUnixNano,
    [...attributes, attribute('gen_ai.token.type', tokenType)!],
  )
}

function metricPoints(
  event: RobbExecutionTelemetryEvent,
  attributes: OtlpAttribute[],
): Array<Record<string, unknown>> {
  const timeUnixNano = toUnixNano(event.timestamp)
  const points: Array<Record<string, unknown> | undefined> = [
    metricPoint('robb.execution.events', '1', 1, timeUnixNano, attributes, 'sum'),
  ]

  if ('durationMs' in event && typeof event.durationMs === 'number') {
    points.push(metricPoint(
      'robb.execution.duration',
      'ms',
      event.durationMs,
      timeUnixNano,
      attributes,
    ))
  }

  switch (event.name) {
    case 'generation.completed':
    case 'generation.failed':
    case 'generation.cancelled':
      points.push(
        metricPoint('robb.generation.events', '1', 1, timeUnixNano, attributes, 'sum'),
        tokenMetric('input', event.inputTokens, timeUnixNano, attributes),
        tokenMetric('output', event.outputTokens, timeUnixNano, attributes),
        tokenMetric('cache_read', event.cachedInputTokens, timeUnixNano, attributes),
        tokenMetric('cache_write', event.cacheWriteTokens, timeUnixNano, attributes),
        tokenMetric('reasoning', event.reasoningTokens, timeUnixNano, attributes),
      )
      if (typeof event.cacheHit === 'boolean') {
        points.push(metricPoint(
          'robb.generation.cache_hit',
          '1',
          event.cacheHit ? 1 : 0,
          timeUnixNano,
          attributes,
        ))
      }
      break
    case 'tool.completed':
    case 'tool.failed':
      points.push(metricPoint(
        'gen_ai.tool.call.count',
        '1',
        1,
        timeUnixNano,
        attributes,
        'sum',
      ))
      if (typeof event.durationMs === 'number') {
        points.push(metricPoint(
          'gen_ai.tool.call.duration',
          'ms',
          event.durationMs,
          timeUnixNano,
          attributes,
        ))
      }
      break
    case 'retry.recorded':
      points.push(metricPoint('robb.retry.count', '1', 1, timeUnixNano, attributes, 'sum'))
      if (typeof event.delayMs === 'number') {
        points.push(metricPoint('robb.retry.delay', 'ms', event.delayMs, timeUnixNano, attributes))
      }
      break
    case 'compaction.recorded':
      points.push(
        metricPoint('robb.compaction.count', '1', 1, timeUnixNano, attributes, 'sum'),
        tokenMetric('compaction_input', event.inputTokens, timeUnixNano, attributes),
        tokenMetric('compaction_output', event.outputTokens, timeUnixNano, attributes),
        tokenMetric('compaction_reclaimed', event.reclaimedTokens, timeUnixNano, attributes),
      )
      break
    case 'memory.retrieval':
      if (typeof event.candidateCount === 'number') {
        points.push(metricPoint(
          'robb.memory.candidates',
          '1',
          event.candidateCount,
          timeUnixNano,
          attributes,
        ))
      }
      if (typeof event.selectedCount === 'number') {
        points.push(metricPoint(
          'robb.memory.selected',
          '1',
          event.selectedCount,
          timeUnixNano,
          attributes,
        ))
      }
      if (typeof event.cacheHit === 'boolean') {
        points.push(metricPoint(
          'robb.memory.cache_hit',
          '1',
          event.cacheHit ? 1 : 0,
          timeUnixNano,
          attributes,
        ))
      }
      break
    case 'eval.recorded':
      if (typeof event.passed === 'boolean') {
        points.push(metricPoint(
          'robb.eval.passed',
          '1',
          event.passed ? 1 : 0,
          timeUnixNano,
          attributes,
        ))
      }
      if (typeof event.score === 'number') {
        points.push(metricPoint('robb.eval.score', '1', event.score, timeUnixNano, attributes))
      }
      break
    case 'cost.recorded': {
      const costs: Array<[string, string, number | undefined]> = [
        ['robb.cost.estimated', 'USD', event.estimatedCostUsd],
        ['robb.cost.actual', 'USD', event.actualCostUsd],
        ['robb.cost.estimated', 'EUR', event.estimatedCostEur],
        ['robb.cost.actual', 'EUR', event.actualCostEur],
      ]
      for (const [name, currency, value] of costs) {
        if (typeof value === 'number') {
          points.push(metricPoint(name, currency, value, timeUnixNano, attributes))
        }
      }
      break
    }
    default:
      break
  }

  return points.filter((point): point is Record<string, unknown> => point !== undefined)
}

function stableHex(value: string, length: number): string {
  let state = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index)
    state = Math.imul(state, 16777619)
  }
  const chunk = (state >>> 0).toString(16).padStart(8, '0')
  return chunk.repeat(Math.ceil(length / chunk.length)).slice(0, length)
}

function normalizedHex(value: string | undefined, length: number, fallback: string): string {
  if (value && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value)) {
    return value.toLowerCase()
  }
  return stableHex(value?.trim() || fallback, length)
}

function eventScopeId(event: RobbExecutionTelemetryEvent): string {
  switch (event.name) {
    case 'run.started':
    case 'run.completed':
      return `run:${event.correlation.runId ?? event.eventId}`
    case 'session.started':
    case 'session.completed':
      return `session:${event.correlation.sessionId}`
    case 'turn.started':
    case 'turn.completed':
      return `turn:${event.correlation.turnId ?? event.eventId}`
    case 'generation.started':
    case 'generation.completed':
    case 'generation.failed':
    case 'generation.cancelled':
      return `generation:${event.correlation.generationId ?? event.eventId}`
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return `tool:${event.correlation.toolCallId ?? event.eventId}`
    default:
      return `event:${event.eventId}`
  }
}

function inferredParentScopeId(event: RobbExecutionTelemetryEvent): string | undefined {
  if (event.correlation.parentSpanId) return event.correlation.parentSpanId

  switch (event.name) {
    case 'run.started':
    case 'run.completed':
      return undefined
    case 'session.started':
    case 'session.completed':
      return event.correlation.runId ? `run:${event.correlation.runId}` : undefined
    case 'turn.started':
    case 'turn.completed':
      return `session:${event.correlation.sessionId}`
    case 'generation.started':
    case 'generation.completed':
    case 'generation.failed':
    case 'generation.cancelled':
      return event.correlation.turnId
        ? `turn:${event.correlation.turnId}`
        : `session:${event.correlation.sessionId}`
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      if (event.correlation.generationId) {
        return `generation:${event.correlation.generationId}`
      }
      return event.correlation.turnId
        ? `turn:${event.correlation.turnId}`
        : `session:${event.correlation.sessionId}`
    default:
      if (event.correlation.generationId) {
        return `generation:${event.correlation.generationId}`
      }
      if (event.correlation.turnId) return `turn:${event.correlation.turnId}`
      return `session:${event.correlation.sessionId}`
  }
}

function tracePayload(
  event: RobbExecutionTelemetryEvent,
  resource: { attributes: OtlpAttribute[] },
  attributes: OtlpAttribute[],
  startTimeUnixNano: string,
  endTimeUnixNano: string,
  isFailure: boolean,
): Record<string, unknown> | undefined {
  if (event.name.endsWith('.started')) return undefined

  const rootId = event.correlation.runId
    ?? event.correlation.missionId
    ?? event.correlation.sessionId
  const parentScopeId = inferredParentScopeId(event)
  return {
    resourceSpans: [{
      resource,
      scopeSpans: [{
        scope: { name: 'robb-agents.execution', version: '2' },
        spans: [{
          traceId: normalizedHex(event.correlation.traceId, 32, rootId),
          spanId: normalizedHex(
            event.correlation.spanId,
            16,
            eventScopeId(event),
          ),
          ...(parentScopeId
            ? { parentSpanId: normalizedHex(parentScopeId, 16, parentScopeId) }
            : {}),
          name: event.name,
          kind: 1,
          startTimeUnixNano,
          endTimeUnixNano,
          attributes,
          status: { code: isFailure ? 2 : 1 },
        }],
      }],
    }],
  }
}

function isFailedEvent(event: RobbExecutionTelemetryEvent): boolean {
  if (event.name === 'tool.failed' || event.name === 'generation.failed') return true
  return 'outcome' in event && event.outcome === 'failed'
}

export function buildOtlpPayloads(
  event: RobbExecutionTelemetryEvent,
  config: OtlpTelemetryConfig,
): OtlpPayloads {
  const attributes = eventAttributes(event)
  const resource = { attributes: resourceAttributes(config) }
  const timeUnixNano = toUnixNano(event.timestamp)
  const durationMs = 'durationMs' in event && typeof event.durationMs === 'number'
    ? Math.max(0, event.durationMs)
    : 0
  const startTimeUnixNano = toUnixNano(event.timestamp - durationMs)
  const isFailure = isFailedEvent(event)
  const signals = {
    logs: config.signals?.logs ?? true,
    traces: config.signals?.traces ?? true,
    metrics: config.signals?.metrics ?? true,
  }
  const traces = signals.traces
    ? tracePayload(
        event,
        resource,
        attributes,
        startTimeUnixNano,
        timeUnixNano,
        isFailure,
      )
    : undefined

  return {
    ...(signals.logs
      ? {
          logs: {
            resourceLogs: [{
              resource,
              scopeLogs: [{
                scope: { name: 'robb-agents.execution', version: '2' },
                logRecords: [{
                  timeUnixNano,
                  severityNumber: isFailure ? 17 : 9,
                  severityText: isFailure ? 'ERROR' : 'INFO',
                  body: { stringValue: event.name },
                  attributes,
                  ...(traces
                    ? {
                        traceId: normalizedHex(
                          event.correlation.traceId,
                          32,
                          event.correlation.runId
                            ?? event.correlation.missionId
                            ?? event.correlation.sessionId,
                        ),
                        spanId: normalizedHex(
                          event.correlation.spanId,
                          16,
                          eventScopeId(event),
                        ),
                      }
                    : {}),
                }],
              }],
            }],
          },
        }
      : {}),
    ...(traces ? { traces } : {}),
    ...(signals.metrics
      ? {
          metrics: {
            resourceMetrics: [{
              resource,
              scopeMetrics: [{
                scope: { name: 'robb-agents.execution', version: '2' },
                metrics: metricPoints(event, attributes),
              }],
            }],
          },
        }
      : {}),
  }
}

function signalUrl(endpoint: string, signal: OtlpSignal): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.flatMap(item => {
        const record = objectValue(item)
        return record ? [record] : []
      })
    : []
}

function mergeOtlpPayloads(payloads: OtlpPayloads[]): OtlpPayloads {
  const merged: OtlpPayloads = {}
  const roots: ReadonlyArray<[OtlpSignal, string]> = [
    ['logs', 'resourceLogs'],
    ['traces', 'resourceSpans'],
    ['metrics', 'resourceMetrics'],
  ]

  for (const [signal, root] of roots) {
    const records = payloads.flatMap(payload => {
      const signalPayload = objectValue(payload[signal])
      return objectArray(signalPayload?.[root])
    })
    if (records.length > 0) merged[signal] = { [root]: records }
  }
  return merged
}

function isOtlpPayloads(value: unknown): value is OtlpPayloads {
  const record = objectValue(value)
  if (!record) return false
  return ['logs', 'traces', 'metrics'].some(signal => objectValue(record[signal]))
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

export class TelemetryBackpressureError extends Error {
  constructor() {
    super('Telemetry queue is full and no durable spool is configured')
    this.name = 'TelemetryBackpressureError'
  }
}

export class OtlpHttpTelemetrySink implements ExecutionTelemetrySink {
  private readonly fetchFn: TelemetryFetch
  private readonly batchConfig: ResolvedBatchConfig
  private readonly queue: OtlpPayloads[] = []
  private readonly counters: Omit<TelemetrySinkStats, 'queued'> = {
    exported: 0,
    spooled: 0,
    dropped: 0,
    exportFailures: 0,
  }
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushPromise: Promise<void> | undefined
  private spoolOperation: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: OtlpTelemetryConfig,
    fetchFn: TelemetryFetch = fetch,
  ) {
    this.fetchFn = fetchFn
    this.batchConfig = resolveBatchConfig(config)
  }

  getStats(): TelemetrySinkStats {
    return {
      queued: this.queue.length,
      ...this.counters,
    }
  }

  async emit(event: RobbExecutionTelemetryEvent): Promise<void> {
    if (!this.config.enabled) return

    const payloads = buildOtlpPayloads(event, this.config)
    if (!this.batchConfig.enabled) {
      await this.exportWithRetry(payloads)
      this.counters.exported += 1
      return
    }

    if (this.queue.length >= this.batchConfig.maxQueueSize) {
      if (this.batchConfig.spoolPath) {
        await this.appendSpool([payloads])
        this.counters.spooled += 1
        return
      }
      this.counters.dropped += 1
      throw new TelemetryBackpressureError()
    }

    this.queue.push(payloads)
    if (this.queue.length >= this.batchConfig.maxBatchSize) {
      await this.flush()
      return
    }
    this.scheduleFlush()
  }

  async flush(): Promise<void> {
    if (!this.config.enabled) return
    if (this.flushPromise) return this.flushPromise

    this.cancelScheduledFlush()
    this.flushPromise = this.flushInternal().finally(() => {
      this.flushPromise = undefined
      if (this.queue.length > 0) this.scheduleFlush()
    })
    return this.flushPromise
  }

  async shutdown(): Promise<void> {
    this.cancelScheduledFlush()
    while (this.queue.length > 0) await this.flush()
    if (this.batchConfig.spoolPath) await this.replaySpool()
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.queue.length === 0) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, this.batchConfig.flushIntervalMs)
    if (typeof this.flushTimer !== 'number') this.flushTimer.unref()
  }

  private cancelScheduledFlush(): void {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
  }

  private async flushInternal(): Promise<void> {
    if (this.batchConfig.spoolPath) await this.replaySpool()
    if (this.queue.length === 0) return

    const batch = this.queue.splice(0, this.batchConfig.maxBatchSize)
    try {
      await this.exportWithRetry(mergeOtlpPayloads(batch))
      this.counters.exported += batch.length
    } catch (error) {
      if (this.batchConfig.spoolPath) {
        await this.appendSpool(batch)
        this.counters.spooled += batch.length
        return
      }
      this.queue.unshift(...batch)
      throw error
    }
  }

  private async exportWithRetry(payloads: OtlpPayloads): Promise<void> {
    let lastError: Error | undefined
    for (let attempt = 0; attempt <= this.batchConfig.maxRetries; attempt += 1) {
      try {
        await this.exportPayloads(payloads)
        return
      } catch (error) {
        this.counters.exportFailures += 1
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < this.batchConfig.maxRetries) {
          await wait(this.batchConfig.retryBaseMs * (2 ** attempt))
        }
      }
    }
    throw lastError ?? new Error('OTLP export failed')
  }

  private async exportPayloads(payloads: OtlpPayloads): Promise<void> {
    const entries = Object.entries(payloads) as Array<
      [OtlpSignal, Record<string, unknown>]
    >
    await Promise.all(entries.map(async ([signal, payload]) => {
      const response = await this.fetchFn(signalUrl(this.config.endpoint, signal), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(`OTLP ${signal} export failed with HTTP ${response.status}`)
      }
    }))
  }

  private async appendSpool(payloads: OtlpPayloads[]): Promise<void> {
    return this.withSpoolLock(() => this.appendSpoolUnlocked(payloads))
  }

  private async appendSpoolUnlocked(payloads: OtlpPayloads[]): Promise<void> {
    const spoolPath = this.batchConfig.spoolPath
    if (!spoolPath || payloads.length === 0) return

    await mkdir(dirname(spoolPath), { recursive: true })
    const existing = await readFile(spoolPath, 'utf8').catch(() => '')
    const additions = payloads.map(payload => JSON.stringify(payload))
    const lines = [
      ...existing.split('\n').filter(Boolean),
      ...additions,
    ]
    let bytes = 0
    const retained: string[] = []
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!line) continue
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1
      if (bytes + lineBytes > this.batchConfig.maxSpoolBytes) break
      retained.unshift(line)
      bytes += lineBytes
    }
    if (retained.length < lines.length) {
      this.counters.dropped += lines.length - retained.length
    }
    await writeFile(spoolPath, retained.length ? `${retained.join('\n')}\n` : '', {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  private async replaySpool(): Promise<void> {
    return this.withSpoolLock(() => this.replaySpoolUnlocked())
  }

  private async replaySpoolUnlocked(): Promise<void> {
    const spoolPath = this.batchConfig.spoolPath
    if (!spoolPath) return
    const metadata = await stat(spoolPath).catch(() => undefined)
    if (!metadata || metadata.size === 0) return

    const raw = await readFile(spoolPath, 'utf8')
    const payloads = raw
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          const parsed: unknown = JSON.parse(line)
          return isOtlpPayloads(parsed) ? [parsed] : []
        } catch {
          this.counters.dropped += 1
          return []
        }
      })
    if (payloads.length === 0) {
      await writeFile(spoolPath, '', { encoding: 'utf8', mode: 0o600 })
      return
    }

    for (let index = 0; index < payloads.length; index += this.batchConfig.maxBatchSize) {
      const batch = payloads.slice(index, index + this.batchConfig.maxBatchSize)
      await this.exportWithRetry(mergeOtlpPayloads(batch))
      this.counters.exported += batch.length
    }
    await writeFile(spoolPath, '', { encoding: 'utf8', mode: 0o600 })
  }

  private async withSpoolLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.spoolOperation.then(operation, operation)
    this.spoolOperation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export class DisabledTelemetrySink implements ExecutionTelemetrySink {
  async emit(_event: RobbExecutionTelemetryEvent): Promise<void> {}
}
