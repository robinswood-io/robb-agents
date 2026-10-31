import { useEffectEvent } from 'react';
import React, { useEffect } from 'react';

import type { Session, SessionEvent, PermissionRequest, PermissionModeState } from '../shared/types';
import type { SessionDraft } from '@craft-agent/shared/config';
import type { SessionOptions } from './hooks/useSessionOptions';
import { defaultSessionOptions } from './hooks/useSessionOptions';

import type { AgentEvent, Effect } from './event-processor';

import { stripMarkdown } from './utils/text';
import { coerceInputText } from './lib/input-text';

import { hydrateCreatedSession } from './lib/session-created-hydration';

import { sessionAtomFamily, sessionMetaMapAtom, extractSessionMeta, type SessionMeta } from '@/atoms/sessions';

import { showBackgroundFinishedChipAtom, pushBackgroundFinishedAtom } from '@/atoms/background-finished';
import { visibleSessionIdsAtom } from '@/atoms/panel-stack';
import { getSessionTitle } from '@/utils/session';
import { getUserFacingSessionId, isUserFacingSession } from '@/utils/session-visibility';
import { upsertPendingRequest } from '@/utils/pending-request-queue';

import { toast } from 'sonner';
import { type SessionListRefreshOptions, handleBackgroundTaskEvent } from "./app-runtime-helpers";

interface useAppEventStreamInput {
  setPendingPermissions: React.Dispatch<React.SetStateAction<Map<string, PermissionRequest[]>>>
  store: import("jotai").Store
  showSessionNotification: (session: Session, messagePreview?: string) => void
  applyPermissionModeState: (sessionId: string, state: PermissionModeState, source: "event" | "reconcile") => void
  setSessionOptions: React.Dispatch<React.SetStateAction<Map<string, SessionOptions>>>
  reconcilePermissionModeState: (sessionId: string) => Promise<void>
  setPendingCredentials: React.Dispatch<React.SetStateAction<Map<string, import("@craft-agent/session-tools-core").CredentialAuthRequest[]>>>
  sessionDraftsRef: React.RefObject<Map<string, SessionDraft>>
  handleInputChange: (sessionId: string, value: string) => void
  windowWorkspaceId: string | null
  sessionCreatedHydrationsRef: React.RefObject<Map<string, Promise<void>>>
  replaceLoadedSession: (session: Session) => void
  addSession: (session: Session) => void
  syncSessionOptionsFromSession: (session: Session) => void
  refreshSessionListMetadataFromServer: (options?: SessionListRefreshOptions) => Promise<Map<string, SessionMeta> | null>
  removeSession: (sessionId: string) => void
  trackSessionActivity: (sessionId: string) => void
  processAgentEvent: (event: AgentEvent, currentSession: Session | null, workspaceId: string) => { session: Session; effects: Effect[]; }
  updateSessionDirect: (sessionId: string, updater: (prev: Session | null) => Session | null) => void
}

