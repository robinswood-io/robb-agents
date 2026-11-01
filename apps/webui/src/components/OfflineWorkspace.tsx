import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpenText, FileText, Inbox, LockKeyhole, RefreshCw, ShieldCheck, X } from 'lucide-react';

import { OfflineWorkspaceContent } from "./offline-workspace-content";
import { type MaybePromise, type OfflineWorkspaceProps, type MobilePane, MAX_VISIBLE_SNAPSHOTS, timestampValue, formatBytes, normalizeSearch } from "./offline-workspace-model";
export { type OfflineTimestamp, type OfflineMessageRole, type OfflineMessageView, type OfflineSessionSnapshotView, type OfflinePinnedTextView, type OfflinePinnedTextCandidate, type OfflineDraftView, type OfflineOutboxStatus, type OfflineOutboxItemView, type OfflineWorkspaceProps } from "./offline-workspace-model";




export function OfflineWorkspace({
  enabled,
  online,
  snapshots,
  pinnedTexts,
  drafts,
  outbox,
  retentionDays,
  lastSyncedAt,
  storageBytes,
  storageLimitBytes,
  draftMaxChars = 24_000,
  maxOutboxItems = 30,
  selectedSnapshotId,
  enablePending = false,
  errorMessage,
  retentionOptionsDays = [1, 7, 14, 30],
  onEnable,
  onRetry,
  onClose,
  onSelectSnapshot,
  onPinText,
  onUnpinText,
  onDraftChange,
  onAddToOutbox,
  onReviewOutbox,
  onSendOutbox,
  onDeleteOutbox,
  onRetentionDaysChange,
  onExportOfflineData,
  onClearOfflineData,
}: OfflineWorkspaceProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language || 'en'
  const [searchQuery, setSearchQuery] = useState('')
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null)
  const [mobilePane, setMobilePane] = useState<MobilePane>('sessions')
  const [clearArmed, setClearArmed] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  const readerPaneRef = useRef<HTMLElement>(null)
  const offlinePaneRef = useRef<HTMLElement>(null)
  const clearDataButtonRef = useRef<HTMLButtonElement>(null)
  const clearCancelButtonRef = useRef<HTMLButtonElement>(null)
  const clearWasArmedRef = useRef(false)

  const visibleSnapshots = useMemo(
    () => [...snapshots]
      .sort((left, right) => (timestampValue(right.lastMessageAt) ?? 0) - (timestampValue(left.lastMessageAt) ?? 0))
      .slice(0, MAX_VISIBLE_SNAPSHOTS),
    [snapshots],
  )

  const filteredSnapshots = useMemo(() => {
    const query = normalizeSearch(searchQuery.trim())
    if (query.length < 2) return visibleSnapshots
    return visibleSnapshots.filter((snapshot) => normalizeSearch([
      snapshot.title,
      snapshot.workspaceName ?? '',
      ...snapshot.messages.map((message) => message.content),
    ].join('\n')).includes(query))
  }, [searchQuery, visibleSnapshots])

  const selectableSessionIds = useMemo(() => new Set([
    ...visibleSnapshots.map((snapshot) => snapshot.id),
    ...drafts.map((draft) => draft.sessionId),
    ...outbox.map((item) => item.sessionId),
  ]), [drafts, outbox, visibleSnapshots])
  const requestedSelectedId = selectedSnapshotId ?? internalSelectedId
  const effectiveSelectedId = requestedSelectedId && selectableSessionIds.has(requestedSelectedId)
    ? requestedSelectedId
    : visibleSnapshots[0]?.id ?? drafts[0]?.sessionId ?? outbox[0]?.sessionId ?? null
  const selectedSnapshot = visibleSnapshots.find((snapshot) => snapshot.id === effectiveSelectedId) ?? null
  const selectedDraft = drafts.find((draft) => draft.sessionId === effectiveSelectedId)?.text ?? ''
  const selectableTargets = useMemo(() => {
    const titles = new Map<string, string>()
    for (const snapshot of visibleSnapshots) titles.set(snapshot.id, snapshot.title)
    for (const item of outbox) if (!titles.has(item.sessionId)) titles.set(item.sessionId, item.sessionTitle)
    for (const draft of drafts) if (!titles.has(draft.sessionId)) titles.set(draft.sessionId, draft.sessionTitle || draft.sessionId)
    return [...titles].map(([sessionId, title]) => ({ sessionId, title }))
  }, [drafts, outbox, visibleSnapshots])
  const pinnedByMessage = useMemo(
    () => new Map(pinnedTexts.map((pin) => [`${pin.sessionId}:${pin.messageId}`, pin])),
    [pinnedTexts],
  )
  const formattedStorage = formatBytes(storageBytes, locale)
  const formattedLimit = formatBytes(storageLimitBytes, locale)
  const outboxFull = outbox.length >= maxOutboxItems
  const addToOutboxUnavailable = !effectiveSelectedId
    || !selectedDraft.trim()
    || (!selectedSnapshot && !online)
    || outboxFull
    || !onAddToOutbox
  const availableRetentionOptions = useMemo(
    () => [...new Set([...retentionOptionsDays, retentionDays])].filter((days) => days > 0).sort((a, b) => a - b),
    [retentionDays, retentionOptionsDays],
  )

  useEffect(() => {
    if (effectiveSelectedId && selectableSessionIds.has(effectiveSelectedId)) return
    setInternalSelectedId(visibleSnapshots[0]?.id ?? drafts[0]?.sessionId ?? outbox[0]?.sessionId ?? null)
  }, [drafts, effectiveSelectedId, outbox, selectableSessionIds, visibleSnapshots])

  useEffect(() => {
    if (!online) setClearArmed(false)
  }, [online])

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  useEffect(() => {
    if (mobilePane === 'reader') readerPaneRef.current?.focus()
    if (mobilePane === 'offline') offlinePaneRef.current?.focus()
  }, [mobilePane])

  useEffect(() => {
    let focusFrame: number | undefined
    if (clearArmed) {
      clearWasArmedRef.current = true
      focusFrame = window.requestAnimationFrame(() => clearCancelButtonRef.current?.focus())
    } else if (clearWasArmedRef.current) {
      clearWasArmedRef.current = false
      focusFrame = window.requestAnimationFrame(() => clearDataButtonRef.current?.focus())
    }
    return () => {
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame)
    }
  }, [clearArmed])

  const runAction = async (key: string, action: (() => MaybePromise) | undefined) => {
    if (!action || busyAction) return
    setBusyAction(key)
    setActionError(null)
    try {
      await action()
    } catch {
      setActionError(t('webui.offlineActionFailed', 'The action could not be completed. Review the current local state before trying again.'))
    } finally {
      setBusyAction(null)
    }
  }

  const selectSnapshot = (sessionId: string, openReader = false) => {
    if (selectedSnapshotId === undefined) setInternalSelectedId(sessionId)
    if (onSelectSnapshot) {
      setActionError(null)
      try {
        void Promise.resolve(onSelectSnapshot(sessionId)).catch(() => {
          setActionError(t('webui.offlineActionFailed', 'The action could not be completed. Review the current local state before trying again.'))
        })
      } catch {
        setActionError(t('webui.offlineActionFailed', 'The action could not be completed. Review the current local state before trying again.'))
      }
    }
    if (openReader) setMobilePane('reader')
  }

  if (!enabled) {
    return (
      <main ref={rootRef} tabIndex={-1} className="webui-state-page outline-none" aria-labelledby="offline-opt-in-title">
        <section className="webui-state-card" aria-describedby="offline-opt-in-description">
          <div className="webui-state-icon text-accent">
            <LockKeyhole className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 id="offline-opt-in-title">{t('webui.offlineOptInTitle', 'Keep useful work available offline')}</h1>
          <p id="offline-opt-in-description">
            {t('webui.offlineOptInDescription', 'With your permission, Robb can keep an encrypted text-only copy of up to 10 recent conversations on this device.')}
          </p>
          <ul className="mx-auto mt-5 max-w-[390px] space-y-2 text-left text-sm text-foreground/75">
            <li className="flex gap-2 rounded-xl border border-border/70 bg-card/70 p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
              <span>{t('webui.offlineOptInEncrypted', 'Saved free text is encrypted locally. Structured file, credential, tool, and authentication fields stay excluded, but text you wrote may itself contain sensitive information.')}</span>
            </li>
            <li className="flex gap-2 rounded-xl border border-border/70 bg-card/70 p-3">
              <Inbox className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              <span>{t('webui.offlineOptInOutbox', 'Messages prepared offline are never sent automatically. You review each one after reconnecting.')}</span>
            </li>
          </ul>
          {(errorMessage || actionError) && (
            <p className="webui-state-detail text-destructive" role="alert">{errorMessage || actionError}</p>
          )}
          <div className="webui-state-actions">
            {onEnable && (
              <button
                type="button"
                className="webui-state-primary"
                disabled={enablePending || busyAction !== null}
                aria-busy={enablePending || busyAction === 'enable'}
                onClick={() => void runAction('enable', onEnable)}
              >
                {(enablePending || busyAction === 'enable')
                  ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <LockKeyhole className="h-4 w-4" aria-hidden="true" />}
                {t('webui.offlineEnable', 'Enable offline workspace')}
              </button>
            )}
            {onRetry && (
              <button type="button" className="webui-state-secondary" onClick={() => void runAction('retry', onRetry)}>
                <RefreshCw className={`h-4 w-4 ${busyAction === 'retry' ? 'animate-spin' : ''}`} aria-hidden="true" />
                {t('common.retry', 'Retry')}
              </button>
            )}
            {online && onClose && (
              <button type="button" className="webui-state-secondary" onClick={() => void runAction('close', onClose)}>
                <X className="h-4 w-4" aria-hidden="true" />
                {t('common.close', 'Close')}
              </button>
            )}
          </div>
        </section>
      </main>
    )
  }

  const mobileNavigation = (
    <nav
      className="grid shrink-0 grid-cols-3 gap-1 border-b border-border bg-card/95 p-1.5 lg:hidden"
      aria-label={t('webui.offlineNavigation', 'Offline workspace sections')}
    >
      {([
        ['sessions', BookOpenText, t('webui.offlineRecent', 'Recent')],
        ['reader', FileText, t('webui.offlineReader', 'Reader')],
        ['offline', Inbox, t('webui.offlinePrepare', 'Prepare')],
      ] as const).map(([pane, Icon, label]) => (
        <button
          key={pane}
          type="button"
          className={`flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium ${mobilePane === pane ? 'bg-foreground text-background' : 'text-foreground/70 hover:bg-muted'}`}
          aria-pressed={mobilePane === pane}
          onClick={() => setMobilePane(pane)}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          <span>{label}</span>
          {pane === 'offline' && outbox.length > 0 && (
            <span className="min-w-5 rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground">{outbox.length}</span>
          )}
        </button>
      ))}
    </nav>
  )

  return (
    <OfflineWorkspaceContent
      rootRef={rootRef}
      online={online}
      t={t}
      lastSyncedAt={lastSyncedAt}
      locale={locale}
      onRetry={onRetry}
      busyAction={busyAction}
      runAction={runAction}
      onClose={onClose}
      mobileNavigation={mobileNavigation}
      errorMessage={errorMessage}
      actionError={actionError}
      mobilePane={mobilePane}
      visibleSnapshots={visibleSnapshots}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      filteredSnapshots={filteredSnapshots}
      effectiveSelectedId={effectiveSelectedId}
      selectSnapshot={selectSnapshot}
      pinnedTexts={pinnedTexts}
      onUnpinText={onUnpinText}
      readerPaneRef={readerPaneRef}
      selectedSnapshot={selectedSnapshot}
      setMobilePane={setMobilePane}
      pinnedByMessage={pinnedByMessage}
      onPinText={onPinText}
      offlinePaneRef={offlinePaneRef}
      drafts={drafts}
      selectableTargets={selectableTargets}
      selectedDraft={selectedDraft}
      onDraftChange={onDraftChange}
      draftMaxChars={draftMaxChars}
      addToOutboxUnavailable={addToOutboxUnavailable}
      outboxFull={outboxFull}
      onAddToOutbox={onAddToOutbox}
      outbox={outbox}
      maxOutboxItems={maxOutboxItems}
      retentionDays={retentionDays}
      onReviewOutbox={onReviewOutbox}
      onSendOutbox={onSendOutbox}
      onDeleteOutbox={onDeleteOutbox}
      formattedStorage={formattedStorage}
      formattedLimit={formattedLimit}
      onRetentionDaysChange={onRetentionDaysChange}
      availableRetentionOptions={availableRetentionOptions}
      onExportOfflineData={onExportOfflineData}
      clearArmed={clearArmed}
      clearDataButtonRef={clearDataButtonRef}
      onClearOfflineData={onClearOfflineData}
      setClearArmed={setClearArmed}
      clearCancelButtonRef={clearCancelButtonRef}
    />
  )
}
