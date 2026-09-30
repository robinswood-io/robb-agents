import type { ElectronAPI } from '../../electron/src/shared/types'
import type { Session } from '@craft-agent/shared/protocol'
import type { SessionDraft } from '@craft-agent/shared/config'
import {
  OfflineVault,
  anchorsMatch,
  isOfflineVaultEnabled,
  sanitizeSessionSnapshot,
  selectRecentSessions,
  type OfflineOutboxItem,
  type OfflineSessionAnchor,
  type OfflineVaultScope,
  type OfflineVaultScopeToken,
  type OfflineVaultState,
} from './offline-vault'

export type OfflineOutboxSendResult =
  | { status: 'sent' }
  | { status: 'needs-confirmation'; reason: 'context-changed' }
  | { status: 'blocked'; reason: 'session-busy' | 'session-missing' | 'not-connected' }
  | { status: 'uncertain' }

export type OfflineOutboxReviewResult =
  | { status: 'ready'; contextChanged: boolean; reviewedAnchor: OfflineSessionAnchor }
  | { status: 'blocked'; reason: 'session-busy' | 'session-missing' | 'not-connected' }

function anchorForSession(session: Session): OfflineSessionAnchor {
  return {
    messageCount: session.messages.length,
    lastFinalMessageId: session.lastFinalMessageId ?? null,
    lastMessageAt: session.lastMessageAt,
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++
      try {
        results[index] = { status: 'fulfilled', value: await mapper(values[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return results
}

/**
 * Coordinates remote RPC results with the encrypted offline vault. It never
 * sends queued messages automatically; every outbox transmission is initiated
 * by an explicit UI action.
 */
export class OfflineCoordinator {
  private recentCaptureInFlight: { key: string; promise: Promise<void> } | null = null
  private lastRecentCaptureAt = new Map<string, number>()

  constructor(readonly vault: OfflineVault) {}

  isEnabled(): boolean {
    return isOfflineVaultEnabled()
  }

  load(): Promise<OfflineVaultState> {
    return this.vault.load()
  }

  enable(scope: OfflineVaultScope): Promise<void> {
    this.invalidateCaptures()
    return this.vault.enable(scope)
  }

  configureScope(scope: OfflineVaultScope): Promise<void> {
    this.invalidateCaptures()
    return this.vault.configureScope(scope)
  }

  purge(): Promise<void> {
    this.invalidateCaptures()
    return this.vault.purge()
  }

  private invalidateCaptures(): void {
    this.recentCaptureInFlight = null
    this.lastRecentCaptureAt.clear()
  }

  private tokenForWorkspace(workspaceId: string): OfflineVaultScopeToken | null {
    const token = this.vault.getScopeToken()
    return token?.workspaceId === workspaceId ? token : null
  }

  captureSession(session: Session): void {
    if (!this.isEnabled()) return
    const token = this.tokenForWorkspace(session.workspaceId)
    if (!token) return
    void this.vault.upsertSnapshot(sanitizeSessionSnapshot(session), token).catch(() => {})
  }

  captureRecentSessions(
    sessions: readonly Session[],
    loadSession: (sessionId: string) => Promise<Session | null>,
    workspaceId: string,
    force = false,
  ): Promise<void> {
    if (!this.isEnabled()) return Promise.resolve()
    const token = this.tokenForWorkspace(workspaceId)
    if (!token) return Promise.resolve()
    const key = `${token.generation}:${token.deviceId}:${token.workspaceId}`
    if (this.recentCaptureInFlight?.key === key) return this.recentCaptureInFlight.promise
    if (!force && Date.now() - (this.lastRecentCaptureAt.get(key) ?? 0) < 30_000) return Promise.resolve()
    const recent = selectRecentSessions(sessions.filter((session) => session.workspaceId === workspaceId))
    const promise = (async () => {
      const loaded = await mapWithConcurrency(recent, 2, async (metadata) => {
        const hydrated = metadata.messages.length > 0 ? metadata : await loadSession(metadata.id)
        return hydrated ? sanitizeSessionSnapshot(hydrated) : null
      })
      const priorById = new Map(this.vault.getSnapshot().sessions.map((snapshot) => [snapshot.id, snapshot]))
      const snapshots = recent.flatMap((metadata, index) => {
        const result = loaded[index]
        if (result?.status === 'fulfilled' && result.value) return [result.value]
        const prior = priorById.get(metadata.id)
        return prior ? [prior] : []
      })
      await this.vault.replaceSnapshots(snapshots, token)
      this.lastRecentCaptureAt.set(key, Date.now())
    })()
    this.recentCaptureInFlight = { key, promise }
    void promise.finally(() => {
      if (this.recentCaptureInFlight?.promise === promise) this.recentCaptureInFlight = null
    }).catch(() => {})
    return promise
  }

  captureRemoteDrafts(drafts: Record<string, SessionDraft>, workspaceId: string): Promise<void> {
    if (!this.isEnabled()) return Promise.resolve()
    const token = this.tokenForWorkspace(workspaceId)
    if (!token) return Promise.resolve()
    return this.vault.mergeRemoteDrafts(drafts, token)
  }

  async persistDraft(
    sessionId: string,
    draft: SessionDraft,
    connected: boolean,
    saveRemote: () => Promise<void>,
    workspaceId: string,
  ): Promise<void> {
    if (!this.isEnabled()) return saveRemote()
    const token = this.tokenForWorkspace(workspaceId)
    if (!token) return saveRemote()
    if (connected) {
      try {
        await saveRemote()
      } catch {
        // If the RPC lost the connection mid-save, retain a local dirty copy
        // before returning. The shared renderer intentionally fire-and-forgets
        // draft persistence, so rejecting here would only create an unhandled
        // promise while the encrypted local copy is already the safe fallback.
        await this.vault.storeDraft(sessionId, { text: draft.text }, true, token)
        return
      }
      void this.vault.storeDraft(sessionId, draft, false, token).catch(() => {})
      return
    }
    // Offline persistence is intentionally text-only. Attachment references
    // may contain filesystem paths or embedded bytes and are never retained.
    await this.vault.storeDraft(sessionId, { text: draft.text }, true, token)
  }

  async deleteDraft(
    sessionId: string,
    connected: boolean,
    deleteRemote: () => Promise<void>,
    workspaceId: string,
  ): Promise<void> {
    if (!this.isEnabled()) return deleteRemote()
    const token = this.tokenForWorkspace(workspaceId)
    if (!token) return deleteRemote()
    if (connected) {
      await deleteRemote()
      // Do not claim local erasure until the encrypted record is durably
      // updated. mutate() is atomic and preserves the prior copy on failure.
      await this.vault.deleteDraft(sessionId, token)
      return
    }
    // The host API has no draft tombstone/revision contract. Deleting only the
    // local copy while disconnected would make the unchanged host draft
    // silently reappear on the next merge, so retain it for explicit review.
  }

  async sendOutboxItem(
    item: OfflineOutboxItem,
    api: Pick<ElectronAPI, 'getSessionMessages' | 'sendMessage' | 'getTransportConnectionState'>,
    reviewedAnchor: OfflineSessionAnchor,
  ): Promise<OfflineOutboxSendResult> {
    const scopeToken = this.vault.getScopeToken()
    if (!scopeToken) return { status: 'blocked', reason: 'not-connected' }
    const transport = await api.getTransportConnectionState().catch(() => null)
    if (transport?.status !== 'connected') {
      await this.vault.markOutboxFailure(item.id, 'connection-lost', scopeToken)
      return { status: 'blocked', reason: 'not-connected' }
    }

    const session = await api.getSessionMessages(item.sessionId).catch(() => null)
    if (!session) {
      await this.vault.markOutboxFailure(item.id, 'session-missing', scopeToken)
      return { status: 'blocked', reason: 'session-missing' }
    }
    if (session.isProcessing) {
      await this.vault.markOutboxFailure(item.id, 'session-busy', scopeToken)
      return { status: 'blocked', reason: 'session-busy' }
    }
    if (!anchorsMatch(reviewedAnchor, anchorForSession(session))) {
      await this.vault.markOutboxFailure(item.id, 'context-changed', scopeToken)
      return { status: 'needs-confirmation', reason: 'context-changed' }
    }

    // Persist a non-retryable state before the network call. A crash after the
    // host accepts the message can therefore never resurrect a pending item.
    await this.vault.beginOutboxSend(item.id, scopeToken)
    try {
      await api.sendMessage(item.sessionId, item.text, undefined, undefined, {
        expectedSessionAnchor: reviewedAnchor,
      })
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'SESSION_CONTEXT_CHANGED') {
        await this.vault.restoreOutboxAfterContextRejection(item.id, scopeToken)
        return { status: 'needs-confirmation', reason: 'context-changed' }
      }
      return { status: 'uncertain' }
    }
    try {
      await this.vault.removeOutbox(item.id, scopeToken)
      return { status: 'sent' }
    } catch {
      return { status: 'uncertain' }
    }
  }

  async reviewOutboxItem(
    item: OfflineOutboxItem,
    api: Pick<ElectronAPI, 'getSessionMessages' | 'getTransportConnectionState'>,
  ): Promise<OfflineOutboxReviewResult> {
    const scopeToken = this.vault.getScopeToken()
    if (!scopeToken) return { status: 'blocked', reason: 'not-connected' }
    const transport = await api.getTransportConnectionState().catch(() => null)
    if (transport?.status !== 'connected') {
      await this.vault.markOutboxFailure(item.id, 'connection-lost', scopeToken)
      return { status: 'blocked', reason: 'not-connected' }
    }
    const session = await api.getSessionMessages(item.sessionId).catch(() => null)
    if (!session) {
      await this.vault.markOutboxFailure(item.id, 'session-missing', scopeToken)
      return { status: 'blocked', reason: 'session-missing' }
    }
    if (session.isProcessing) {
      await this.vault.markOutboxFailure(item.id, 'session-busy', scopeToken)
      return { status: 'blocked', reason: 'session-busy' }
    }
    const reviewedAnchor = anchorForSession(session)
    if (scopeToken.workspaceId !== session.workspaceId) return { status: 'blocked', reason: 'not-connected' }
    await this.vault.upsertSnapshot(sanitizeSessionSnapshot(session), scopeToken)
    const contextChanged = !anchorsMatch(item.anchor, reviewedAnchor)
    if (contextChanged) await this.vault.markOutboxFailure(item.id, 'context-changed', scopeToken)
    return { status: 'ready', contextChanged, reviewedAnchor }
  }
}
