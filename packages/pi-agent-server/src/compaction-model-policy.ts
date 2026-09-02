export interface CompactionModelCandidate {
  id: string
  provider: string
  contextWindow?: number
}

const COMPACTION_OUTPUT_RESERVE_TOKENS = 16_384
const COMPACTION_CONTEXT_HEADROOM_RATIO = 1.2

/**
 * Use the configured utility model only when it shares the authenticated
 * provider and can hold the full current context with conservative headroom.
 */
export function selectCompactionUtilityModel(input: {
  activeModel?: CompactionModelCandidate
  utilityModel?: CompactionModelCandidate
  contextTokens?: number | null
}): CompactionModelCandidate | undefined {
  const { activeModel, utilityModel } = input
  if (!activeModel || !utilityModel) return undefined
  if (activeModel.id === utilityModel.id && activeModel.provider === utilityModel.provider) return undefined
  if (activeModel.provider !== utilityModel.provider) return undefined
  if (!Number.isFinite(input.contextTokens) || (input.contextTokens ?? 0) <= 0) return undefined
  if (!Number.isFinite(utilityModel.contextWindow) || (utilityModel.contextWindow ?? 0) <= 0) return undefined

  const contextTokens = Math.floor(input.contextTokens as number)
  const requiredWindow = Math.max(
    contextTokens + COMPACTION_OUTPUT_RESERVE_TOKENS,
    Math.ceil(contextTokens * COMPACTION_CONTEXT_HEADROOM_RATIO),
  )
  return (utilityModel.contextWindow as number) >= requiredWindow ? utilityModel : undefined
}

