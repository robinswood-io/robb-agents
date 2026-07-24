import { runOtlpCollectorSmoke } from '../packages/shared/src/telemetry/otlp-collector-smoke.ts';

const result = await runOtlpCollectorSmoke();
console.log(JSON.stringify({
  status: 'passed',
  protocol: 'OTLP/HTTP JSON',
  signals: result.signals,
  requestCount: result.requestCount,
  correlatedEventId: result.correlatedEventId,
}, null, 2));
