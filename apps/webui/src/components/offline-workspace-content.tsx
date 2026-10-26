

import { ArrowLeft, BookOpenText, LockKeyhole, Pin, PinOff, RefreshCw, Search, Wifi, WifiOff, X } from 'lucide-react';
import { OfflineWorkspaceTools } from "./offline-workspace-tools";
import { type OfflineTimestamp, type OfflineSessionSnapshotView, type OfflinePinnedTextView, type OfflinePinnedTextCandidate, type OfflineDraftView, type OfflineOutboxItemView, type MaybePromise, type MobilePane, MAX_VISIBLE_SNAPSHOTS, formatTimestamp, isoTimestamp, messageRoleLabel } from "./offline-workspace-model";

interface OfflineWorkspaceContentProps {
  rootRef: import("react").RefObject<HTMLElement | null>
  online: boolean
  t: import("i18next").TFunction<"translation", undefined>
  lastSyncedAt: OfflineTimestamp | undefined
  locale: string
  onRetry: (() => MaybePromise) | undefined
  busyAction: string | null
  runAction: (key: string, action: (() => MaybePromise) | undefined) => Promise<void>
  onClose: (() => MaybePromise) | undefined
  mobileNavigation: import("react").JSX.Element
  errorMessage: string | undefined
  actionError: string | null
  mobilePane: MobilePane
  visibleSnapshots: OfflineSessionSnapshotView[]
  searchQuery: string
  setSearchQuery: import("react").Dispatch<import("react").SetStateAction<string>>
  filteredSnapshots: OfflineSessionSnapshotView[]
  effectiveSelectedId: string
  selectSnapshot: (sessionId: string, openReader?: boolean) => void
  pinnedTexts: readonly OfflinePinnedTextView[]
  onUnpinText: ((pinId: string) => MaybePromise) | undefined
  readerPaneRef: import("react").RefObject<HTMLElement | null>
  selectedSnapshot: OfflineSessionSnapshotView | null
  setMobilePane: import("react").Dispatch<import("react").SetStateAction<MobilePane>>
  pinnedByMessage: Map<string, OfflinePinnedTextView>
  onPinText: ((candidate: OfflinePinnedTextCandidate) => MaybePromise) | undefined
  offlinePaneRef: import("react").RefObject<HTMLElement | null>
  drafts: readonly OfflineDraftView[]
  selectableTargets: { sessionId: string; title: string; }[]
  selectedDraft: string
  onDraftChange: ((sessionId: string, text: string) => void) | undefined
  draftMaxChars: number
  addToOutboxUnavailable: boolean
  outboxFull: boolean
  onAddToOutbox: ((sessionId: string, text: string) => MaybePromise) | undefined
  outbox: readonly OfflineOutboxItemView[]
  maxOutboxItems: number
  retentionDays: number
  onReviewOutbox: ((itemId: string) => MaybePromise) | undefined
  onSendOutbox: ((itemId: string) => MaybePromise) | undefined
  onDeleteOutbox: ((itemId: string) => MaybePromise) | undefined
  formattedStorage: string | null
  formattedLimit: string | null
  onRetentionDaysChange: ((days: number) => MaybePromise) | undefined
  availableRetentionOptions: number[]
  onExportOfflineData: (() => MaybePromise) | undefined
  clearArmed: boolean
  clearDataButtonRef: import("react").RefObject<HTMLButtonElement | null>
  onClearOfflineData: (() => MaybePromise) | undefined
  setClearArmed: import("react").Dispatch<import("react").SetStateAction<boolean>>
  clearCancelButtonRef: import("react").RefObject<HTMLButtonElement | null>
}

export function OfflineWorkspaceContent({
  rootRef,
  online,
  t,
  lastSyncedAt,
  locale,
  onRetry,
  busyAction,
  runAction,
  onClose,
  mobileNavigation,
  errorMessage,
  actionError,
  mobilePane,
  visibleSnapshots,
  searchQuery,
  setSearchQuery,
  filteredSnapshots,
  effectiveSelectedId,
  selectSnapshot,
  pinnedTexts,
  onUnpinText,
  readerPaneRef,
  selectedSnapshot,
  setMobilePane,
  pinnedByMessage,
  onPinText,
  offlinePaneRef,
  drafts,
  selectableTargets,
  selectedDraft,
  onDraftChange,
  draftMaxChars,
  addToOutboxUnavailable,
  outboxFull,
  onAddToOutbox,
  outbox,
  maxOutboxItems,
  retentionDays,
  onReviewOutbox,
  onSendOutbox,
  onDeleteOutbox,
  formattedStorage,
  formattedLimit,
  onRetentionDaysChange,
  availableRetentionOptions,
  onExportOfflineData,
  clearArmed,
  clearDataButtonRef,
  onClearOfflineData,
  setClearArmed,
  clearCancelButtonRef,
}: OfflineWorkspaceContentProps) {

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

        <OfflineWorkspaceTools
  offlinePaneRef={offlinePaneRef}
  mobilePane={mobilePane}
  t={t}
  drafts={drafts}
  effectiveSelectedId={effectiveSelectedId}
  online={online}
  selectableTargets={selectableTargets}
  selectSnapshot={selectSnapshot}
  selectedDraft={selectedDraft}
  onDraftChange={onDraftChange}
  draftMaxChars={draftMaxChars}
  locale={locale}
  busyAction={busyAction}
  addToOutboxUnavailable={addToOutboxUnavailable}
  outboxFull={outboxFull}
  selectedSnapshot={selectedSnapshot}
  runAction={runAction}
  onAddToOutbox={onAddToOutbox}
  outbox={outbox}
  maxOutboxItems={maxOutboxItems}
  retentionDays={retentionDays}
  onReviewOutbox={onReviewOutbox}
  onSendOutbox={onSendOutbox}
  onDeleteOutbox={onDeleteOutbox}
  lastSyncedAt={lastSyncedAt}
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
      </div>
    </main>
  )
}
