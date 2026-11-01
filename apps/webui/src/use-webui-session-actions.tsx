import React, { useCallback } from 'react';

import type { WsRpcClient } from '../../electron/src/transport/client';

import { OfflineWorkspace, type OfflineDraftView, type OfflineOutboxItemView, type OfflinePinnedTextCandidate, type OfflinePinnedTextView, type OfflineSessionSnapshotView } from './components/OfflineWorkspace';
import { OfflineCoordinator } from './offline-coordinator';
import { OFFLINE_VAULT_MAX_DRAFT_CHARS, OFFLINE_VAULT_MAX_OUTBOX_ITEMS, OFFLINE_VAULT_RETENTION_MS, isOfflineVaultEnabled, type OfflineSessionAnchor, type OfflineVaultScope, type OfflineVaultState } from './offline-vault';
import { broadcastWebSessionInvalidation } from './private-storage';

import { saveJsonFile } from './pwa-file-system';
import { type Phase } from "./components/webui-shell-screens";

interface useWebuiSessionActionsInput {
  offlineState: OfflineVaultState
  reviewedOutbox: Record<string, { canSend: boolean; contextChanged: boolean; reviewedAnchor?: OfflineSessionAnchor; sending?: boolean; detail?: string; }>
  setReviewedOutbox: React.Dispatch<React.SetStateAction<Record<string, { canSend: boolean; contextChanged: boolean; reviewedAnchor?: OfflineSessionAnchor; sending?: boolean; detail?: string; }>>>
  offlineCoordinator: OfflineCoordinator
  translateRef: React.RefObject<import("i18next").TFunction<"translation", undefined>>
  purgeAllLocalPrivateData: () => Promise<void>
  transportConnected: boolean
  offlineSyncRef: React.RefObject<(() => Promise<void>) | null>
  initialize: () => Promise<void>
  setOfflineStorageError: React.Dispatch<React.SetStateAction<string>>
  offlineSyncFailedMessage: () => string
  terminalAuthHandledRef: React.RefObject<boolean>
  setPhase: React.Dispatch<React.SetStateAction<Phase>>
  setOfflinePanelOpen: React.Dispatch<React.SetStateAction<boolean>>
  transportCleanupRef: React.RefObject<(() => void) | null>
  clientRef: React.RefObject<WsRpcClient | null>
  setError: React.Dispatch<React.SetStateAction<string>>
  offlineEnablePending: boolean
  offlineSnapshots: OfflineSessionSnapshotView[]
  offlinePins: OfflinePinnedTextView[]
  offlineDrafts: OfflineDraftView[]
  offlineOutbox: OfflineOutboxItemView[]
  offlineVault: import("./offline-vault").OfflineVault
  offlineStorageError: string
  offlineStorageReady: boolean
  offlineScope: OfflineVaultScope | null
  enableOfflineWorkspace: () => Promise<void>
  toggleOfflinePin: (candidate: OfflinePinnedTextCandidate) => Promise<void>
  removeOfflinePin: (pinId: string) => Promise<void>
  updateOfflineDraft: (sessionId: string, text: string) => void
  addDraftToOutbox: (sessionId: string, text: string) => Promise<void>
  reviewOutboxItem: (itemId: string) => Promise<void>
}

