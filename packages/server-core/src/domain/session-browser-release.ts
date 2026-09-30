export type BrowserOwnershipReleaser = {
  clearVisualsForSession(sessionId: string): Promise<void>
  unbindAllForSession(sessionId: string): void
}

/**
 * Release this session's browser ownership when the agent is forced to stop
 * (plan submitted, auth interrupt, user stop). Accepts either a direct
 * releaser handle (local Electron path) or a per-session resolver
 * (server path, where the actual BPM may be a `RemoteBrowserPaneManager`).
 *
 * `getBpm` is preferred — it lets the caller bind release to the right
 * session-scoped BPM without leaking session identity into the releaser type.
 */
export async function releaseBrowserOwnershipOnForcedStop(
  source: BrowserOwnershipReleaser | ((sessionId: string) => BrowserOwnershipReleaser | null) | null | undefined,
  sessionId: string,
  ownsRelease?: () => boolean,
): Promise<void> {
  if (!source || (ownsRelease && !ownsRelease())) return
  const releaser = typeof source === 'function' ? source(sessionId) : source
  if (!releaser) return
  await releaser.clearVisualsForSession(sessionId)
  if (ownsRelease && !ownsRelease()) return
  releaser.unbindAllForSession(sessionId)
}
