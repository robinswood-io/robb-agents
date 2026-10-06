import type { Session } from '../../shared/types'

export interface SessionCreatedHydrationDeps {
  fetchSession: (sessionId: string) => Promise<Session | null>
  upsertSession: (session: Session) => void
  refreshSessionMetadata: (sessionId: string) => Promise<void>
  onError?: (error: unknown, phase: 'session' | 'metadata') => void
}

/**
 * Hydrate one session_created notification at a time per session. Agent events can
 * arrive first and create a hidden placeholder; the authoritative payload either
 * replaces it or a metadata refresh keeps the placeholder fail-closed.
 */
export function hydrateCreatedSession(
  inFlight: Map<string, Promise<void>>,
  sessionId: string,
  deps: SessionCreatedHydrationDeps,
): Promise<void> {
  const existing = inFlight.get(sessionId)
  if (existing) return existing

  const hydration = (async () => {
    try {
      const session = await deps.fetchSession(sessionId)
      if (session) {
        deps.upsertSession(session)
        return
      }
    } catch (error) {
      deps.onError?.(error, 'session')
    }

    try {
      await deps.refreshSessionMetadata(sessionId)
    } catch (error) {
      deps.onError?.(error, 'metadata')
    }
  })()

  inFlight.set(sessionId, hydration)
  void hydration.finally(() => {
    if (inFlight.get(sessionId) === hydration) inFlight.delete(sessionId)
  })
  return hydration
}
