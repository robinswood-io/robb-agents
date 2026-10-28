import React, { useCallback } from 'react';

import { type OfflinePinnedTextCandidate } from './components/OfflineWorkspace';
import { OfflineCoordinator } from './offline-coordinator';
import { OFFLINE_VAULT_MAX_DRAFT_CHARS, type OfflineSessionAnchor, type OfflineVaultScope, type OfflineVaultState } from './offline-vault';

interface useWebuiOfflineActionsInput {
  offlineStorageReady: boolean
  offlineScope: OfflineVaultScope | null
  transportConnected: boolean
  offlineSyncRef: React.RefObject<(() => Promise<void>) | null>
  translateRef: React.RefObject<import("i18next").TFunction<"translation", undefined>>
  setOfflineEnablePending: React.Dispatch<React.SetStateAction<boolean>>
  setOfflineStorageError: React.Dispatch<React.SetStateAction<string>>
  offlineCoordinator: OfflineCoordinator
  offlineSyncFailedMessage: () => string
  setOfflineDraftEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>
  offlineVault: import("./offline-vault").OfflineVault
  offlineDraftTimersRef: React.RefObject<Map<string, number>>
  offlineState: OfflineVaultState
  setReviewedOutbox: React.Dispatch<React.SetStateAction<Record<string, { canSend: boolean; contextChanged: boolean; reviewedAnchor?: OfflineSessionAnchor; sending?: boolean; detail?: string; }>>>
}

