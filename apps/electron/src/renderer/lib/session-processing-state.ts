import type { Session } from '../../shared/types'

// Renderer-only ordering for host processing signals. Spreads retain this
// enumerable symbol; JSON/IPC/session persistence never serialize it.
const processingRevision = Symbol('session-processing-revision')
type ProcessingSession = Session & { [processingRevision]?: number }
let nextProcessingRevision = 0

export function getSessionProcessingRevision(session: Session | null | undefined): number {
  return (session as ProcessingSession | null | undefined)?.[processingRevision] ?? 0
}

/** Mark even an explicit false→false Stop/complete signal as newer state. */
export function markSessionProcessingState(session: Session): Session {
  // A freshly deserialized replacement has no symbol. Never let it reuse an
  // older revision still captured by an in-flight history request.
  return { ...session, [processingRevision]: ++nextProcessingRevision } as ProcessingSession
}
