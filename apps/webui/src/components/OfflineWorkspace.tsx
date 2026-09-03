import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpenText,
  Clock3,
  Database,
  Download,
  FileText,
  Inbox,
  LockKeyhole,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'

export type OfflineTimestamp = number | string

export type OfflineMessageRole = 'user' | 'assistant' | 'plan' | 'error'

export interface OfflineMessageView {
  id: string
  role: OfflineMessageRole
  content: string
  timestamp?: OfflineTimestamp
}

export interface OfflineSessionSnapshotView {
  id: string
  title: string
  workspaceName?: string
  lastMessageAt?: OfflineTimestamp
  syncedAt: OfflineTimestamp
  messageCount?: number
  messages: readonly OfflineMessageView[]
}

export interface OfflinePinnedTextView {
  id: string
  sessionId: string
  sessionTitle: string
  messageId: string
  role: OfflineMessageRole
  content: string
  pinnedAt: OfflineTimestamp
}

export interface OfflinePinnedTextCandidate {
  sessionId: string
  sessionTitle: string
  messageId: string
  role: OfflineMessageRole
  content: string
}

export interface OfflineDraftView {
  sessionId: string
  sessionTitle?: string
  text: string
  updatedAt?: OfflineTimestamp
  /** A dirty draft requires explicit review before it replaces the host draft. */
  dirty?: boolean
}

export type OfflineOutboxStatus = 'pending-review' | 'ready' | 'sending' | 'uncertain'

export interface OfflineOutboxItemView {
  id: string
  sessionId: string
  sessionTitle: string
  text: string
  createdAt: OfflineTimestamp
  status: OfflineOutboxStatus
  /** Keep false for uncertain delivery until the user has checked the live transcript. */
  canSend?: boolean
  contextChanged?: boolean
  detail?: string
}

type MaybePromise = void | Promise<void>

export interface OfflineWorkspaceProps {
  /** Explicit user opt-in. When false, no private offline content is displayed. */
  enabled: boolean
  /** True after the host transport is reachable again. Outbox sends remain manual. */
  online: boolean
  snapshots: readonly OfflineSessionSnapshotView[]
  pinnedTexts: readonly OfflinePinnedTextView[]
  drafts: readonly OfflineDraftView[]
  outbox: readonly OfflineOutboxItemView[]
  retentionDays: number
  lastSyncedAt?: OfflineTimestamp
  storageBytes?: number
  storageLimitBytes?: number
  draftMaxChars?: number
  maxOutboxItems?: number
  selectedSnapshotId?: string
  enablePending?: boolean
  errorMessage?: string
  retentionOptionsDays?: readonly number[]
  onEnable?: () => MaybePromise
  onRetry?: () => MaybePromise
  onClose?: () => MaybePromise
  onSelectSnapshot?: (sessionId: string) => MaybePromise
  onPinText?: (candidate: OfflinePinnedTextCandidate) => MaybePromise
  onUnpinText?: (pinId: string) => MaybePromise
  onDraftChange?: (sessionId: string, text: string) => void
  onAddToOutbox?: (sessionId: string, text: string) => MaybePromise
  onReviewOutbox?: (itemId: string) => MaybePromise
  onSendOutbox?: (itemId: string) => MaybePromise
  onDeleteOutbox?: (itemId: string) => MaybePromise
  onRetentionDaysChange?: (days: number) => MaybePromise
  onExportOfflineData?: () => MaybePromise
  onClearOfflineData?: () => MaybePromise
}

type MobilePane = 'sessions' | 'reader' | 'offline'

const MAX_VISIBLE_SNAPSHOTS = 10

