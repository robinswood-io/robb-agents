import { atom, type Atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import type { Message, Session } from '../../shared/types'
import { sessionAtomFamily, sessionMetaMapAtom } from './sessions'

export interface PendingSessionAuthRequest {
  sessionId: string
  message: Message
}

// Subscribe only to changes in pending auth messages. Tool streaming must not
// cause every conversation to render or retain complete child transcripts.
const pendingMessageAtoms = new WeakMap<Atom<Session | null>, Atom<Message[]>>()
function pendingMessagesAtomFor(sessionId: string): Atom<Message[]> {
  const sessionAtom = sessionAtomFamily(sessionId)
  let pendingAtom = pendingMessageAtoms.get(sessionAtom)
  if (!pendingAtom) {
    pendingAtom = selectAtom(sessionAtom, session => {
      const snapshot = session?.pendingAuthRequestMessage
      // Only the current runtime request is actionable. Historical pending
      // messages may outlive a missed completion event or a host restart.
      return snapshot?.authStatus === 'pending' ? [snapshot] : []
    }, (previous, next) => previous.length === next.length && previous.every((message, index) => message === next[index]))
    pendingMessageAtoms.set(sessionAtom, pendingAtom)
  }
  return pendingAtom
}

const pendingRequestsAtom = atom((get): PendingSessionAuthRequest[] => {
  const requests: PendingSessionAuthRequest[] = []
  for (const sessionId of get(sessionMetaMapAtom).keys()) {
    for (const message of get(pendingMessagesAtomFor(sessionId))) {
      requests.push({ sessionId, message })
    }
  }
  return requests
})

export const pendingSessionAuthRequestsAtom = selectAtom(
  pendingRequestsAtom,
  requests => requests,
  (previous, next) => previous.length === next.length && previous.every((request, index) =>
    request.sessionId === next[index]?.sessionId && request.message === next[index]?.message),
)
