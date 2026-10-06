import { atom, type Atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import type { Session } from '../../shared/types'
import { sessionAtomFamily, sessionMetaMapAtom } from './sessions'

export interface SessionPermissionRecovery {
  sessionId: string
  sessionName?: string
  userMessageId: string
  requestId: string
}

function sameRecovery(left: SessionPermissionRecovery | null, right: SessionPermissionRecovery | null): boolean {
  return left === right || (!!left && !!right && left.sessionId === right.sessionId
    && left.sessionName === right.sessionName && left.userMessageId === right.userMessageId
    && left.requestId === right.requestId)
}

const recoveryAtoms = new WeakMap<Atom<Session | null>, Atom<SessionPermissionRecovery | null>>()
function recoveryAtomFor(sessionId: string): Atom<SessionPermissionRecovery | null> {
  const sessionAtom = sessionAtomFamily(sessionId)
  let recoveryAtom = recoveryAtoms.get(sessionAtom)
  if (!recoveryAtom) {
    recoveryAtom = selectAtom(sessionAtom, session => {
      const recovery = session?.pendingTurnRecovery
      const permission = recovery?.waitingForPermission
      if (!session || session.isProcessing || !recovery || !permission?.recoveryRequired) return null
      const objective = session.activeObjective
      if (objective && (objective.terminalState === 'complete_verified'
        || (recovery.userMessageId !== objective.userMessageId && recovery.userMessageId !== objective.lastUserMessageId))) return null
      return { sessionId, sessionName: session.name, userMessageId: recovery.userMessageId, requestId: permission.requestId }
    }, sameRecovery)
    recoveryAtoms.set(sessionAtom, recoveryAtom)
  }
  return recoveryAtom
}

const recoveryRequestsAtom = atom(get => {
  const requests: SessionPermissionRecovery[] = []
  for (const sessionId of get(sessionMetaMapAtom).keys()) {
    const request = get(recoveryAtomFor(sessionId))
    if (request) requests.push(request)
  }
  return requests
})

/** Explicit cold-start waits only; live permission dialogs remain authoritative. */
export const sessionPermissionRecoveryRequestsAtom = selectAtom(recoveryRequestsAtom, requests => requests,
  (previous, next) => previous.length === next.length && previous.every((request, index) => sameRecovery(request, next[index] ?? null)))
