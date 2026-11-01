import type { OtlpAttribute, OtlpScalar, OtlpTelemetryConfig, RobbExecutionTelemetryEvent } from './contracts.ts';

export function toUnixNano(timestamp: number): string {
  return (BigInt(Math.max(0, Math.trunc(timestamp))) * 1_000_000n).toString()
}

export function attribute(key: string, value: OtlpScalar | undefined): OtlpAttribute | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } }
  return { key, value: { doubleValue: value } }
}

function compactAttributes(values: Array<OtlpAttribute | undefined>): OtlpAttribute[] {
  return values.filter((value): value is OtlpAttribute => value !== undefined)
}

export function eventAttributes(event: RobbExecutionTelemetryEvent): OtlpAttribute[] {
  const shared = compactAttributes([
    attribute('robb.schema_version', event.schemaVersion),
    attribute('robb.event_id', event.eventId),
    attribute('robb.event_name', event.name),
    attribute('robb.workspace_id', event.correlation.workspaceId),
    attribute('robb.run_id', event.correlation.runId),
    attribute('robb.mission_id', event.correlation.missionId),
    attribute('robb.session_id', event.correlation.sessionId),
    attribute('robb.turn_id', event.correlation.turnId),
    attribute('robb.generation_id', event.correlation.generationId),
    attribute('robb.tool_call_id', event.correlation.toolCallId),
    attribute('robb.eval_run_id', event.correlation.evalRunId),
  ])

  switch (event.name) {
    case 'run.started':
    case 'run.completed':
    case 'session.started':
    case 'session.completed':
    case 'turn.started':
    case 'turn.completed':
      return [...shared, ...compactAttributes([
        attribute('robb.outcome', event.outcome),
        attribute('robb.duration_ms', event.durationMs),
      ])]
    case 'generation.started':
    case 'generation.completed':
    case 'generation.failed':
    case 'generation.cancelled':
      return [...shared, ...compactAttributes([
        attribute('gen_ai.system', event.providerType),
        attribute('gen_ai.request.model', event.model),
        attribute('robb.outcome', event.outcome),
        attribute('robb.duration_ms', event.durationMs),
        attribute('robb.input_tokens', event.inputTokens),
        attribute('robb.output_tokens', event.outputTokens),
        attribute('robb.cached_input_tokens', event.cachedInputTokens),
        attribute('robb.cache_write_tokens', event.cacheWriteTokens),
        attribute('robb.reasoning_tokens', event.reasoningTokens),
        attribute('robb.cache_hit', event.cacheHit),
        attribute('robb.error_code', event.errorCode),
      ])]
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return [...shared, ...compactAttributes([
        attribute('gen_ai.tool.name', event.toolName),
        attribute('robb.tool_name', event.toolName),
        attribute('robb.outcome', event.outcome),
        attribute('robb.duration_ms', event.durationMs),
        attribute('robb.error_code', event.errorCode),
      ])]
    case 'routing.selected':
    case 'routing.fallback':
      return [...shared, ...compactAttributes([
        attribute('robb.connection_slug', event.connectionSlug),
        attribute('gen_ai.system', event.providerType),
        attribute('gen_ai.request.model', event.model),
        attribute('robb.sensitivity', event.sensitivity),
        attribute('robb.policy_rule_ids', event.policyRuleIds?.join(',')),
        attribute('robb.fallback_reason', event.fallbackReason),
      ])]
    case 'permission.requested':
    case 'permission.resolved':
      return [...shared, ...compactAttributes([
        attribute('robb.permission_kind', event.permissionKind),
        attribute('robb.permission_resolution', event.resolution),
        attribute('robb.duration_ms', event.durationMs),
      ])]
    case 'cost.recorded':
      return [...shared, ...compactAttributes([
        attribute('robb.cost_source', event.source),
        attribute('robb.estimated_cost_usd', event.estimatedCostUsd),
        attribute('robb.actual_cost_usd', event.actualCostUsd),
        attribute('robb.estimated_cost_eur', event.estimatedCostEur),
        attribute('robb.actual_cost_eur', event.actualCostEur),
        attribute('robb.pricing_catalog_version', event.pricingCatalogVersion),
        attribute('robb.exchange_rate_as_of', event.exchangeRateAsOf),
        attribute('robb.exchange_rate_source', event.exchangeRateSource),
      ])]
    case 'retry.recorded':
      return [...shared, ...compactAttributes([
        attribute('robb.retry_component', event.component),
        attribute('robb.retry_attempt', event.attempt),
        attribute('robb.retry_delay_ms', event.delayMs),
        attribute('robb.retry_reason_code', event.reasonCode),
        attribute('robb.retry_exhausted', event.exhausted),
      ])]
    case 'compaction.recorded':
      return [...shared, ...compactAttributes([
        attribute('robb.compaction_strategy', event.strategy),
        attribute('robb.input_tokens', event.inputTokens),
        attribute('robb.output_tokens', event.outputTokens),
        attribute('robb.reclaimed_tokens', event.reclaimedTokens),
        attribute('robb.duration_ms', event.durationMs),
      ])]
    case 'memory.retrieval':
      return [...shared, ...compactAttributes([
        attribute('robb.memory_strategy', event.strategy),
        attribute('robb.memory_candidate_count', event.candidateCount),
        attribute('robb.memory_selected_count', event.selectedCount),
        attribute('robb.duration_ms', event.durationMs),
        attribute('robb.cache_hit', event.cacheHit),
      ])]
    case 'eval.recorded':
      return [...shared, ...compactAttributes([
        attribute('robb.eval_corpus_id', event.corpusId),
        attribute('robb.eval_case_id', event.caseId),
        attribute('robb.eval_grader_type', event.graderType),
        attribute('robb.eval_passed', event.passed),
        attribute('robb.eval_score', event.score),
        attribute('robb.duration_ms', event.durationMs),
      ])]
  }
}

export function resourceAttributes(config: OtlpTelemetryConfig): OtlpAttribute[] {
  return compactAttributes([
    attribute('service.name', config.serviceName),
    attribute('service.version', config.serviceVersion),
    attribute('telemetry.sdk.name', 'robb-agents'),
  ])
}
