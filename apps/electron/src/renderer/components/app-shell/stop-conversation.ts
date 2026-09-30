/** Explicit Stop includes hidden workers; a silent redirect only steers the parent. */
export async function stopConversation(
  sessionId: string,
  descendantIds: readonly string[],
  silent: boolean,
  cancel: (id: string, silent: boolean) => Promise<unknown>,
): Promise<void> {
  const failures: unknown[] = []
  try { await cancel(sessionId, silent) } catch (error) { failures.push(error) }
  if (!silent) {
    const results = await Promise.allSettled([...new Set(descendantIds)]
      .filter(id => id !== sessionId).map(id => cancel(id, false)))
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length) throw new AggregateError(failures, 'Conversation cancellation did not fully complete')
}
