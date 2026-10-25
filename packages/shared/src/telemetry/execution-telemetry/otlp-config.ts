import type { OtlpTelemetryConfig, ResolvedBatchConfig } from './contracts.ts';

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

export function resolveBatchConfig(config: OtlpTelemetryConfig): ResolvedBatchConfig {
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
