import {
  classifyLocalRoutingRequirements,
  maxRoutingSensitivity,
  type RoutingPolicyContext,
  type RoutingSensitivity,
} from '@craft-agent/shared/config'

export interface RoutingRuntimeMessage {
  role: string
  content: string
  isIntermediate?: boolean
  attachments?: Array<{ type: string }>
}

export interface RoutingRuntimeTokenUsage {
  contextTokens?: number
  costUsd?: number
}

export interface RoutingRuntimeContextInput {
  requestedConnectionSlug?: string
  enabledSourceSlugs: string[]
  sourceSensitivities: Array<RoutingSensitivity | undefined>
  messages: RoutingRuntimeMessage[]
  labels?: string[]
  tokenUsage?: RoutingRuntimeTokenUsage
  unavailableConnectionSlugs?: string[]
}

export interface RoutingRuntimeContextResult {
  context: RoutingPolicyContext
  classification: ReturnType<typeof classifyLocalRoutingRequirements>
}

/**
 * Build the privacy-minimal runtime context consumed by routingPolicy.
 *
 * Keeping this pure makes the classifier, source sensitivity and cost
 * projection independently testable instead of embedding them in
 * SessionManager's lifecycle code.
 */
export function buildRoutingRuntimeContext(
  input: RoutingRuntimeContextInput,
): RoutingRuntimeContextResult {
  const latestUserMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === 'user')
  const classification = classifyLocalRoutingRequirements({
    text: latestUserMessage?.content ?? '',
    hasImages: latestUserMessage?.attachments?.some((attachment) => attachment.type === 'image') ?? false,
    requestedToolNames: input.enabledSourceSlugs,
    contextTokens: input.tokenUsage?.contextTokens,
  })
  const completedAssistantTurns = input.messages.filter((message) => (
    (message.role === 'assistant' || message.role === 'plan')
    && !message.isIntermediate
  )).length
  const sessionUsd = input.tokenUsage?.costUsd ?? 0
  const projectedTurnUsd = completedAssistantTurns > 0
    ? sessionUsd / completedAssistantTurns
    : 0

  return {
    classification,
    context: {
      requestedConnectionSlug: input.requestedConnectionSlug,
      sensitivity: maxRoutingSensitivity(input.sourceSensitivities),
      sourceSlugs: input.enabledSourceSlugs,
      tags: input.labels ?? [],
      difficulty: classification.difficulty,
      requiredCapabilities: classification.requiredCapabilities,
      contextTokens: input.tokenUsage?.contextTokens,
      unavailableConnectionSlugs: input.unavailableConnectionSlugs ?? [],
      budgetUsage: {
        sessionUsd,
        projectedTurnUsd,
      },
    },
  }
}