export function useWebuiSessionActions({
  offlineState,
  reviewedOutbox,
  setReviewedOutbox,
  offlineCoordinator,
  translateRef,
  purgeAllLocalPrivateData,
  transportConnected,
  offlineSyncRef,
  initialize,
  setOfflineStorageError,
  offlineSyncFailedMessage,
  terminalAuthHandledRef,
  setPhase,
  setOfflinePanelOpen,
  transportCleanupRef,
  clientRef,
  setError,
  offlineEnablePending,
  offlineSnapshots,
  offlinePins,
  offlineDrafts,
  offlineOutbox,
  offlineVault,
  offlineStorageError,
  offlineStorageReady,
  offlineScope,
  enableOfflineWorkspace,
  toggleOfflinePin,
  removeOfflinePin,
  updateOfflineDraft,
  addDraftToOutbox,
  reviewOutboxItem,
}: useWebuiSessionActionsInput) {
const sendReviewedOutboxItem = useCallback(async (itemId: string) => {
    const item = offlineState.outbox.find((entry) => entry.id === itemId)
    const review = reviewedOutbox[itemId]
    if (!item || !review?.canSend || !review.reviewedAnchor || !window.electronAPI || item.status === 'uncertain') return
    setReviewedOutbox((current) => ({
      ...current,
      [itemId]: { ...review, sending: true },
    }))
    let result: Awaited<ReturnType<typeof offlineCoordinator.sendOutboxItem>>
    try {
      result = await offlineCoordinator.sendOutboxItem(
        item,
        window.electronAPI,
        review.reviewedAnchor,
      )
    } catch (sendError) {
      setReviewedOutbox((current) => ({
        ...current,
        [itemId]: {
          canSend: false,
          contextChanged: false,
          detail: translateRef.current('webui.offlineSendBlocked', 'The host is not ready to accept this message.'),
        },
      }))
      throw sendError
    }
    if (result.status === 'sent') {
      setReviewedOutbox((current) => {
        const next = { ...current }
        delete next[itemId]
        return next
      })
      return
    }
    if (result.status === 'uncertain') {
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
    setReviewedOutbox((current) => ({
      ...current,
      [itemId]: {
        canSend: false,
        contextChanged: result.status === 'needs-confirmation',
        detail: result.status === 'needs-confirmation'
          ? translateRef.current('webui.offlineContextReviewRequired', 'The live conversation changed. Review it again before sending.')
          : translateRef.current('webui.offlineSendBlocked', 'The host is not ready to accept this message.'),
      },
    }))
  }, [offlineState.outbox, reviewedOutbox])

const clearOfflineData = useCallback(async () => {
    await purgeAllLocalPrivateData()
  }, [purgeAllLocalPrivateData])

const exportOfflineData = useCallback(async () => {
    const exportedAt = new Date().toISOString()
    const host = (offlineState.scope?.hostLabel ?? 'robb-agents').toLocaleLowerCase().replace(/[^\w.-]+/g, '-')
    await saveJsonFile({
      exportedAt,
      source: 'Robb Agents Remote PWA',
      state: offlineState,
    }, `robb-agents-offline-${host}-${exportedAt.slice(0, 10)}.json`)
  }, [offlineState])

const retryOfflineSync = useCallback(async () => {
    if (!transportConnected || !offlineSyncRef.current) {
      await initialize()
      return
    }
    setOfflineStorageError('')
    try {
      await offlineSyncRef.current()
    } catch {
      const message = offlineSyncFailedMessage()
      setOfflineStorageError(message)
      throw new Error(message)
    }
  }, [initialize, offlineSyncFailedMessage, transportConnected])

const signOutWebSession = useCallback(async () => {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error('Logout request failed')

    terminalAuthHandledRef.current = true
    broadcastWebSessionInvalidation()
    setPhase('loading')
    setOfflinePanelOpen(false)
    transportCleanupRef.current?.()
    transportCleanupRef.current = null
    clientRef.current?.destroy()
    try {
      await purgeAllLocalPrivateData()
    } catch (purgeError) {
      const message = translateRef.current(
        'webui.localEraseFailedAfterLogout',
        'You are signed out, but this browser could not fully erase its local offline data.',
      )
      setOfflineStorageError(message)
      setError(message)
      setPhase('error')
      throw purgeError
    }
    window.location.replace('/login')
  }, [purgeAllLocalPrivateData])

const renderOfflineWorkspace = (online: boolean, connectionError?: string) => (
    <OfflineWorkspace
      enabled={!offlineEnablePending && isOfflineVaultEnabled() && offlineState.scope !== null}
      online={online}
      snapshots={offlineSnapshots}
      pinnedTexts={offlinePins}
      drafts={offlineDrafts}
      outbox={offlineOutbox}
      retentionDays={Math.round(OFFLINE_VAULT_RETENTION_MS / (24 * 60 * 60 * 1_000))}
      retentionOptionsDays={[7]}
      lastSyncedAt={offlineState.lastSyncAt ?? undefined}
      storageBytes={offlineVault.estimatePlaintextBytes()}
      draftMaxChars={OFFLINE_VAULT_MAX_DRAFT_CHARS}
      maxOutboxItems={OFFLINE_VAULT_MAX_OUTBOX_ITEMS}
      enablePending={offlineEnablePending}
      errorMessage={offlineStorageError || connectionError || (!online && !isOfflineVaultEnabled()
        ? translateRef.current('webui.offlineEnableOnlineFirst', 'Reconnect once to enable encrypted offline access on this device.')
        : undefined)}
      onEnable={online && offlineStorageReady && offlineScope ? enableOfflineWorkspace : undefined}
      onRetry={!online ? () => initialize() : offlineStorageError ? retryOfflineSync : undefined}
      onClose={online ? () => setOfflinePanelOpen(false) : undefined}
      onPinText={toggleOfflinePin}
      onUnpinText={removeOfflinePin}
      onDraftChange={updateOfflineDraft}
      onAddToOutbox={addDraftToOutbox}
      onReviewOutbox={online ? reviewOutboxItem : undefined}
      onSendOutbox={online ? sendReviewedOutboxItem : undefined}
      onDeleteOutbox={async (itemId) => {
        const confirmed = window.confirm(translateRef.current('webui.offlineDeleteOutboxConfirm', 'Delete this unsent item from this device?'))
        const scopeToken = offlineVault.getScopeToken()
        if (confirmed && scopeToken) await offlineVault.removeOutbox(itemId, scopeToken)
      }}
      onExportOfflineData={exportOfflineData}
      onClearOfflineData={clearOfflineData}
    />
  )
return { renderOfflineWorkspace, signOutWebSession }
}
