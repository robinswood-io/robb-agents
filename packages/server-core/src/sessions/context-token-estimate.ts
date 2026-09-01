const APPROXIMATE_CHARS_PER_TOKEN = 4
const MAX_CONTEXT_ESTIMATE = 1_000_000

export interface ContextBearingMessage {
  content?: string
  toolResult?: string
}

/**
 * Legacy sessions may persist contextTokens=0 even when their transcript is
 * large. Prefer provider telemetry when available; otherwise derive a bounded
 * estimate from the actual model-visible message and tool-result text.
 */
export function resolveContextTokenEstimate(
  reportedTokens: number | undefined,
  messages: ContextBearingMessage[],
): number {
  if (Number.isFinite(reportedTokens) && (reportedTokens ?? 0) > 0) {
    return Math.floor(reportedTokens as number)
  }

  let characters = 0
  for (const message of messages) {
    characters += message.content?.length ?? 0
    characters += message.toolResult?.length ?? 0
    if (characters >= MAX_CONTEXT_ESTIMATE * APPROXIMATE_CHARS_PER_TOKEN) {
      return MAX_CONTEXT_ESTIMATE
    }
  }
  return Math.min(MAX_CONTEXT_ESTIMATE, Math.ceil(characters / APPROXIMATE_CHARS_PER_TOKEN))
}
