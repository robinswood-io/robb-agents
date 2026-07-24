import type { ToolTelemetryEvent } from '@craft-agent/core/types';
import { OtlpHttpTelemetrySink } from './execution-telemetry.ts';

type OtlpSignal = 'logs' | 'metrics' | 'traces';

export interface OtlpCollectorSmokeResult {
  endpoint: string;
  signals: OtlpSignal[];
  requestCount: number;
  correlatedEventId: string;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function signalFromPath(pathname: string): OtlpSignal | null {
  if (pathname === '/v1/logs') return 'logs';
  if (pathname === '/v1/metrics') return 'metrics';
  if (pathname === '/v1/traces') return 'traces';
  return null;
}

function payloadHasSignal(
  signal: OtlpSignal,
  payload: Record<string, unknown>,
): boolean {
  if (signal === 'logs') return Array.isArray(payload.resourceLogs);
  if (signal === 'metrics') return Array.isArray(payload.resourceMetrics);
  return Array.isArray(payload.resourceSpans);
}

export async function runOtlpCollectorSmoke(): Promise<OtlpCollectorSmokeResult> {
  const received = new Map<OtlpSignal, Record<string, unknown>>();
  const secretSentinel = 'must-never-leave-the-process';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const signal = signalFromPath(new URL(request.url).pathname);
      if (!signal || request.method !== 'POST') {
        return new Response('not found', { status: 404 });
      }
      const parsed: unknown = await request.json();
      const payload = recordValue(parsed);
      if (!payload || !payloadHasSignal(signal, payload)) {
        return new Response('invalid OTLP/HTTP JSON payload', { status: 400 });
      }
      received.set(signal, payload);
      return new Response(null, { status: 200 });
    },
  });

  const event: ToolTelemetryEvent = {
    schemaVersion: 1,
    eventId: 'otlp-smoke-event',
    timestamp: Date.now(),
    name: 'tool.completed',
    correlation: {
      workspaceId: 'otlp-smoke-workspace',
      missionId: 'otlp-smoke-mission',
      sessionId: 'otlp-smoke-session',
      turnId: 'otlp-smoke-turn',
      toolCallId: 'otlp-smoke-tool-call',
    },
    toolName: 'collector_smoke',
    outcome: 'success',
    durationMs: 7,
  };
  const runtimeEvent: ToolTelemetryEvent & { secretSentinel: string } = {
    ...event,
    secretSentinel,
  };

  try {
    await new OtlpHttpTelemetrySink({
      enabled: true,
      endpoint: `http://127.0.0.1:${server.port}`,
      serviceName: 'robb-agents-collector-smoke',
      serviceVersion: '1',
    }, (input, init) => Bun.fetch(input, init)).emit(runtimeEvent);

    const signals = [...received.keys()].sort();
    if (signals.join(',') !== 'logs,metrics,traces') {
      throw new Error(`OTLP collector received incomplete signals: ${signals.join(',')}`);
    }
    const serialized = JSON.stringify([...received.values()]);
    if (!serialized.includes(event.eventId) || !serialized.includes('otlp-smoke-tool-call')) {
      throw new Error('OTLP collector did not receive the correlated event identifiers');
    }
    if (serialized.includes(secretSentinel)) {
      throw new Error('OTLP collector received a non-whitelisted secret field');
    }

    return {
      endpoint: `http://127.0.0.1:${server.port}`,
      signals,
      requestCount: received.size,
      correlatedEventId: event.eventId,
    };
  } finally {
    server.stop(true);
  }
}
