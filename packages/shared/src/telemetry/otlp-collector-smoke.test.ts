import { describe, expect, it } from 'bun:test';
import { runOtlpCollectorSmoke } from './otlp-collector-smoke.ts';

describe('OTLP HTTP collector integration', () => {
  it('exports logs, metrics and traces to a live local collector', async () => {
    const result = await runOtlpCollectorSmoke();

    expect(result.endpoint).toStartWith('http://127.0.0.1:');
    expect(result.signals).toEqual(['logs', 'metrics', 'traces']);
    expect(result.requestCount).toBe(3);
    expect(result.correlatedEventId).toBe('otlp-smoke-event');
  });
});
