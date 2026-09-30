import type { ProcessResult, SessionState, UserInputChangedEvent } from '../types'
import { mergeUserInputRequests } from '../../lib/user-input-state'

export function handleUserInputChanged(state: SessionState, event: UserInputChangedEvent): ProcessResult {
  return { state: { ...state, session: { ...state.session,
    userInputRequests: mergeUserInputRequests(state.session.userInputRequests, event.requests),
  } }, effects: [] }
}
