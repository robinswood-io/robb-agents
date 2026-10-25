import type { ExecutionTelemetryCorrelation, ExecutionTelemetryEvent } from "@craft-agent/core/types";

export type OtlpScalar = string | number | boolean

export type OtlpSignal = 'logs' | 'traces' | 'metrics'

type TelemetryOutcome = 'success' | 'cancelled' | 'failed'

export interface OtlpAttribute {
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

const LOCAL_SAFE_FIELDS = new Set([
  'outcome', 'durationMs', 'toolName', 'errorCode',
  'connectionSlug', 'providerType', 'model', 'sensitivity', 'policyRuleIds', 'fallbackReason',
  'permissionKind', 'resolution', 'source',
  'estimatedCostUsd', 'actualCostUsd', 'estimatedCostEur', 'actualCostEur',
  'pricingCatalogVersion', 'exchangeRateAsOf', 'exchangeRateSource',
  'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'cacheHit',
  'component', 'attempt', 'delayMs', 'reasonCode', 'exhausted',
  'reclaimedTokens', 'strategy', 'candidateCount', 'selectedCount',
  'corpusId', 'caseId', 'graderType', 'passed', 'score',
])

/** Strip runtime-only additions before durable local telemetry persistence. */
export function toPrivacySafeTelemetryRecord(event: RobbExecutionTelemetryEvent): Record<string, unknown> {
  const correlation = event.correlation
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    eventId: event.eventId,
    timestamp: event.timestamp,
    name: event.name,
    correlation: {
      workspaceId: correlation.workspaceId,
      sessionId: correlation.sessionId,
      ...(correlation.missionId ? { missionId: correlation.missionId } : {}),
      ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
      ...(correlation.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
      ...(correlation.runId ? { runId: correlation.runId } : {}),
      ...(correlation.generationId ? { generationId: correlation.generationId } : {}),
      ...(correlation.evalRunId ? { evalRunId: correlation.evalRunId } : {}),
    },
  }
  for (const [key, value] of Object.entries(event)) {
    if (LOCAL_SAFE_FIELDS.has(key) && value !== undefined) record[key] = value
  }
  return record
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

export interface ResolvedBatchConfig {
  enabled: boolean
  maxBatchSize: number
  flushIntervalMs: number
  maxQueueSize: number
  maxRetries: number
  retryBaseMs: number
  spoolPath?: string
  maxSpoolBytes: number
}
