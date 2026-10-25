import { eventAttributes, resourceAttributes, toUnixNano } from './attributes.ts';
import type { OtlpPayloads, OtlpSignal, OtlpTelemetryConfig, RobbExecutionTelemetryEvent } from './contracts.ts';
import { metricPoints } from './metrics.ts';
import { eventScopeId, isFailedEvent, normalizedHex, tracePayload } from './traces.ts';

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

export function mergeOtlpPayloads(payloads: OtlpPayloads[]): OtlpPayloads {
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

export function isOtlpPayloads(value: unknown): value is OtlpPayloads {
  const record = objectValue(value)
  if (!record) return false
  return ['logs', 'traces', 'metrics'].some(signal => objectValue(record[signal]))
}
