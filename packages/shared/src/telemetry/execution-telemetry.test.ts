import { describe, expect, it } from 'bun:test'
import type { CostTelemetryEvent, ToolTelemetryEvent } from '@craft-agent/core/types'
import {
  buildOtlpPayloads,
  DisabledTelemetrySink,
  OtlpHttpTelemetrySink,
  type OtlpTelemetryConfig,
  type TelemetryFetch,
  resolveOtlpTelemetryConfig,
} from './execution-telemetry'

const config: OtlpTelemetryConfig = {
  enabled: true,
  endpoint: 'https://collector.example.test',
  serviceName: 'robb-agents',
  serviceVersion: '1.0.0',
}

const toolEvent: ToolTelemetryEvent = {
  schemaVersion: 1,
  eventId: 'event-1',
  timestamp: 1_753_286_400_000,
  name: 'tool.completed',
  correlation: {
    workspaceId: 'workspace-1',
    missionId: 'mission-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
  },
  toolName: 'read_file',
  outcome: 'success',
  durationMs: 42,
}

describe('buildOtlpPayloads', () => {
  it('builds logs, traces and metrics with correlated operational metadata', () => {
    const payloads = buildOtlpPayloads(toolEvent, config)
    const serialized = JSON.stringify(payloads)

    expect(payloads.logs).toBeDefined()
    expect(payloads.traces).toBeDefined()
    expect(payloads.metrics).toBeDefined()
    expect(serialized).toContain('mission-1')
    expect(serialized).toContain('tool-call-1')
    expect(serialized).toContain('robb.execution.duration')
  })

  it('does not serialize unapproved content or secret-shaped extra fields', () => {
    const runtimeEvent = {
      ...toolEvent,
      content: 'prompt secret',
      toolInput: { apiKey: 'secret-key' },
      toolResult: 'private output',
    }
    const serialized = JSON.stringify(buildOtlpPayloads(runtimeEvent, config))

    expect(serialized).not.toContain('prompt secret')
    expect(serialized).not.toContain('secret-key')
    expect(serialized).not.toContain('private output')
  })

  it('exports cost provenance as whitelisted attributes and metrics', () => {
    const event: CostTelemetryEvent = {
      schemaVersion: 1,
      eventId: 'event-cost',
      timestamp: 1_753_286_400_000,
      name: 'cost.recorded',
      correlation: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
      },
      source: 'sdk',
      estimatedCostUsd: 0.5,
      estimatedCostEur: 0.45,
      pricingCatalogVersion: 'sdk-2026-07-01',
      exchangeRateAsOf: '2026-07-23',
      exchangeRateSource: 'ECB',
    }
    const serialized = JSON.stringify(buildOtlpPayloads(event, config))

    expect(serialized).toContain('sdk-2026-07-01')
    expect(serialized).toContain('2026-07-23')
    expect(serialized).toContain('robb.cost.estimated')
  })
})

describe('telemetry sinks', () => {
  it('is a no-op when disabled', async () => {
    let calls = 0
    const fetchFn: TelemetryFetch = async () => {
      calls += 1
      return new Response(null, { status: 200 })
    }

    await new OtlpHttpTelemetrySink({ ...config, enabled: false }, fetchFn).emit(toolEvent)
    await new DisabledTelemetrySink().emit(toolEvent)

    expect(calls).toBe(0)
  })

  it('posts each enabled OTLP signal to the standard endpoint', async () => {
    const urls: string[] = []
    const fetchFn: TelemetryFetch = async (input) => {
      urls.push(String(input))
      return new Response(null, { status: 200 })
    }

    await new OtlpHttpTelemetrySink(config, fetchFn).emit(toolEvent)

    expect(urls.sort()).toEqual([
      'https://collector.example.test/v1/logs',
      'https://collector.example.test/v1/metrics',
      'https://collector.example.test/v1/traces',
    ])
  })
})

describe('resolveOtlpTelemetryConfig', () => {
  it('enables only explicitly listed workspaces', () => {
    const environment = {
      ROBB_OTLP_ENDPOINT: 'https://collector.example.test/',
      ROBB_OTLP_ENABLED_WORKSPACES: 'workspace-1,workspace-2',
      ROBB_OTLP_HEADERS_JSON: '{"authorization":"Bearer test"}',
      ROBB_OTLP_SIGNALS: 'logs,metrics',
      ROBB_OTLP_SERVICE_VERSION: '1.2.3',
    }

    expect(resolveOtlpTelemetryConfig(environment, 'workspace-1')).toEqual({
      enabled: true,
      endpoint: 'https://collector.example.test/',
      serviceName: 'robb-agents',
      serviceVersion: '1.2.3',
      headers: { authorization: 'Bearer test' },
      signals: { logs: true, traces: false, metrics: true },
    })
    expect(resolveOtlpTelemetryConfig(environment, 'workspace-3').enabled).toBe(false)
  })

  it('fails closed for invalid endpoints, headers or missing workspace consent', () => {
    expect(resolveOtlpTelemetryConfig({
      ROBB_OTLP_ENDPOINT: 'file:///tmp/collector',
      ROBB_OTLP_ENABLED_WORKSPACES: '*',
    }, 'workspace-1').enabled).toBe(false)

    const configWithInvalidHeaders = resolveOtlpTelemetryConfig({
      ROBB_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      ROBB_OTLP_ENABLED_WORKSPACES: 'workspace-1',
      ROBB_OTLP_HEADERS_JSON: '{"authorization":"value\\nsmuggled"}',
    }, 'workspace-1')
    expect(configWithInvalidHeaders.enabled).toBe(true)
    expect(configWithInvalidHeaders.headers).toBeUndefined()

    expect(resolveOtlpTelemetryConfig({
      ROBB_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    }, 'workspace-1').enabled).toBe(false)
  })
})
