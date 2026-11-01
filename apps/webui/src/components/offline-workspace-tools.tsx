

import { AlertTriangle, Clock3, Database, Download, FileText, Inbox, RefreshCw, Send, Settings2, Trash2 } from 'lucide-react';
import { type OfflineTimestamp, type OfflineSessionSnapshotView, type OfflineDraftView, type OfflineOutboxItemView, type MaybePromise, type MobilePane, formatTimestamp, isoTimestamp, outboxTone } from "./offline-workspace-model";

interface OfflineWorkspaceToolsProps {
  offlinePaneRef: import("react").RefObject<HTMLElement | null>
  mobilePane: MobilePane
  t: import("i18next").TFunction<"translation", undefined>
  drafts: readonly OfflineDraftView[]
  effectiveSelectedId: string | null
  online: boolean
  selectableTargets: { sessionId: string; title: string; }[]
  selectSnapshot: (sessionId: string, openReader?: boolean) => void
  selectedDraft: string
  onDraftChange: ((sessionId: string, text: string) => void) | undefined
  draftMaxChars: number
  locale: string
  busyAction: string | null
  addToOutboxUnavailable: boolean
  outboxFull: boolean
  selectedSnapshot: OfflineSessionSnapshotView | null
  runAction: (key: string, action: (() => MaybePromise) | undefined) => Promise<void>
  onAddToOutbox: ((sessionId: string, text: string) => MaybePromise) | undefined
  outbox: readonly OfflineOutboxItemView[]
  maxOutboxItems: number
  retentionDays: number
  onReviewOutbox: ((itemId: string) => MaybePromise) | undefined
  onSendOutbox: ((itemId: string) => MaybePromise) | undefined
  onDeleteOutbox: ((itemId: string) => MaybePromise) | undefined
  lastSyncedAt: OfflineTimestamp | undefined
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

export function OfflineWorkspaceTools({
  offlinePaneRef,
  mobilePane,
  t,
  drafts,
  effectiveSelectedId,
  online,
  selectableTargets,
  selectSnapshot,
  selectedDraft,
  onDraftChange,
  draftMaxChars,
  locale,
  busyAction,
  addToOutboxUnavailable,
  outboxFull,
  selectedSnapshot,
  runAction,
  onAddToOutbox,
  outbox,
  maxOutboxItems,
  retentionDays,
  onReviewOutbox,
  onSendOutbox,
  onDeleteOutbox,
  lastSyncedAt,
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
}: OfflineWorkspaceToolsProps) {
  return (
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
  )
}
