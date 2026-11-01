/** Existing behavior separated into direct modules by responsibility, preserving the public entry point. */
export type { AdvancedTelemetryCorrelation, TelemetryCorrelation, CoreExecutionTelemetryEvent, RunTelemetryEvent, GenerationTelemetryEvent, RetryTelemetryEvent, CompactionTelemetryEvent, MemoryTelemetryEvent, EvalTelemetryEvent, ExtendedExecutionTelemetryEvent, RobbExecutionTelemetryEvent, OtlpBatchConfig, OtlpTelemetryConfig, ExecutionTelemetrySink, TelemetryFetch, OtlpPayloads, TelemetrySinkStats } from './execution-telemetry/contracts.ts';
export { toPrivacySafeTelemetryRecord } from './execution-telemetry/contracts.ts';
export { LocalJsonlTelemetrySink } from './execution-telemetry/local-sink.ts';
export { resolveOtlpTelemetryConfig } from './execution-telemetry/otlp-config.ts';
export { buildOtlpPayloads } from './execution-telemetry/payloads.ts';
export { TelemetryBackpressureError, OtlpHttpTelemetrySink, DisabledTelemetrySink } from './execution-telemetry/http-sink.ts';
