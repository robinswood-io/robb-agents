import { attribute, toUnixNano } from './attributes.ts';
import type { OtlpAttribute, RobbExecutionTelemetryEvent } from './contracts.ts';

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

export function metricPoints(
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
