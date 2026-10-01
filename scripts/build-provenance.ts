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

export type BuildChannel = 'development' | 'production'

/**
 * Production is opt-in. A plain local build must remain usable from a dirty
 * checkout and must never accidentally advertise itself as a release build.
 */
export function resolveBuildChannel(
  declared: string | undefined,
  devRuntime: string | undefined,
): BuildChannel {
  if (declared?.trim().toLowerCase() === 'production') return 'production'
  if (declared?.trim().toLowerCase() === 'development' || devRuntime === '1') {
    return 'development'
  }
  return 'development'
}

/**
 * Fail closed for an explicitly production build. Declared metadata may fill
 * the gap for a source archive without .git, but it may never hide a checkout
 * that Git itself reports as dirty.
 */
export function assertCleanProductionBuild(
  channel: BuildChannel,
  declaredDirty: string | undefined,
  gitPorcelain: string | undefined,
): void {
  if (channel !== 'production') return

  const declared = parseBuildDirty(declaredDirty)
  if (declaredDirty?.trim() && declared === undefined) {
    throw new Error(`Invalid ROBB_BUILD_DIRTY value for production build: ${declaredDirty}`)
  }
  if (declared === true) {
    throw new Error('Production build refused: source is declared dirty')
  }
  if (gitPorcelain !== undefined && gitPorcelain.trim().length > 0) {
    throw new Error('Production build refused: Git checkout has uncommitted or untracked changes')
  }
  if (gitPorcelain === undefined && declared !== false) {
    throw new Error('Production build refused: clean source state could not be verified')
  }
}

/** Prefer explicit packaging metadata, then the checked-out revision, then CI. */
export function resolveBuildCommit(
  declared: string | undefined,
  gitCommit: string | undefined,
  ciCommit: string | undefined,
): string | undefined {
  return declared?.trim() || gitCommit?.trim() || ciCommit?.trim() || undefined
}
