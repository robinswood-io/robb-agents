import type { OtlpAttribute, RobbExecutionTelemetryEvent } from './contracts.ts';

function stableHex(value: string, length: number): string {
  let state = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index)
    state = Math.imul(state, 16777619)
  }
  const chunk = (state >>> 0).toString(16).padStart(8, '0')
  return chunk.repeat(Math.ceil(length / chunk.length)).slice(0, length)
}

export function normalizedHex(value: string | undefined, length: number, fallback: string): string {
  if (value && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value)) {
    return value.toLowerCase()
  }
  return stableHex(value?.trim() || fallback, length)
}

export function eventScopeId(event: RobbExecutionTelemetryEvent): string {
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

export function tracePayload(
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

export function isFailedEvent(event: RobbExecutionTelemetryEvent): boolean {
  if (event.name === 'tool.failed' || event.name === 'generation.failed') return true
  return 'outcome' in event && event.outcome === 'failed'
}
