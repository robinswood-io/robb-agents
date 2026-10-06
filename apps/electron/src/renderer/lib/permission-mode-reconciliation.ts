/**
 * Permission-mode metadata is already part of the session catalogue. An
 * authoritative diagnostics round-trip is only useful for the session the
 * window is actively restoring, never for every cold session in the sidebar.
 */
export function getPermissionModeReconciliationTarget(
  sessions: ReadonlyArray<{ id: string }>,
  selectedSessionId?: string | null,
): string | null {
  if (!selectedSessionId) return null
  return sessions.some(session => session.id === selectedSessionId)
    ? selectedSessionId
    : null
}