function timestampValue(value: OfflineTimestamp | undefined): number | null {
  if (value === undefined) return null
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatTimestamp(value: OfflineTimestamp | undefined, locale: string): string {
  const timestamp = timestampValue(value)
  if (timestamp === null) return '—'
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

function isoTimestamp(value: OfflineTimestamp | undefined): string | undefined {
  const timestamp = timestampValue(value)
  return timestamp === null ? undefined : new Date(timestamp).toISOString()
}

function formatBytes(bytes: number | undefined, locale: string): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unitIndex]}`
}

function normalizeSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
}

function messageRoleLabel(
  role: OfflineMessageRole,
  translate: (key: string, fallback: string) => string,
): string {
  switch (role) {
    case 'user': return translate('webui.offlineRoleUser', 'You')
    case 'assistant': return translate('webui.offlineRoleAssistant', 'Robb')
    case 'plan': return translate('webui.offlineRolePlan', 'Plan')
    case 'error': return translate('webui.offlineRoleError', 'Error')
  }
}

function outboxTone(status: OfflineOutboxStatus): string {
  if (status === 'uncertain') return 'border-amber-500/35 bg-amber-500/10'
  if (status === 'ready') return 'border-emerald-500/25 bg-emerald-500/8'
  return 'border-border bg-card'
}

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
    <main ref={rootRef} tabIndex={-1} className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground outline-none" aria-labelledby="offline-workspace-title">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/95 px-[max(16px,env(safe-area-inset-left))] pb-3 pr-[max(16px,env(safe-area-inset-right))] pt-[max(12px,env(safe-area-inset-top))] backdrop-blur-xl">
        <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border ${online ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>
          {online ? <Wifi className="h-5 w-5" aria-hidden="true" /> : <WifiOff className="h-5 w-5" aria-hidden="true" />}
        </div>
        <div className="min-w-0 flex-1">
          <h1 id="offline-workspace-title" className="truncate text-base font-semibold sm:text-lg">
            {online
              ? t('webui.offlineReviewTitle', 'Review offline work')
              : t('webui.offlineWorkspaceTitle', 'Offline workspace')}
          </h1>
          <p className="truncate text-xs text-foreground/80" aria-live="polite">
            {online
              ? t('webui.offlineBackOnline', 'Back online · Nothing will be sent without your confirmation')
              : t('webui.offlineLocalOnly', 'Local read-only history · Last sync {{date}}', { date: formatTimestamp(lastSyncedAt, locale) })}
          </p>
        </div>
        {onRetry && (
          <button
            type="button"
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            disabled={busyAction !== null}
            aria-label={t('common.retry', 'Retry')}
            onClick={() => void runAction('retry', onRetry)}
          >
            <RefreshCw className={`h-4 w-4 ${busyAction === 'retry' ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span className="hidden sm:inline">{t('common.retry', 'Retry')}</span>
          </button>
        )}
        {online && onClose && (
          <button
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-background hover:bg-muted disabled:opacity-50"
            aria-label={t('common.close', 'Close')}
            disabled={busyAction !== null}
            onClick={() => void runAction('close', onClose)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </header>

      {mobileNavigation}

      {(errorMessage || actionError) && (
        <div className="shrink-0 border-b border-destructive/35 bg-background px-4 py-2 text-sm font-medium text-foreground" role="alert">
          {errorMessage || actionError}
        </div>
      )}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <section
          className={`${mobilePane === 'sessions' ? 'flex' : 'hidden'} min-h-0 flex-col border-r border-border bg-card/45 lg:flex`}
          aria-labelledby="offline-sessions-heading"
        >
          <div className="shrink-0 border-b border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id="offline-sessions-heading" className="text-sm font-semibold">{t('webui.offlineRecentSessions', 'Recent conversations')}</h2>
              <span className="text-xs text-foreground/80">{visibleSnapshots.length}/{MAX_VISIBLE_SNAPSHOTS}</span>
            </div>
            <label className="relative mt-3 block">
              <span className="sr-only">{t('webui.offlineSearch', 'Search offline conversations')}</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('webui.offlineSearchPlaceholder', 'Search saved text…')}
                className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {filteredSnapshots.length === 0 ? (
              <div className="grid min-h-40 place-items-center px-5 text-center text-sm text-foreground/70">
                <p>{searchQuery.trim().length >= 2
                  ? t('webui.offlineNoSearchResults', 'No saved conversation matches this search.')
                  : t('webui.offlineNoSnapshots', 'No conversation snapshot is available yet. Connect once to synchronize recent text.')}</p>
              </div>
            ) : (
              <ul className="space-y-1" aria-label={t('webui.offlineRecentSessions', 'Recent conversations')}>
                {filteredSnapshots.map((snapshot) => {
                  const selected = snapshot.id === effectiveSelectedId
                  return (
                    <li key={snapshot.id}>
                      <button
                        type="button"
                        className={`min-h-16 w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${selected ? 'border-accent/45 bg-accent/12 text-foreground' : 'border-transparent hover:bg-muted'}`}
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => selectSnapshot(snapshot.id, true)}
                      >
                        <span className="block truncate text-sm font-medium">{snapshot.title || t('chat.newChat', 'New chat')}</span>
                        <span className="mt-1 flex items-center justify-between gap-2 text-[11px] text-foreground/75">
                          <span className="truncate">{snapshot.workspaceName || t('webui.offlineSavedText', 'Saved text')}</span>
                          <time dateTime={isoTimestamp(snapshot.lastMessageAt)}>
                            {formatTimestamp(snapshot.lastMessageAt, locale)}
                          </time>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            {pinnedTexts.length > 0 && (
              <div className="mt-5 border-t border-border pt-4">
                <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-foreground/80">
                  {t('webui.offlinePinned', 'Pinned text')}
                </h3>
                <ul className="mt-2 space-y-2">
                  {pinnedTexts.map((pin) => (
                    <li key={pin.id} className="flex items-start gap-1 rounded-xl border border-border bg-background p-1.5">
                      <button
                        type="button"
                        className="min-h-11 min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
                        onClick={() => selectSnapshot(pin.sessionId, true)}
                      >
                        <span className="block truncate text-xs font-medium">{pin.sessionTitle}</span>
                        <span className="mt-1 block line-clamp-2 text-xs text-foreground/80">{pin.content}</span>
                      </button>
                      <button
                        type="button"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-foreground/70 hover:bg-muted hover:text-foreground disabled:opacity-50"
                        aria-label={t('webui.offlineUnpin', 'Unpin text')}
                        disabled={!onUnpinText || busyAction !== null}
                        onClick={() => void runAction(`unpin:${pin.id}`, onUnpinText ? () => onUnpinText(pin.id) : undefined)}
                      >
                        <PinOff className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section
          ref={readerPaneRef}
          tabIndex={-1}
          className={`${mobilePane === 'reader' ? 'flex' : 'hidden'} min-h-0 flex-col bg-background lg:flex`}
          aria-labelledby="offline-reader-heading"
        >
          {selectedSnapshot ? (
            <>
              <div className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
                <button
                  type="button"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-muted lg:hidden"
                  aria-label={t('webui.offlineBackToSessions', 'Back to conversations')}
                  onClick={() => setMobilePane('sessions')}
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </button>
                <div className="min-w-0 flex-1">
                  <h2 id="offline-reader-heading" className="truncate text-sm font-semibold">{selectedSnapshot.title}</h2>
                  <p className="truncate text-xs text-foreground/70">
                    {t('webui.offlineReadOnlySnapshot', 'Read-only snapshot · Synced {{date}}', { date: formatTimestamp(selectedSnapshot.syncedAt, locale) })}
                  </p>
                </div>
                <LockKeyhole className="h-4 w-4 shrink-0 text-foreground/70" aria-label={t('webui.offlineEncrypted', 'Encrypted on this device')} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 lg:px-8">
                <ol className="mx-auto max-w-3xl space-y-4" aria-label={t('webui.offlineTranscript', 'Saved conversation transcript')}>
                  {selectedSnapshot.messages.map((message) => {
                    const pin = pinnedByMessage.get(`${selectedSnapshot.id}:${message.id}`)
                    const role = messageRoleLabel(message.role, (key, fallback) => t(key, fallback))
                    return (
                      <li key={message.id}>
                        <article className={`rounded-2xl border p-4 ${message.role === 'user' ? 'ml-auto max-w-[92%] border-accent/20 bg-accent/8' : message.role === 'error' ? 'border-destructive/25 bg-destructive/8' : 'border-border bg-card/65'}`}>
                          <header className="mb-2 flex items-center gap-2">
                            <span className="text-xs font-semibold">{role}</span>
                            {message.timestamp !== undefined && (
                              <time className="text-[11px] text-foreground/70" dateTime={isoTimestamp(message.timestamp)}>
                                {formatTimestamp(message.timestamp, locale)}
                              </time>
                            )}
                            <button
                              type="button"
                              className="ml-auto flex h-11 w-11 items-center justify-center rounded-xl text-foreground/70 hover:bg-muted hover:text-foreground disabled:opacity-50"
                              aria-label={pin
                                ? t('webui.offlineUnpin', 'Unpin text')
                                : t('webui.offlinePin', 'Pin text for offline access')}
                              aria-pressed={Boolean(pin)}
                              disabled={busyAction !== null || (pin ? !onUnpinText : !onPinText)}
                              onClick={() => {
                                if (pin) {
                                  void runAction(`unpin:${pin.id}`, onUnpinText ? () => onUnpinText(pin.id) : undefined)
                                } else {
                                  const candidate: OfflinePinnedTextCandidate = {
                                    sessionId: selectedSnapshot.id,
                                    sessionTitle: selectedSnapshot.title,
                                    messageId: message.id,
                                    role: message.role,
                                    content: message.content,
                                  }
                                  void runAction(`pin:${message.id}`, onPinText ? () => onPinText(candidate) : undefined)
                                }
                              }}
                            >
                              {pin ? <PinOff className="h-4 w-4" aria-hidden="true" /> : <Pin className="h-4 w-4" aria-hidden="true" />}
                            </button>
                          </header>
                          <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
                        </article>
                      </li>
                    )
                  })}
                </ol>
                {selectedSnapshot.messages.length === 0 && (
                  <div className="grid min-h-52 place-items-center text-center text-sm text-foreground/70">
                    <p>{t('webui.offlineEmptyTranscript', 'This saved snapshot does not contain displayable text.')}</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-sm text-foreground/70">
              <div>
                <BookOpenText className="mx-auto mb-3 h-8 w-8" aria-hidden="true" />
                <h2 id="offline-reader-heading" className="font-medium text-foreground">{t('webui.offlineSelectConversation', 'Select a saved conversation')}</h2>
                <p className="mt-1">{t('webui.offlineSelectConversationDescription', 'Available text will open here in read-only mode.')}</p>
              </div>
            </div>
          )}
        </section>

        <aside
          ref={offlinePaneRef}
          tabIndex={-1}
          className={`${mobilePane === 'offline' ? 'flex' : 'hidden'} min-h-0 flex-col border-l border-border bg-card/45 lg:flex`}
          aria-labelledby="offline-tools-heading"
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <section className="border-b border-border p-4" aria-labelledby="offline-draft-heading">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-accent" aria-hidden="true" />
                <h2 id="offline-tools-heading" className="sr-only">{t('webui.offlineTools', 'Offline tools')}</h2>
                <h3 id="offline-draft-heading" className="text-sm font-semibold">{t('webui.offlineDraft', 'Offline draft')}</h3>
                {drafts.find((draft) => draft.sessionId === effectiveSelectedId)?.dirty && (
                  <span className="ml-auto rounded-full bg-amber-950 px-2 py-1 text-[10px] font-medium text-white dark:bg-amber-100 dark:text-amber-950">
                    {t('webui.offlineLocalChange', 'Local change')}
                  </span>
                )}
              </div>
              <p id="offline-draft-description" className="mt-1.5 text-xs leading-5 text-foreground/70">
                {online
                  ? t('webui.offlineDraftReviewDescription', 'Review this local text before adding it to the outbox.')
                  : t('webui.offlineDraftDescription', 'Draft text is saved locally. Adding it to the outbox still will not send it.')}
              </p>
              {selectableTargets.length > 0 && (
                <label className="mt-3 block text-xs font-medium">
                  <span>{t('webui.offlineDraftForSession', 'Draft for the selected conversation')}</span>
                  <select
                    value={effectiveSelectedId ?? ''}
                    onChange={(event) => {
                      if (event.target.value) selectSnapshot(event.target.value)
                    }}
                    className="mt-1.5 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">{t('webui.offlineChooseDraftSession', 'Choose a conversation first')}</option>
                    {selectableTargets.map((target) => (
                      <option key={target.sessionId} value={target.sessionId}>
                        {target.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="mt-3 block">
                <span className="sr-only">{t('webui.offlineDraftForSession', 'Draft for the selected conversation')}</span>
                <textarea
                  value={selectedDraft}
                  onChange={(event) => {
                    if (effectiveSelectedId) onDraftChange?.(effectiveSelectedId, event.target.value)
                  }}
                  disabled={!effectiveSelectedId || !onDraftChange}
                  rows={6}
                  maxLength={draftMaxChars}
                  aria-describedby="offline-draft-description offline-draft-counter"
                  placeholder={effectiveSelectedId
                    ? t('webui.offlineDraftPlaceholder', 'Write a message to review later…')
                    : t('webui.offlineChooseDraftSession', 'Choose a conversation first')}
                  className="min-h-32 w-full resize-y rounded-xl border border-border bg-background p-3 text-sm leading-5 outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              <div id="offline-draft-counter" className="mt-1 text-right text-[11px] tabular-nums text-foreground/70">
                {selectedDraft.length.toLocaleString(locale)} / {draftMaxChars.toLocaleString(locale)}
              </div>
              <button
                type="button"
                className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 text-sm font-semibold text-accent-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50 disabled:cursor-wait disabled:opacity-50"
                disabled={busyAction !== null}
                aria-disabled={addToOutboxUnavailable || busyAction !== null}
                aria-describedby={outboxFull
                  ? 'offline-outbox-capacity-message'
                  : 'offline-draft-description'}
                title={outboxFull
                  ? t('webui.offlineOutboxFull', 'The offline outbox is full. Send or delete an item before adding another.')
                  : !selectedSnapshot && !online
                    ? t('webui.offlineReconnectBeforeSend', 'Reconnect before sending')
                    : undefined}
                onClick={() => {
                  if (addToOutboxUnavailable || busyAction !== null || !effectiveSelectedId) return
                  void runAction('add-outbox', () => onAddToOutbox?.(effectiveSelectedId, selectedDraft.trim()))
                }}
              >
                {busyAction === 'add-outbox'
                  ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <Inbox className="h-4 w-4" aria-hidden="true" />}
                {t('webui.offlineAddToOutbox', 'Add to outbox')}
              </button>
            </section>

            <section className="border-b border-border p-4" aria-labelledby="offline-outbox-heading">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-accent" aria-hidden="true" />
                  <h3 id="offline-outbox-heading" className="text-sm font-semibold">{t('webui.offlineOutbox', 'Outbox')}</h3>
                </div>
                <span className="rounded-full bg-muted px-2 py-1 text-[11px] text-foreground/70">{outbox.length}/{maxOutboxItems}</span>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-foreground/70">
                {online
                  ? t('webui.offlineOutboxOnlineDescription', 'Review every item against the current conversation, then send it manually.')
                  : t('webui.offlineOutboxDescription', 'These items remain on this device until you send or delete them, or until the {{count}}-day retention period ends.', { count: retentionDays })}
              </p>
              {outboxFull && (
                <p
                  id="offline-outbox-capacity-message"
                  className="mt-2 rounded-lg border border-amber-700/40 bg-amber-950 p-2 text-xs font-medium leading-5 text-white dark:border-amber-300/40 dark:bg-amber-100 dark:text-amber-950"
                  role="status"
                >
                  {t('webui.offlineOutboxFull', 'The offline outbox is full. Send or delete an item before adding another.')}
                </p>
              )}

              {outbox.length === 0 ? (
                <div className="mt-3 rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-foreground/70">
                  {t('webui.offlineOutboxEmpty', 'The outbox is empty.')}
                </div>
              ) : (
                <ul className="mt-3 space-y-3">
                  {outbox.map((item) => {
                    const uncertain = item.status === 'uncertain'
                    const sending = item.status === 'sending' || busyAction === `send:${item.id}`
                    const canSend = online && item.canSend === true && !sending
                    return (
                      <li key={item.id} className={`rounded-xl border p-3 ${outboxTone(item.status)}`}>
                        <div className="flex items-start gap-2">
                          {uncertain
                            ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                            : <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-foreground/70" aria-hidden="true" />}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-semibold">{item.sessionTitle}</p>
                            <time className="text-[11px] text-foreground/70" dateTime={isoTimestamp(item.createdAt)}>
                              {formatTimestamp(item.createdAt, locale)}
                            </time>
                          </div>
                        </div>
                        <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-xs leading-5">{item.text}</p>
                        {(uncertain || item.contextChanged || item.detail) && (
                          <div className="mt-2 rounded-lg bg-background/70 p-2 text-[11px] leading-4 text-foreground/70" role={uncertain ? 'alert' : undefined}>
                            {uncertain && (
                              <p className="font-medium text-amber-700 dark:text-amber-300">
                                {t('webui.offlineDeliveryUncertain', 'Delivery is uncertain. This item cannot be retried here; check the live conversation, then delete it or recompose manually.')}
                              </p>
                            )}
                            {item.contextChanged && (
                              <p>{t('webui.offlineContextChanged', 'The conversation changed since this message was prepared.')}</p>
                            )}
                            {item.detail && <p>{item.detail}</p>}
                          </div>
                        )}
                        <div className="mt-3 grid grid-cols-3 gap-1.5">
                          <button
                            type="button"
                            className="flex min-h-11 items-center justify-center rounded-lg border border-border bg-background px-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
                            disabled={!onReviewOutbox || busyAction !== null}
                            onClick={() => {
                              selectSnapshot(item.sessionId, true)
                              void runAction(`review:${item.id}`, onReviewOutbox ? () => onReviewOutbox(item.id) : undefined)
                            }}
                          >
                            {t('webui.offlineReview', 'Review')}
                          </button>
                          <button
                            type="button"
                            className="flex min-h-11 items-center justify-center gap-1 rounded-lg bg-accent px-2 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-45"
                            disabled={!canSend || !onSendOutbox || busyAction !== null}
                            title={!online
                              ? t('webui.offlineReconnectBeforeSend', 'Reconnect before sending')
                              : !item.canSend
                                ? t('webui.offlineReviewBeforeSend', 'Review this item before sending')
                                : undefined}
                            onClick={() => void runAction(`send:${item.id}`, onSendOutbox ? () => onSendOutbox(item.id) : undefined)}
                          >
                            {sending
                              ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                              : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
                            {t('webui.offlineSend', 'Send')}
                          </button>
                          <button
                            type="button"
                            className="flex min-h-11 items-center justify-center rounded-lg border border-destructive/25 bg-background px-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            disabled={!onDeleteOutbox || busyAction !== null}
                            aria-label={t('webui.offlineDeleteOutboxItem', 'Delete outbox item')}
                            onClick={() => void runAction(`delete:${item.id}`, onDeleteOutbox ? () => onDeleteOutbox(item.id) : undefined)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className="p-4" aria-labelledby="offline-settings-heading">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-accent" aria-hidden="true" />
                <h3 id="offline-settings-heading" className="text-sm font-semibold">{t('webui.offlineSettings', 'Offline settings')}</h3>
              </div>
              <dl className="mt-3 space-y-2 rounded-xl border border-border bg-background p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-foreground/70">{t('webui.offlineLastSync', 'Last synchronization')}</dt>
                  <dd className="text-right font-medium">{formatTimestamp(lastSyncedAt, locale)}</dd>
                </div>
                {formattedStorage && (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-foreground/70">{t('webui.offlineStorage', 'Encrypted storage')}</dt>
                    <dd className="text-right font-medium">{formattedStorage}{formattedLimit ? ` / ${formattedLimit}` : ''}</dd>
                  </div>
                )}
              </dl>
              <label className="mt-3 block text-xs font-medium" htmlFor="offline-retention-days">
                {t('webui.offlineRetention', 'Keep offline data for')}
              </label>
              <select
                id="offline-retention-days"
                value={retentionDays}
                disabled={!onRetentionDaysChange || busyAction !== null}
                onChange={(event) => {
                  const days = Number.parseInt(event.target.value, 10)
                  if (Number.isFinite(days)) {
                    void runAction('retention', onRetentionDaysChange ? () => onRetentionDaysChange(days) : undefined)
                  }
                }}
                className="mt-1.5 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {availableRetentionOptions.map((days) => (
                  <option key={days} value={days}>{t('webui.offlineRetentionDays', '{{count}} days', { count: days })}</option>
                ))}
              </select>

              <button
                type="button"
                className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
                disabled={!onExportOfflineData || busyAction !== null}
                onClick={() => void runAction('export', onExportOfflineData)}
              >
                {busyAction === 'export'
                  ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <Download className="h-4 w-4" aria-hidden="true" />}
                {t('webui.offlineExportData', 'Export offline data')}
              </button>

              {!clearArmed ? (
                <button
                  ref={clearDataButtonRef}
                  type="button"
                  className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-destructive/25 px-3 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  disabled={!onClearOfflineData || busyAction !== null}
                  onClick={() => setClearArmed(true)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t('webui.offlineClearData', 'Clear offline data')}
                </button>
              ) : (
                <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/8 p-3" role="alert">
                  <p className="text-xs leading-5 text-destructive">
                    {t('webui.offlineClearConfirm', 'This removes snapshots, pins, drafts, and outbox items from this device. It does not delete host conversations.')}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      ref={clearCancelButtonRef}
                      type="button"
                      className="min-h-11 rounded-lg border border-border bg-background px-2 text-xs font-medium"
                      onClick={() => setClearArmed(false)}
                    >
                      {t('common.cancel', 'Cancel')}
                    </button>
                    <button
                      type="button"
                      className="min-h-11 rounded-lg bg-destructive px-2 text-xs font-semibold text-destructive-foreground disabled:opacity-50"
                      disabled={busyAction !== null}
                      onClick={() => void runAction('clear', async () => {
                        await onClearOfflineData?.()
                        setClearArmed(false)
                      })}
                    >
                      {busyAction === 'clear' ? t('common.loading', 'Loading…') : t('webui.offlineClearConfirmButton', 'Clear on this device')}
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-4 flex items-start gap-2 rounded-xl bg-accent/7 p-3 text-[11px] leading-4 text-foreground/70">
                <Database className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                <p>{t('webui.offlineStorageNotice', 'Private offline content stays in encrypted browser storage, separate from the public PWA asset cache.')}</p>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </main>
  )
}
