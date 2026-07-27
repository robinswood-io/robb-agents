import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CostTelemetryEvent, ToolTelemetryEvent } from '@craft-agent/core/types'
import {
  buildOtlpPayloads,
  DisabledTelemetrySink,
  OtlpHttpTelemetrySink,
  type GenerationTelemetryEvent,
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

  it('builds an explicit run/session/turn/generation/tool trace hierarchy', () => {
    const generationEvent: GenerationTelemetryEvent = {
      schemaVersion: 1,
      eventId: 'generation-completed-1',
      timestamp: 1_753_286_400_000,
      name: 'generation.completed',
      correlation: {
        workspaceId: 'workspace-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        generationId: 'generation-1',
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '1111111111111111',
        parentSpanId: '2222222222222222',
      },
      providerType: 'openai',
      model: 'gpt-test',
      outcome: 'success',
      durationMs: 120,
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 30,
      reasoningTokens: 10,
      cacheHit: true,
    }
    const serialized = JSON.stringify(buildOtlpPayloads(generationEvent, config))

    expect(serialized).toContain('"traceId":"0123456789abcdef0123456789abcdef"')
    expect(serialized).toContain('"spanId":"1111111111111111"')
    expect(serialized).toContain('"parentSpanId":"2222222222222222"')
    expect(serialized).toContain('gen_ai.client.token.usage')
    expect(serialized).toContain('cache_read')
    expect(serialized).toContain('reasoning')
    expect(serialized).toContain('robb.generation.cache_hit')
  })

  it('infers a tool parent from generation correlation without serializing payload data', () => {
    const event = {
      ...toolEvent,
      correlation: {
        ...toolEvent.correlation,
        runId: 'run-1',
        generationId: 'generation-1',
      },
      prompt: 'private prompt',
      toolInput: { password: 'private-password' },
    }
    const serialized = JSON.stringify(buildOtlpPayloads(event, config))

    expect(serialized).toContain('parentSpanId')
    expect(serialized).not.toContain('private prompt')
    expect(serialized).not.toContain('private-password')
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

  it('batches multiple events into one request per signal', async () => {
    const bodies: string[] = []
    const fetchFn: TelemetryFetch = async (_input, init) => {
      bodies.push(String(init?.body))
      return new Response(null, { status: 200 })
    }
    const sink = new OtlpHttpTelemetrySink({
      ...config,
      batch: {
        enabled: true,
        maxBatchSize: 2,
        flushIntervalMs: 60_000,
        maxRetries: 0,
      },
    }, fetchFn)

    await sink.emit(toolEvent)
    expect(bodies).toHaveLength(0)
    await sink.emit({
      ...toolEvent,
      eventId: 'event-2',
      timestamp: toolEvent.timestamp + 1,
    })

    expect(bodies).toHaveLength(3)
    expect(bodies.join(' ')).toContain('event-1')
    expect(bodies.join(' ')).toContain('event-2')
    expect(sink.getStats()).toMatchObject({ queued: 0, exported: 2 })
    await sink.shutdown()
  })

  it('retries failed exports with bounded exponential backoff', async () => {
    let calls = 0
    const fetchFn: TelemetryFetch = async () => {
      calls += 1
      return new Response(null, { status: calls <= 3 ? 503 : 200 })
    }
    const sink = new OtlpHttpTelemetrySink({
      ...config,
      batch: {
        enabled: false,
        maxRetries: 1,
        retryBaseMs: 1,
      },
    }, fetchFn)

    await sink.emit(toolEvent)

    expect(calls).toBe(6)
    expect(sink.getStats()).toMatchObject({
      exported: 1,
      exportFailures: 1,
    })
  })

  it('spools whitelisted payloads under backpressure and replays them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robb-telemetry-'))
    const spoolPath = join(directory, 'otlp.jsonl')
    const urls: string[] = []
    const fetchFn: TelemetryFetch = async (input) => {
      urls.push(String(input))
      return new Response(null, { status: 200 })
    }
    const sink = new OtlpHttpTelemetrySink({
      ...config,
      batch: {
        enabled: true,
        maxBatchSize: 100,
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
        maxRetries: 0,
        spoolPath,
      },
    }, fetchFn)
    try {
      await sink.emit(toolEvent)
      const runtimeEvent: ToolTelemetryEvent & { secretSentinel: string } = {
        ...toolEvent,
        eventId: 'event-spooled',
        secretSentinel: 'must-not-be-spooled',
      }
      await sink.emit(runtimeEvent)

      const spooled = await readFile(spoolPath, 'utf8')
      expect(spooled).toContain('event-spooled')
      expect(spooled).not.toContain('must-not-be-spooled')
      expect(sink.getStats()).toMatchObject({ queued: 1, spooled: 1 })

      await sink.flush()
      expect(urls).toHaveLength(6)
      expect(await readFile(spoolPath, 'utf8')).toBe('')
      expect(sink.getStats()).toMatchObject({ queued: 0, exported: 2 })
    } finally {
      await sink.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
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
      batch: {
        enabled: true,
        maxBatchSize: 32,
        flushIntervalMs: 1_000,
        maxQueueSize: 512,
        maxRetries: 3,
        retryBaseMs: 250,
        maxSpoolBytes: 5 * 1024 * 1024,
      },
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
