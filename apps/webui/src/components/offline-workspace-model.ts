

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

export type MaybePromise = void | Promise<void>

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

export type MobilePane = 'sessions' | 'reader' | 'offline'

export const MAX_VISIBLE_SNAPSHOTS = 10

export function timestampValue(value: OfflineTimestamp | undefined): number | null {
  if (value === undefined) return null
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function formatTimestamp(value: OfflineTimestamp | undefined, locale: string): string {
  const timestamp = timestampValue(value)
  if (timestamp === null) return '—'
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

export function isoTimestamp(value: OfflineTimestamp | undefined): string | undefined {
  const timestamp = timestampValue(value)
  return timestamp === null ? undefined : new Date(timestamp).toISOString()
}

export function formatBytes(bytes: number | undefined, locale: string): string | null {
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

export function normalizeSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
}

export function messageRoleLabel(
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

export function outboxTone(status: OfflineOutboxStatus): string {
  if (status === 'uncertain') return 'border-amber-500/35 bg-amber-500/10'
  if (status === 'ready') return 'border-emerald-500/25 bg-emerald-500/8'
  return 'border-border bg-card'
}
