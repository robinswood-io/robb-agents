export interface PendingRequestIdentity {
  requestId: string
}

/**
 * Add or refresh one pending request without duplicating a replayed event.
 *
 * `requestId` is the broker capability. Replays for the same capability update
 * the existing row in place so its label stays current while FIFO ordering for
 * genuinely distinct requests is preserved.
 */
export function upsertPendingRequest<T extends PendingRequestIdentity>(
  pending: Map<string, T[]>,
  sessionId: string,
  request: T,
): Map<string, T[]> {
  const queue = pending.get(sessionId) ?? []
  const existingIndex = queue.findIndex(candidate => candidate.requestId === request.requestId)
  const nextQueue = [...queue]
  if (existingIndex >= 0) nextQueue[existingIndex] = request
  else nextQueue.push(request)

  const next = new Map<string, T[]>()
  for (const [key, requests] of pending) next.set(key, [...requests])
  next.set(sessionId, nextQueue)
  return next
}

/**
 * Remove only the capability that was answered. Removing every accidental
 * duplicate of that id is intentional; a stale click must never dequeue a
 * newer request that happens to be displayed for the same session.
 */
export function removePendingRequest<T extends PendingRequestIdentity>(
  pending: Map<string, T[]>,
  sessionId: string,
  requestId: string,
): Map<string, T[]> {
  const queue = pending.get(sessionId)
  if (!queue?.some(request => request.requestId === requestId)) {
    return pending
  }

  const remaining = queue.filter(request => request.requestId !== requestId)
  const next = new Map<string, T[]>()
  for (const [key, requests] of pending) next.set(key, [...requests])
  if (remaining.length > 0) next.set(sessionId, remaining)
  else next.delete(sessionId)
  return next
}
