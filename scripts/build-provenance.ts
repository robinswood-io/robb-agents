/** Parse an explicit build-dirty flag supplied by CI or a packaging wrapper. */
export function parseBuildDirty(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'dirty') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'clean') return false
  return undefined
}

/**
 * Resolve build dirtiness without filesystem access so clean/dirty behavior is
 * deterministic and directly testable. Explicit build metadata wins over git.
 */
export function resolveBuildDirty(
  declared: string | undefined,
  gitPorcelain: string | undefined,
): boolean | undefined {
  const explicit = parseBuildDirty(declared)
  if (explicit !== undefined) return explicit
  if (gitPorcelain === undefined) return undefined
  return gitPorcelain.trim().length > 0
}

/** Prefer explicit packaging metadata, then the checked-out revision, then CI. */
export function resolveBuildCommit(
  declared: string | undefined,
  gitCommit: string | undefined,
  ciCommit: string | undefined,
): string | undefined {
  return declared?.trim() || gitCommit?.trim() || ciCommit?.trim() || undefined
}
