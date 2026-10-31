import { getSessionPath as getSessionStoragePath, type MissionCapabilityLock, pickSessionFields } from "@craft-agent/shared/sessions";
import { type Session } from "@craft-agent/shared/protocol";
import type { ManagedSession } from './managed-session.ts';
import { resolveSupportsBranching } from './source-selection.ts';

export const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  contextTokens: 0, costUsd: 0,
}

/**
 * Convert a ManagedSession to a renderer-side Session object.
 * Uses pickSessionFields() for persistent fields so new fields propagate automatically.
 */
export function managedToSession(m: ManagedSession, overrides?: Partial<Session>): Session {
  const publicFields = pickSessionFields(m) as ReturnType<typeof pickSessionFields> & {
    missionCapabilityLock?: MissionCapabilityLock
  }
  delete publicFields.missionCapabilityLock
  return {
    ...publicFields,
    // Pre-computed fields from header (not in SESSION_PERSISTENT_FIELDS)
    preview: m.preview,
    lastMessageRole: m.lastMessageRole,
    tokenUsage: m.tokenUsage,
    messageCount: m.messageCount,
    lastFinalMessageId: m.lastFinalMessageId,
    // Runtime-only fields
    workspaceId: m.workspace.id,
    workspaceName: m.workspace.name,
    messages: [],
    pendingAuthRequestMessage: m.pendingAuthRequestId
      ? m.messages.findLast(message => message.role === 'auth-request'
        && message.authRequestId === m.pendingAuthRequestId && message.authStatus === 'pending')
      : undefined,
    isProcessing: m.isProcessing,
    sessionFolderPath: getSessionStoragePath(m.persistenceRootPath, m.id),
    supportsBranching: resolveSupportsBranching(m),
    ...overrides,
  } as Session
}
