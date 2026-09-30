import type { UserInputRequest } from '@craft-agent/core/types'

/** Stale event/fetch snapshots cannot reopen a terminal question. */
export function mergeUserInputRequests(current: UserInputRequest[] = [], incoming: UserInputRequest[] = []): UserInputRequest[] {
  // The host retains answered/cancelled entries. Missing is therefore not a
  // cancellation signal; it can be an older snapshot received during a fetch.
  const requests = new Map(current.map(request => [request.id, request]))
  for (const request of incoming) {
    const existing = requests.get(request.id)
    if (!existing || existing.status === 'pending'
      || (request.status !== 'pending' && (request.answeredAt ?? 0) > (existing.answeredAt ?? 0))) requests.set(request.id, request)
  }
  const next = [...requests.values()]
  next.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  return next.length === current.length && next.every((request, index) => request === current[index]) ? current : next
}
