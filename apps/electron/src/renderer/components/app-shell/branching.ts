import type { CreateSessionOptions, Session } from '../../../shared/types'

export function resolveBranchNewPanelOption(options?: { newPanel?: boolean }): boolean {
  return options?.newPanel ?? true
}

type BranchSourceSession = Pick<Session,
  | 'id'
  | 'name'
  | 'llmConnection'
  | 'connectionRoutePinned'
  | 'model'
  | 'modelRoutePinned'
  | 'thinkingLevel'
  | 'thinkingLevelPinned'
  | 'permissionMode'
  | 'workingDirectory'
>

/**
 * Preserve both the branch's effective route and its provenance. Passing the
 * three pin flags explicitly is important: createSession otherwise interprets
 * any copied route value as a new manual pin.
 */
export function buildBranchSessionOptions(
  session: BranchSourceSession,
  messageId: string,
): CreateSessionOptions {
  return {
    branchFromMessageId: messageId,
    branchFromSessionId: session.id,
    name: `Branch of ${session.name || 'Untitled'}`,
    llmConnection: session.llmConnection,
    connectionRoutePinned: session.connectionRoutePinned === true
      || (session.modelRoutePinned === true && session.llmConnection !== undefined),
    model: session.model,
    modelRoutePinned: session.modelRoutePinned === true,
    thinkingLevel: session.thinkingLevel,
    thinkingLevelPinned: session.thinkingLevelPinned === true,
    permissionMode: session.permissionMode,
    workingDirectory: session.workingDirectory,
  }
}
