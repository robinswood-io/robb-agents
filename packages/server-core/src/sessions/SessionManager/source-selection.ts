import type { ManagedSession } from './managed-session.ts';

export interface EffectiveSessionSourceSelection {
  enabledSourceSlugs: string[]
  inheritsWorkspaceSourceSlugs: boolean
}

/** Materialize the current workspace fallback while retaining its provenance. */
export function resolveEffectiveSessionSourceSelection(
  explicitSourceSlugs: readonly string[] | undefined,
  workspaceDefaultSourceSlugs: readonly string[] | undefined,
): EffectiveSessionSourceSelection {
  return {
    enabledSourceSlugs: [...(explicitSourceSlugs ?? workspaceDefaultSourceSlugs ?? [])],
    inheritsWorkspaceSourceSlugs: explicitSourceSlugs === undefined,
  }
}

/** Keep inherited source snapshots live without confusing them with a user selection. */
export function refreshInheritedSessionSourceSelection(
  selection: {
    enabledSourceSlugs?: string[]
    inheritsWorkspaceSourceSlugs?: boolean
  },
  workspaceDefaultSourceSlugs: readonly string[] | undefined,
): boolean {
  if (!selection.inheritsWorkspaceSourceSlugs) return false
  const next = [...(workspaceDefaultSourceSlugs ?? [])]
  const current = selection.enabledSourceSlugs ?? []
  if (next.length === current.length
    && next.every((slug, index) => slug === current[index])) {
    return false
  }
  selection.enabledSourceSlugs = next
  return true
}

/** Persist explicit selections only; inherited values are recomputed on reload. */
export function sessionSourceSlugsForPersistence(selection: {
  enabledSourceSlugs?: readonly string[]
  inheritsWorkspaceSourceSlugs?: boolean
}): string[] | undefined {
  return selection.inheritsWorkspaceSourceSlugs
    ? undefined
    : [...(selection.enabledSourceSlugs ?? [])]
}

/** A branch inherits the source selection's provenance from its parent. */
export function resolveBranchedSessionSourceSelection(
  parent: {
    enabledSourceSlugs?: readonly string[]
    inheritsWorkspaceSourceSlugs?: boolean
  },
  workspaceDefaultSourceSlugs: readonly string[] | undefined,
): EffectiveSessionSourceSelection & { persistedSourceSlugs?: string[] } {
  const persistedSourceSlugs = sessionSourceSlugsForPersistence(parent)
  return {
    ...resolveEffectiveSessionSourceSelection(persistedSourceSlugs, workspaceDefaultSourceSlugs),
    ...(persistedSourceSlugs === undefined ? {} : { persistedSourceSlugs }),
  }
}

/**
 * Resolve supportsBranching for a managed session.
 * Prefers the live agent instance; falls back to true for all backends.
 */
export function resolveSupportsBranching(managed: ManagedSession): boolean {
  // If agent is live, use its instance property (authoritative)
  if (managed.agent) {
    return managed.agent.supportsBranching
  }

  return true // default: branching enabled for all backends
}
