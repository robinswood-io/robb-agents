import type {
  GenerationTelemetryEvent,
  TelemetryCorrelation,
} from './execution-telemetry'

export type GenerationTerminalName =
  | 'generation.completed'
  | 'generation.failed'
  | 'generation.cancelled'

export interface GenerationStartInput {
  eventId: string
  timestamp: number
  correlation: TelemetryCorrelation & {
    turnId: string
    generationId: string
  }
  providerType?: string
  model?: string
  inputTokens?: number
}

export interface GenerationTerminalInput {
  eventId: string
  timestamp: number
  name: GenerationTerminalName
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  cachedInputTokens?: number | undefined
  cacheWriteTokens?: number | undefined
  reasoningTokens?: number | undefined
  cacheHit?: boolean | undefined
  errorCode?: string | undefined
}

interface ActiveGeneration {
  startedAt: number
  correlation: GenerationStartInput['correlation']
  providerType?: string
  model?: string
  inputTokens?: number
}

function terminalOutcome(
  name: GenerationTerminalName,
): 'success' | 'failed' | 'cancelled' {
  if (name === 'generation.completed') return 'success'
  if (name === 'generation.failed') return 'failed'
  return 'cancelled'
}

/**
 * Small runtime state machine for generation telemetry.
 *
 * A generation can transition from active to terminal only once. Removing the
 * active entry before returning the terminal event makes duplicate callbacks,
 * timeout races and late provider events harmless.
 */
export class GenerationTelemetryLifecycle {
  private readonly active = new Map<string, ActiveGeneration>()

  start(input: GenerationStartInput): GenerationTelemetryEvent {
    const generationId = input.correlation.generationId
    if (this.active.has(generationId)) {
      throw new Error(`Generation telemetry '${generationId}' is already active`)
    }

    this.active.set(generationId, {
      startedAt: input.timestamp,
      correlation: input.correlation,
      ...(input.providerType !== undefined ? { providerType: input.providerType } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    })

    return {
      schemaVersion: 1,
      eventId: input.eventId,
      timestamp: input.timestamp,
      name: 'generation.started',
      correlation: input.correlation,
      ...(input.providerType !== undefined ? { providerType: input.providerType } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    }
  }

  finish(
    generationId: string,
    input: GenerationTerminalInput,
  ): GenerationTelemetryEvent | undefined {
    const active = this.active.get(generationId)
    if (!active) return undefined

    this.active.delete(generationId)
    const optionalInputTokens = input.inputTokens ?? active.inputTokens;
    return {
      schemaVersion: 1,
      eventId: input.eventId,
      timestamp: input.timestamp,
      name: input.name,
      correlation: active.correlation,
      ...(active.providerType !== undefined ? { providerType: active.providerType } : {}),
      ...(active.model !== undefined ? { model: active.model } : {}),
      outcome: terminalOutcome(input.name),
      durationMs: Math.max(0, input.timestamp - active.startedAt),
      ...(optionalInputTokens !== undefined ? { inputTokens: optionalInputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cachedInputTokens !== undefined ? { cachedInputTokens: input.cachedInputTokens } : {}),
      ...(input.cacheWriteTokens !== undefined ? { cacheWriteTokens: input.cacheWriteTokens } : {}),
      ...(input.reasoningTokens !== undefined ? { reasoningTokens: input.reasoningTokens } : {}),
      ...(input.cacheHit !== undefined ? { cacheHit: input.cacheHit } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    }
  }

  isActive(generationId: string): boolean {
    return this.active.has(generationId)
  }
}

export function parseCompactionInputTokens(message: string): number | undefined {
  const lowerMessage = message.toLowerCase()
  const markerIndex = lowerMessage.indexOf('from')
  if (markerIndex === -1) return undefined

  let cursor = markerIndex + 'from'.length
  if (cursor < message.length && message[cursor]?.trim().length !== 0) return undefined
  while (cursor < message.length && message[cursor]?.trim().length === 0) cursor++
  if (message[cursor] === '~') cursor++

  let normalized = ''
  while (cursor < message.length) {
    const character = message[cursor]!
    if (character >= '0' && character <= '9') normalized += character
    else if (character !== ',' && character.trim().length !== 0) break
    cursor++
  }
  while (cursor < message.length && message[cursor]?.trim().length === 0) cursor++
  if (!lowerMessage.startsWith('token', cursor) || normalized.length === 0) return undefined
  const parsed = Number.parseInt(normalized, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
