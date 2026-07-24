import type { ExecutionTelemetryEvent } from '@craft-agent/core/types'

type OtlpScalar = string | number | boolean

interface OtlpAttribute {
  key: string
  value: {
    stringValue?: string
    intValue?: string
    doubleValue?: number
    boolValue?: boolean
  }
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
}

export interface ExecutionTelemetrySink {
  emit(event: ExecutionTelemetryEvent): Promise<void>
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

function eventAttributes(event: ExecutionTelemetryEvent): OtlpAttribute[] {
  const shared = compactAttributes([
    attribute('robb.schema_version', event.schemaVersion),
    attribute('robb.event_id', event.eventId),
    attribute('robb.event_name', event.name),
    attribute('robb.workspace_id', event.correlation.workspaceId),
    attribute('robb.mission_id', event.correlation.missionId),
    attribute('robb.session_id', event.correlation.sessionId),
    attribute('robb.turn_id', event.correlation.turnId),
    attribute('robb.tool_call_id', event.correlation.toolCallId),
  ])

  switch (event.name) {
    case 'session.started':
    case 'session.completed':
    case 'turn.started':
    case 'turn.completed':
      return [...shared, ...compactAttributes([
        attribute('robb.outcome', event.outcome),
        attribute('robb.duration_ms', event.durationMs),
      ])]
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return [...shared, ...compactAttributes([
        attribute('robb.tool_name', event.toolName),
        attribute('robb.outcome', event.outcome),
        attribute('robb.duration_ms', event.durationMs),
        attribute('robb.error_code', event.errorCode),
      ])]
    case 'routing.selected':
    case 'routing.fallback':
      return [...shared, ...compactAttributes([
        attribute('robb.connection_slug', event.connectionSlug),
        attribute('robb.provider_type', event.providerType),
        attribute('robb.model', event.model),
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
  }
}

function resourceAttributes(config: OtlpTelemetryConfig): OtlpAttribute[] {
  return compactAttributes([
    attribute('service.name', config.serviceName),
    attribute('service.version', config.serviceVersion),
    attribute('telemetry.sdk.name', 'robb-agents'),
  ])
}

function metricPoints(event: ExecutionTelemetryEvent, attributes: OtlpAttribute[]): Array<Record<string, unknown>> {
  const timeUnixNano = toUnixNano(event.timestamp)
  const points: Array<Record<string, unknown>> = [
    {
      name: 'robb.execution.events',
      unit: '1',
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [{ attributes, timeUnixNano, asInt: '1' }],
      },
    },
  ]

  if ('durationMs' in event && typeof event.durationMs === 'number') {
    points.push({
      name: 'robb.execution.duration',
      unit: 'ms',
      gauge: {
        dataPoints: [{ attributes, timeUnixNano, asDouble: event.durationMs }],
      },
    })
  }

  if (event.name === 'cost.recorded') {
    const costs: Array<[string, string, number | undefined]> = [
      ['robb.cost.estimated', 'USD', event.estimatedCostUsd],
      ['robb.cost.actual', 'USD', event.actualCostUsd],
      ['robb.cost.estimated', 'EUR', event.estimatedCostEur],
      ['robb.cost.actual', 'EUR', event.actualCostEur],
    ]
    for (const [name, currency, value] of costs) {
      if (typeof value !== 'number') continue
      points.push({
        name,
        unit: currency,
        gauge: {
          dataPoints: [{ attributes, timeUnixNano, asDouble: value }],
        },
      })
    }
  }

  return points
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

export function buildOtlpPayloads(
  event: ExecutionTelemetryEvent,
  config: OtlpTelemetryConfig,
): OtlpPayloads {
  const attributes = eventAttributes(event)
  const resource = { attributes: resourceAttributes(config) }
  const timeUnixNano = toUnixNano(event.timestamp)
  const durationMs = 'durationMs' in event && typeof event.durationMs === 'number'
    ? Math.max(0, event.durationMs)
    : 0
  const startTimeUnixNano = toUnixNano(event.timestamp - durationMs)
  const isFailure = ('outcome' in event && event.outcome === 'failed') || event.name === 'tool.failed'
  const signals = {
    logs: config.signals?.logs ?? true,
    traces: config.signals?.traces ?? true,
    metrics: config.signals?.metrics ?? true,
  }

  return {
    ...(signals.logs
      ? {
          logs: {
            resourceLogs: [{
              resource,
              scopeLogs: [{
                scope: { name: 'robb-agents.execution', version: '1' },
                logRecords: [{
                  timeUnixNano,
                  severityNumber: isFailure ? 17 : 9,
                  severityText: isFailure ? 'ERROR' : 'INFO',
                  body: { stringValue: event.name },
                  attributes,
                }],
              }],
            }],
          },
        }
      : {}),
    ...(signals.traces
      ? {
          traces: {
            resourceSpans: [{
              resource,
              scopeSpans: [{
                scope: { name: 'robb-agents.execution', version: '1' },
                spans: [{
                  traceId: stableHex(event.correlation.sessionId, 32),
                  spanId: stableHex(event.eventId, 16),
                  name: event.name,
                  kind: 1,
                  startTimeUnixNano,
                  endTimeUnixNano: timeUnixNano,
                  attributes,
                  status: { code: isFailure ? 2 : 1 },
                }],
              }],
            }],
          },
        }
      : {}),
    ...(signals.metrics
      ? {
          metrics: {
            resourceMetrics: [{
              resource,
              scopeMetrics: [{
                scope: { name: 'robb-agents.execution', version: '1' },
                metrics: metricPoints(event, attributes),
              }],
            }],
          },
        }
      : {}),
  }
}

function signalUrl(endpoint: string, signal: 'logs' | 'traces' | 'metrics'): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`
}

export class OtlpHttpTelemetrySink implements ExecutionTelemetrySink {
  private readonly fetchFn: TelemetryFetch

  constructor(
    private readonly config: OtlpTelemetryConfig,
    fetchFn: TelemetryFetch = fetch,
  ) {
    this.fetchFn = fetchFn
  }

  async emit(event: ExecutionTelemetryEvent): Promise<void> {
    if (!this.config.enabled) return

    const payloads = buildOtlpPayloads(event, this.config)
    const entries = Object.entries(payloads) as Array<
      ['logs' | 'traces' | 'metrics', Record<string, unknown>]
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
}

export class DisabledTelemetrySink implements ExecutionTelemetrySink {
  async emit(_event: ExecutionTelemetryEvent): Promise<void> {}
}
