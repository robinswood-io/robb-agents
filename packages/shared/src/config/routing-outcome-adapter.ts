import type {
  EvalTelemetryEvent,
  GenerationTelemetryEvent,
  RobbExecutionTelemetryEvent,
} from '../telemetry/execution-telemetry.ts'
import type {
  RoutingOutcome,
  RoutingOutcomeStatus,
} from './routing-outcomes.ts'
import type {
  RoutingCapability,
  RoutingDifficulty,
} from './routing-policy.ts'

export interface RoutingOutcomeAdapterContext {
  connectionSlug: string
  difficulty: RoutingDifficulty
  requiredCapabilities?: RoutingCapability[]
  retryCount?: number
  costUsd?: number
  qualityScore?: number
  workspaceId?: string
  missionId?: string
  sessionId?: string
}

type TerminalGenerationTelemetryEvent = GenerationTelemetryEvent & {
  name:
    | 'generation.completed'
    | 'generation.failed'
    | 'generation.cancelled'
}

function isTerminalGeneration(
  event: RobbExecutionTelemetryEvent,
): event is TerminalGenerationTelemetryEvent {
  return event.name === 'generation.completed'
    || event.name === 'generation.failed'
    || event.name === 'generation.cancelled'
}

function generationStatus(
  event: TerminalGenerationTelemetryEvent,
): RoutingOutcomeStatus {
  if (event.name === 'generation.completed') return 'success'
  if (event.name === 'generation.cancelled') return 'cancelled'
  return 'failure'
}

function evalStatus(event: EvalTelemetryEvent): RoutingOutcomeStatus {
  if (event.passed === true) return 'success'
  if (event.passed === false) return 'failure'
  if (event.score === undefined || event.score <= 0) return 'failure'
  if (event.score >= 1) return 'success'
  return 'partial'
}

/**
 * Converts privacy-minimal runtime/evaluation metadata into routing feedback.
 * The adapter deliberately has no prompt, response or tool-payload inputs.
 */
export function telemetryToRoutingOutcome(
  event: RobbExecutionTelemetryEvent,
  context: RoutingOutcomeAdapterContext,
): RoutingOutcome | undefined {
  const shared = {
    id: event.eventId,
    connectionSlug: context.connectionSlug,
    difficulty: context.difficulty,
    durationMs: 'durationMs' in event && typeof event.durationMs === 'number'
      ? Math.max(0, event.durationMs)
      : 0,
    timestamp: new Date(event.timestamp).toISOString(),
    ...(context.requiredCapabilities
      ? { requiredCapabilities: [...context.requiredCapabilities] }
      : {}),
    ...(typeof context.retryCount === 'number'
      ? { retryCount: context.retryCount }
      : {}),
    ...(typeof context.costUsd === 'number'
      ? { costUsd: context.costUsd }
      : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.missionId ? { missionId: context.missionId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  }

  if (isTerminalGeneration(event)) {
    return {
      ...shared,
      evidenceKind: 'runtime',
      status: generationStatus(event),
      ...(typeof context.qualityScore === 'number'
        ? { qualityScore: context.qualityScore }
        : {}),
      ...(typeof event.inputTokens === 'number'
        ? { inputTokens: event.inputTokens }
        : {}),
      ...(typeof event.outputTokens === 'number'
        ? { outputTokens: event.outputTokens }
        : {}),
    }
  }

  if (event.name === 'eval.recorded') {
    return {
      ...shared,
      evidenceKind: 'eval',
      status: evalStatus(event),
      ...(typeof event.score === 'number'
        ? { qualityScore: event.score }
        : typeof context.qualityScore === 'number'
          ? { qualityScore: context.qualityScore }
          : {}),
    }
  }

  return undefined
}
