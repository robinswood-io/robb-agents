import { atom, type Atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { describeJourneyActivity, safeActivityText, type JourneyActivity } from '@craft-agent/ui/chat/journey-activity'
import type { Session } from '../../shared/types'
import { sessionAtomFamily, sessionMetaMapAtom } from './sessions'
import { getActiveSessionDescendantIds } from '../utils/session-visibility'

interface ActiveAgentActivity {
  sessionId: string
  sessionName?: string
  activity: JourneyActivity
}
export interface ConversationAgentActivity {
  activeCount: number
  latest?: ActiveAgentActivity
}

function sameAgent(left: ActiveAgentActivity | undefined, right: ActiveAgentActivity | undefined): boolean {
  return left === right || (!!left && !!right && left.sessionId === right.sessionId
    && left.sessionName === right.sessionName && left.activity.title === right.activity.title
    && left.activity.detail === right.activity.detail && left.activity.source === right.activity.source
    && left.activity.observedAt === right.activity.observedAt)
}

const activityAtoms = new WeakMap<Atom<Session | null>, Atom<ActiveAgentActivity>>()
function activityAtomFor(sessionId: string): Atom<ActiveAgentActivity> {
  const sessionAtom = sessionAtomFamily(sessionId)
  let activityAtom = activityAtoms.get(sessionAtom)
  if (!activityAtom) {
    activityAtom = selectAtom(sessionAtom, session => ({
      sessionId, sessionName: safeActivityText(session?.name, 100),
      // Loaded/live messages only. Never hydrate delegated histories just to
      // populate progress, and never project tool inputs or returned data.
      activity: describeJourneyActivity(session?.messages ?? [], []),
    }), sameAgent)
    activityAtoms.set(sessionAtom, activityAtom)
  }
  return activityAtom
}

const conversationAtoms = new WeakMap<Atom<Session | null>, Atom<ConversationAgentActivity>>()
export function conversationAgentActivityAtom(sessionId: string): Atom<ConversationAgentActivity> {
  const rootAtom = sessionAtomFamily(sessionId)
  let result = conversationAtoms.get(rootAtom)
  if (!result) {
    const candidates = atom(get => {
      const metadata = get(sessionMetaMapAtom)
      const ids = getActiveSessionDescendantIds(sessionId, metadata)
      const active = ids.map(id => get(activityAtomFor(id)))
      active.sort((left, right) => (right.activity.observedAt ?? 0) - (left.activity.observedAt ?? 0)
        || left.sessionId.localeCompare(right.sessionId))
      return { activeCount: ids.length, latest: active[0] }
    })
    result = selectAtom(candidates, value => value, (left, right) =>
      left.activeCount === right.activeCount && sameAgent(left.latest, right.latest))
    conversationAtoms.set(rootAtom, result)
  }
  return result
}