export function useAppEventStream({
  setPendingPermissions,
  store,
  showSessionNotification,
  applyPermissionModeState,
  setSessionOptions,
  reconcilePermissionModeState,
  setPendingCredentials,
  sessionDraftsRef,
  handleInputChange,
  windowWorkspaceId,
  sessionCreatedHydrationsRef,
  replaceLoadedSession,
  addSession,
  syncSessionOptionsFromSession,
  refreshSessionListMetadataFromServer,
  removeSession,
  trackSessionActivity,
  processAgentEvent,
  updateSessionDirect,
}: useAppEventStreamInput) {
const changeInputFromStream = useEffectEvent(handleInputChange);
useEffect(() => {
    // Handoff events signal end of streaming - need to sync back to React state
    // Also includes todo_state_changed so status updates immediately reflect in sidebar
    // async_operation included so shimmer effect on session titles updates in real-time
    const handoffEventTypes = new Set(['complete', 'error', 'interrupted', 'typed_error', 'auth_request', 'auth_completed', 'user_input_changed', 'session_status_changed', 'session_metadata_changed', 'objective_changed', 'session_flagged', 'session_unflagged', 'name_changed', 'labels_changed', 'project_id_changed', 'title_generated', 'async_operation'])

    // Helper to handle side effects (same logic for both paths)
    const handleEffects = (effects: Effect[], sessionId: string, eventType: string) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'permission_request': {
            setPendingPermissions(prevPerms => {
              return upsertPendingRequest(prevPerms, sessionId, effect.request)
            })

            // Native notification for approval-required pauses (same gating as completion notifications)
            const targetId = getUserFacingSessionId(sessionId, store.get(sessionMetaMapAtom)) ?? sessionId
            const notifySession = store.get(sessionAtomFamily(targetId))
            if (notifySession && !notifySession.hidden) {
              const isAdminPrompt = effect.request.type === 'admin_approval'
              const promptBody = isAdminPrompt
                ? `Admin approval required: ${effect.request.appName || effect.request.toolName}`
                : `Permission required: ${effect.request.toolName}`
              showSessionNotification(notifySession, promptBody)
            }
            break
          }
          case 'permission_mode_changed': {
            if (typeof effect.modeVersion === 'number' && effect.changedAt && effect.changedBy) {
              applyPermissionModeState(effect.sessionId, {
                permissionMode: effect.permissionMode,
                modeVersion: effect.modeVersion,
                changedAt: effect.changedAt,
                changedBy: effect.changedBy,
              }, 'event')
            } else {
              // Backward compatibility: apply mode optimistically then reconcile authoritative state.
              setSessionOptions(prevOpts => {
                const next = new Map(prevOpts)
                const current = next.get(effect.sessionId) ?? defaultSessionOptions
                next.set(effect.sessionId, { ...current, permissionMode: effect.permissionMode })
                return next
              })
              void reconcilePermissionModeState(effect.sessionId)
            }
            break
          }
          case 'credential_request': {
            setPendingCredentials(prevCreds => {
              return upsertPendingRequest(prevCreds, sessionId, effect.request)
            })
            break
          }
          case 'restore_input': {
            // Queued messages were removed from chat on abort — restore their text to the input field.
            // Append to existing draft (user may have started typing) rather than overwrite.
            const existingDraft = sessionDraftsRef.current.get(sessionId)
            const existingText = coerceInputText(existingDraft?.text)
            const restoredText = coerceInputText(effect.text)
            const restored = existingText
              ? `${existingText}\n\n${restoredText}`
              : restoredText
            changeInputFromStream(sessionId, restored)
            // handleInputChange updates the ref but ChatPage has local state.
            // Dispatch a custom event so ChatPage re-reads the draft.
            window.dispatchEvent(new CustomEvent('craft:restore-input', {
              detail: { sessionId, text: restored },
            }))
            break
          }
          case 'toast_error': {
            const errorSession = store.get(sessionMetaMapAtom).get(sessionId)
              ?? store.get(sessionAtomFamily(sessionId))
            if (!errorSession || isUserFacingSession(errorSession)) {
              toast.error(effect.message, { duration: 5000 })
            }
            break
          }
        }
      }

      // Clear pending permissions and credentials on complete
      if (eventType === 'complete') {
        setPendingPermissions(prevPerms => {
          if (prevPerms.has(sessionId)) {
            const next = new Map(prevPerms)
            next.delete(sessionId)
            return next
          }
          return prevPerms
        })
        setPendingCredentials(prevCreds => {
          if (prevCreds.has(sessionId)) {
            const next = new Map(prevCreds)
            next.delete(sessionId)
            return next
          }
          return prevCreds
        })
      }
    }

    const cleanup = window.electronAPI.onSessionEvent((event: SessionEvent) => {
      if (!('sessionId' in event)) return

      const sessionId = event.sessionId
      const workspaceId = windowWorkspaceId ?? ''

      // Session lifecycle events are handled explicitly (not by the agent event processor).
      if (event.type === 'session_created') {
        void hydrateCreatedSession(sessionCreatedHydrationsRef.current, sessionId, {
          fetchSession: id => window.electronAPI.getSessionMessages(id),
          upsertSession: (createdSession: Session) => {
            const existingMeta = store.get(sessionMetaMapAtom).has(sessionId)
            if (existingMeta) {
              replaceLoadedSession(createdSession)
            } else {
              addSession(createdSession)
            }
            syncSessionOptionsFromSession(createdSession)
          },
          refreshSessionMetadata: async id => {
            await refreshSessionListMetadataFromServer({
              removeMissing: false,
              reason: `session-created-fallback:${id}`,
            })
          },
          onError: (error, phase) => console.error(`Failed to hydrate session_created ${phase}:`, error),
        })
        return
      }

      if (event.type === 'session_deleted') {
        removeSession(sessionId)
        return
      }

      const agentEvent: AgentEvent = event

      // Track activity for stale session watchdog
      trackSessionActivity(sessionId)

      // Dispatch window event when compaction completes
      // This allows FreeFormInput to sequence the plan execution message after compaction
      // Note: markCompactionComplete is called on the backend (sessions.ts) to ensure
      // it happens even if CMD+R occurs during compaction
      if (event.type === 'info' && event.statusType === 'compaction_complete') {
        window.dispatchEvent(new CustomEvent('craft:compaction-complete', {
          detail: { sessionId }
        }))
      }

      // Check if session is currently streaming (atom is source of truth)
      const atomSession = store.get(sessionAtomFamily(sessionId))
      const isStreaming = atomSession?.isProcessing === true
      const isHandoff = handoffEventTypes.has(event.type)

      // During streaming OR for handoff events: use atom as source of truth
      // This ensures all events during streaming see the complete state
      if (isStreaming || isHandoff) {
        const currentSession = atomSession ?? null

        // Process the event
        const { session: updatedSession, effects } = processAgentEvent(
          agentEvent,
          currentSession,
          workspaceId
        )

        // Update atom directly (UI sees update immediately)
        updateSessionDirect(sessionId, () => updatedSession)

        // Handle side effects
        handleEffects(effects, sessionId, event.type)

        // Handle background task events
        handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

        // For handoff events, update metadata map for list display
        // NOTE: No sessionsAtom to sync - atom and metadata are the source of truth
        if (isHandoff) {
          // Update metadata map
          const metaMap = store.get(sessionMetaMapAtom)
          const newMetaMap = new Map(metaMap)
          newMetaMap.set(sessionId, extractSessionMeta(updatedSession))
          store.set(sessionMetaMapAtom, newMetaMap)

          // Show notification on complete (when window is not focused)
          // Internal work reports through its parent conversation.
          if (
            event.type === 'complete'
            && (event.reason === undefined || event.reason === 'complete')
            && isUserFacingSession(updatedSession)
          ) {
            // Get the last assistant/plan message as preview
            const lastMessage = updatedSession.messages.findLast(
              m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
            )
            // Strip markdown so OS notifications display clean plain text
            const rawPreview = lastMessage?.content?.substring(0, 200) || undefined
            const preview = rawPreview ? stripMarkdown(rawPreview).substring(0, 100) || undefined : undefined
            showSessionNotification(updatedSession, preview)

            // In-app complement to the OS notification: when a *background*
            // session (one not shown in any open panel) finishes, queue a chip
            // above the chat. The OS notification above is suppressed while the
            // window is focused, so the chip is the only completion signal then.
            if (
              store.get(showBackgroundFinishedChipAtom) &&
              !store.get(visibleSessionIdsAtom).has(sessionId)
            ) {
              store.set(pushBackgroundFinishedAtom, {
                sessionId,
                title: getSessionTitle(updatedSession),
                finishedAt: Date.now(),
              })
            }
          }
        }

        return
      }

      // Not streaming: use per-session atoms directly (no sessionsAtom)
      const currentSession = store.get(sessionAtomFamily(sessionId))

      const { session: updatedSession, effects } = processAgentEvent(
        agentEvent,
        currentSession,
        workspaceId
      )

      // Handle side effects
      handleEffects(effects, sessionId, event.type)

      // Handle background task events
      handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

      // Update per-session atom
      updateSessionDirect(sessionId, () => updatedSession)

      // Update metadata map
      const metaMap = store.get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, extractSessionMeta(updatedSession))
      store.set(sessionMetaMapAtom, newMetaMap)
    })

    return cleanup
  // The input callback is declared after this subscription in App; the deferred
  // delegate retains the callback from the render that installed the listener.
  }, [
    processAgentEvent,
    trackSessionActivity,
    windowWorkspaceId,
    store,
    updateSessionDirect,
    replaceLoadedSession,
    showSessionNotification,
    addSession,
    removeSession,
    syncSessionOptionsFromSession,
    applyPermissionModeState,
    reconcilePermissionModeState,
    refreshSessionListMetadataFromServer,
    sessionCreatedHydrationsRef,
    sessionDraftsRef,
    setPendingCredentials,
    setPendingPermissions,
    setSessionOptions,
  ])
return {  }
}
