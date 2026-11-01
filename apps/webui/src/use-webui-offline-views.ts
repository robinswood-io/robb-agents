import { omitUndefined } from '@craft-agent/shared/utils/json';
import React, { useMemo } from 'react';

import { type OfflineDraftView, type OfflineOutboxItemView, type OfflinePinnedTextView, type OfflineSessionSnapshotView } from './components/OfflineWorkspace';

import { type OfflineSessionAnchor, type OfflineVaultState } from './offline-vault';

interface useWebuiOfflineViewsInput {
  offlineState: OfflineVaultState
  translateRef: React.RefObject<import("i18next").TFunction<"translation", undefined>>
  offlineDraftEdits: Record<string, string>
  reviewedOutbox: Record<string, { canSend: boolean; contextChanged: boolean; reviewedAnchor?: OfflineSessionAnchor; sending?: boolean; detail?: string; }>
}

export function useWebuiOfflineViews({
  offlineState,
  translateRef,
  offlineDraftEdits,
  reviewedOutbox,
}: useWebuiOfflineViewsInput) {
const offlineSnapshots = useMemo<OfflineSessionSnapshotView[]>(() => (
    offlineState.sessions.map((snapshot) => omitUndefined<OfflineSessionSnapshotView>({
      id: snapshot.id,
      title: snapshot.name,
      workspaceName: offlineState.scope?.hostLabel,
      lastMessageAt: snapshot.lastMessageAt,
      syncedAt: snapshot.capturedAt,
      messageCount: snapshot.anchor.messageCount,
      messages: snapshot.messages,
    }))
  ), [offlineState.scope?.hostLabel, offlineState.sessions])

const offlinePins = useMemo<OfflinePinnedTextView[]>(() => {
    const titles = new Map(offlineState.sessions.map((snapshot) => [snapshot.id, snapshot.name]))
    return offlineState.pins.map((pin) => ({
      id: pin.id,
      sessionId: pin.sessionId,
      sessionTitle: titles.get(pin.sessionId) ?? translateRef.current('chat.newChat', 'New chat'),
      messageId: pin.messageId,
      role: pin.role,
      content: pin.text,
      pinnedAt: pin.createdAt,
    }))
  }, [offlineState.pins, offlineState.sessions])

const offlineDrafts = useMemo<OfflineDraftView[]>(() => {
    const titles = new Map(offlineState.sessions.map((snapshot) => [snapshot.id, snapshot.name]))
    const sessionIds = new Set([
      ...Object.keys(offlineState.drafts),
      ...Object.keys(offlineDraftEdits),
    ])
    return [...sessionIds].map((sessionId) => omitUndefined<OfflineDraftView>({
      sessionId,
      sessionTitle: titles.get(sessionId) ?? translateRef.current('chat.newChat', 'New chat'),
      text: offlineDraftEdits[sessionId] ?? offlineState.drafts[sessionId]?.text ?? '',
      updatedAt: offlineState.drafts[sessionId]?.updatedAt,
      dirty: offlineState.drafts[sessionId]?.dirty ?? Object.hasOwn(offlineDraftEdits, sessionId),
    }))
  }, [offlineDraftEdits, offlineState.drafts])

const offlineOutbox = useMemo<OfflineOutboxItemView[]>(() => (
    offlineState.outbox.map((item) => {
      const review = reviewedOutbox[item.id]
      const uncertain = item.status === 'uncertain'
      return omitUndefined<OfflineOutboxItemView>({
        id: item.id,
        sessionId: item.sessionId,
        sessionTitle: item.sessionName,
        text: item.text,
        createdAt: item.createdAt,
        status: review?.sending
          ? 'sending'
          : uncertain
            ? 'uncertain'
            : review?.canSend
              ? 'ready'
              : 'pending-review',
        canSend: !uncertain && review?.canSend === true,
        contextChanged: review?.contextChanged || item.failureKind === 'context-changed',
        detail: review?.detail,
      })
    })
  ), [offlineState.outbox, reviewedOutbox])
return { offlineSnapshots, offlinePins, offlineDrafts, offlineOutbox }
}
