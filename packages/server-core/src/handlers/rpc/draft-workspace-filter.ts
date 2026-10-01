/**
 * Keep draft hydration scoped to the workspace carried by the authenticated
 * transport context. This applies to owners as well as restricted devices:
 * broad account authorization must not turn a per-window sync into an
 * all-workspace plaintext transfer.
 */
export async function filterDraftsForWorkspace<T>(
  drafts: Readonly<Record<string, T>>,
  workspaceId: string,
  resolveWorkspaceId: (sessionId: string) => Promise<string | null>,
): Promise<Record<string, T>> {
  const scopedEntries = await Promise.all(Object.entries(drafts).map(async ([sessionId, draft]) => (
    await resolveWorkspaceId(sessionId) === workspaceId
      ? [sessionId, draft] as const
      : null
  )))
  return Object.fromEntries(scopedEntries.filter((entry): entry is readonly [string, T] => entry !== null))
}
