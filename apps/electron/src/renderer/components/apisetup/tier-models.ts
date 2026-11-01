export interface PiModelInfo {
  id: string
  name: string
  costInput: number
  costOutput: number
  contextWindow: number
  reasoning: boolean
}

/** Pick smart defaults for 3 tiers from a cost-sorted model list (expensive-first). */
export function pickTierDefaults(models: PiModelInfo[]): { best: string; default_: string; cheap: string } {
  const first = models[0]
  if (!first) return { best: '', default_: '', cheap: '' }
  const best = first.id
  if (models.length === 1) return { best, default_: best, cheap: best }
  const cheap = models.at(-1)?.id ?? best
  // ~40% from the top gives a mid-expensive model (list is top-10 + bottom-10)
  const defaultIdx = Math.min(Math.floor(models.length * 0.4), models.length - 2)
  const default_ = models[defaultIdx]?.id ?? best
  return { best, default_, cheap }
}

export function resolveTierModels(
  models: PiModelInfo[],
  savedModels?: string[],
  recommendedModels?: string[],
): { best: string; default_: string; cheap: string } {
  const costDefaults = pickTierDefaults(models)
  const valid = new Set(models.map(m => m.id))
  const recommended = (recommendedModels ?? []).filter(id => valid.has(id))
  const defaults = {
    best: recommended[0] ?? costDefaults.best,
    default_: recommended[1] ?? costDefaults.default_,
    cheap: recommended[2] ?? costDefaults.cheap,
  }
  const saved = (savedModels ?? []).filter(Boolean)
  if (saved.length === 0) return defaults

  const best = saved[0] && valid.has(saved[0]) ? saved[0] : defaults.best
  const default_ = saved[1] && valid.has(saved[1]) ? saved[1] : defaults.default_
  const cheap = saved[2] && valid.has(saved[2]) ? saved[2] : defaults.cheap

  return { best, default_, cheap }
}
