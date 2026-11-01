import React, { useCallback } from 'react';

import type { Session, PermissionRequest, CredentialResponse, NewChatActionParams } from '../shared/types';

import { navigate, routes } from './lib/navigate';

import { removePendingRequest } from '@/utils/pending-request-queue';

interface useAppPromptsInput {
  windowWorkspaceId: string | null
  handleCreateSession: (workspaceId: string, options?: import("../shared/types").CreateSessionOptions) => Promise<Session>
  handleInputChange: (sessionId: string, value: string) => void
  setPendingPermissions: React.Dispatch<React.SetStateAction<Map<string, PermissionRequest[]>>>
  setPendingCredentials: React.Dispatch<React.SetStateAction<Map<string, import("@craft-agent/session-tools-core").CredentialAuthRequest[]>>>
}

export function useAppPrompts({
  windowWorkspaceId,
  handleCreateSession,
  handleInputChange,
  setPendingPermissions,
  setPendingCredentials,
}: useAppPromptsInput) {
const openNewChat = useCallback(async (params: NewChatActionParams = {}) => {
    if (!windowWorkspaceId) {
      console.warn('[App] Cannot open new chat: no workspace ID')
      return
    }

    const session = await handleCreateSession(windowWorkspaceId)

    if (params.name) {
      await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: params.name })
    }

    // Navigate to the chat view - this sets both selectedSession and activeView
    navigate(routes.view.allSessions(session.id))

    // Pre-fill input if provided (after a small delay to ensure component is mounted)
    if (params.input) {
      setTimeout(() => handleInputChange(session.id, params.input!), 100)
    }
  }, [windowWorkspaceId, handleCreateSession, handleInputChange])

const handleRespondToPermission = useCallback(async (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../shared/types').PermissionResponseOptions,
  ) => {
    const success = await window.electronAPI.respondToPermission(sessionId, requestId, allowed, alwaysAllow, options)

    if (success) {
      setPendingPermissions(prev => removePendingRequest(prev, sessionId, requestId))
      // Note: No need to force session refresh - per-session atoms update automatically
    } else {
      // A closed request is stale UI state. Remove that exact capability only:
      // a newer approval may already have arrived while the RPC was in flight.
      setPendingPermissions(prev => removePendingRequest(prev, sessionId, requestId))
    }
  }, [setPendingPermissions])

const handleRespondToCredential = useCallback(async (sessionId: string, requestId: string, response: CredentialResponse) => {
    const success = await window.electronAPI.respondToCredential(sessionId, requestId, response)

    if (success) {
      setPendingCredentials(prev => removePendingRequest(prev, sessionId, requestId))
      // Note: No need to force session refresh - per-session atoms update automatically
    } else {
      // A closed request is stale UI state. Preserve any newer credential card
      // that arrived while this exact response was in flight.
      setPendingCredentials(prev => removePendingRequest(prev, sessionId, requestId))
    }
  }, [setPendingCredentials])
return { handleRespondToPermission, handleRespondToCredential, openNewChat }
}