export function useWebuiOfflineActions({
  offlineStorageReady,
  offlineScope,
  transportConnected,
  offlineSyncRef,
  translateRef,
  setOfflineEnablePending,
  setOfflineStorageError,
  offlineCoordinator,
  offlineSyncFailedMessage,
  setOfflineDraftEdits,
  offlineVault,
  offlineDraftTimersRef,
  offlineState,
  setReviewedOutbox,
}: useWebuiOfflineActionsInput) {
const enableOfflineWorkspace = useCallback(async () => {
    if (!offlineStorageReady || !offlineScope || !transportConnected || !offlineSyncRef.current) {
      throw new Error(translateRef.current('webui.offlineEnableRequiresConnection', 'Connect to the host before enabling offline storage.'))
    }
    setOfflineEnablePending(true)
    setOfflineStorageError('')
    let vaultEnabled = false
    try {
      await offlineCoordinator.enable(offlineScope)
      vaultEnabled = true
      // The opt-in click is also the appropriate moment to ask the browser to
      // protect IndexedDB from routine storage eviction. Denial is non-fatal.
      void navigator.storage?.persist?.().catch(() => false)
      await offlineSyncRef.current()
    } catch {
      const message = vaultEnabled
        ? offlineSyncFailedMessage()
        : translateRef.current('webui.offlineActionFailed', 'The action could not be completed. Review the current local state before trying again.')
      setOfflineStorageError(message)
      throw new Error(message)
    } finally {
      setOfflineEnablePending(false)
    }
  }, [offlineScope, offlineStorageReady, offlineSyncFailedMessage, transportConnected])

const updateOfflineDraft = useCallback((sessionId: string, text: string) => {
    if (text.length > OFFLINE_VAULT_MAX_DRAFT_CHARS) return
    setOfflineDraftEdits((current) => ({ ...current, [sessionId]: text }))
    const scopeToken = offlineVault.getScopeToken()
    if (!scopeToken) return
    const existing = offlineDraftTimersRef.current.get(sessionId)
    if (existing) window.clearTimeout(existing)
    const timeout = window.setTimeout(() => {
      offlineDraftTimersRef.current.delete(sessionId)
      void offlineVault.storeDraft(sessionId, text, true, scopeToken)
        .then(() => {
          setOfflineDraftEdits((current) => {
            if (current[sessionId] !== text) return current
            const next = { ...current }
            delete next[sessionId]
            return next
          })
        })
        .catch((draftError: unknown) => {
          setOfflineStorageError(draftError instanceof Error ? draftError.message : String(draftError))
        })
    }, 350)
    offlineDraftTimersRef.current.set(sessionId, timeout)
  }, [])

const addDraftToOutbox = useCallback(async (sessionId: string, text: string) => {
    const scopeToken = offlineVault.getScopeToken()
    if (!scopeToken) throw new Error('The offline workspace is no longer available')
    const snapshot = offlineState.sessions.find((entry) => entry.id === sessionId)
    let sessionName = snapshot?.name
    let anchor = snapshot?.anchor
    if (!anchor && transportConnected && window.electronAPI) {
      const session = await window.electronAPI.getSessionMessages(sessionId)
      if (session) {
        sessionName = session.name || session.preview || translateRef.current('chat.newChat', 'New chat')
        anchor = {
          messageCount: session.messages.length,
          lastFinalMessageId: session.lastFinalMessageId ?? null,
          lastMessageAt: session.lastMessageAt,
        }
      }
    }
    if (!anchor) throw new Error('The saved conversation is no longer available')
    const pendingDraft = offlineDraftTimersRef.current.get(sessionId)
    if (pendingDraft) {
      window.clearTimeout(pendingDraft)
      offlineDraftTimersRef.current.delete(sessionId)
    }
    await offlineVault.enqueueMessage({
      sessionId,
      sessionName: sessionName ?? translateRef.current('chat.newChat', 'New chat'),
      text,
      anchor,
    }, scopeToken)
    setOfflineDraftEdits((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [offlineState.sessions, transportConnected])

const toggleOfflinePin = useCallback(async (candidate: OfflinePinnedTextCandidate) => {
    const scopeToken = offlineVault.getScopeToken()
    if (!scopeToken) throw new Error('The offline workspace is no longer available')
    await offlineVault.togglePin({
      sessionId: candidate.sessionId,
      messageId: candidate.messageId,
      role: candidate.role,
      text: candidate.content,
    }, scopeToken)
  }, [])

const removeOfflinePin = useCallback(async (pinId: string) => {
    const scopeToken = offlineVault.getScopeToken()
    if (!scopeToken) throw new Error('The offline workspace is no longer available')
    const pin = offlineState.pins.find((entry) => entry.id === pinId)
    if (!pin) return
    await offlineVault.togglePin({
      sessionId: pin.sessionId,
      messageId: pin.messageId,
      role: pin.role,
      text: pin.text,
    }, scopeToken)
  }, [offlineState.pins])

const reviewOutboxItem = useCallback(async (itemId: string) => {
    const item = offlineState.outbox.find((entry) => entry.id === itemId)
    if (!item || !window.electronAPI) return
    if (item.status === 'uncertain') {
      const workspaceId = offlineState.scope?.workspaceId
      if (workspaceId) {
        await window.electronAPI.openSessionInNewWindow(workspaceId, item.sessionId)
      }
      setReviewedOutbox((current) => ({
        ...current,
        [itemId]: {
          canSend: false,
          contextChanged: true,
          detail: translateRef.current('webui.offlineUncertainReviewDetail', 'Open the live conversation and verify delivery. This item cannot be retried automatically.'),
        },
      }))
      return
    }
    const result = await offlineCoordinator.reviewOutboxItem(item, window.electronAPI)
    if (result.status === 'ready') {
      setReviewedOutbox((current) => ({
        ...current,
        [itemId]: {
          canSend: true,
          contextChanged: result.contextChanged,
          reviewedAnchor: result.reviewedAnchor,
          ...(result.contextChanged ? {
            detail: translateRef.current('webui.offlineContextReviewRequired', 'The live conversation changed. Read it before confirming this send.'),
          } : {}),
        },
      }))
      return
    }
    const detail = result.reason === 'session-busy'
      ? translateRef.current('webui.offlineSessionBusy', 'Wait for the agent to finish before reviewing this item.')
      : result.reason === 'session-missing'
        ? translateRef.current('webui.offlineSessionMissing', 'This conversation no longer exists on the host.')
        : translateRef.current('webui.offlineReconnectBeforeSend', 'Reconnect before sending')
    setReviewedOutbox((current) => ({
      ...current,
      [itemId]: { canSend: false, contextChanged: false, detail },
    }))
  }, [offlineState.outbox])
return { enableOfflineWorkspace, toggleOfflinePin, removeOfflinePin, updateOfflineDraft, addDraftToOutbox, reviewOutboxItem }
}
