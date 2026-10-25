import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { Archive, ArchiveRestore, AppWindow, Check, ChevronRight, CloudUpload, Columns2, Copy, Flag, FlagOff, FolderOpen, Globe, Link2Off, MailOpen, MessageSquare, Pencil, RefreshCw, Send, Tag, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

import { LabelIcon } from '@/components/ui/label-icon';
import { type LabelMenuItem } from '@/components/ui/label-menu-utils';
import type { LabelConfig } from '@craft-agent/shared/labels';
import { resolveLabelDisplayName, type SessionStatus, type SessionStatusId } from '@/config/session-status-config';
import type { SessionMeta } from '@/atoms/sessions';

import { getFileManagerName } from '@/lib/platform';
import { type MessagingPlatform } from '@/components/messaging/MessagingSessionMenuItem';



export type View = 'root' | 'labels' | 'share' | 'messaging'


export interface CompactSessionMenuProps {
  /** Title text shown in the trigger button + drawer header. */
  title?: string
  /** Optional badge element rendered next to the title (e.g. agent badge). */
  badge?: React.ReactNode
  /** Shimmer animation while the title is being regenerated. */
  isRegeneratingTitle?: boolean

  // Session data — same as SessionMenu
  item: SessionMeta
  sessionStatuses?: SessionStatus[]
  labels?: LabelConfig[]
  hasRemoteWorkspaces?: boolean

  // Callbacks — same as SessionMenu
  onLabelsChange?: (labels: string[]) => void
  onRename: () => void
  onFlag: () => void
  onUnflag: () => void
  onArchive: () => void
  onUnarchive: () => void
  onMarkUnread: () => void
  onSessionStatusChange?: (state: SessionStatusId) => void
  onOpenInNewWindow: () => void
  onSendToWorkspace?: () => void
  onDelete: () => void

  // ---------------------------------------------------------------------------
  // Controlled-component shim — used by EntityRow / SessionItem so a single
  // drawer instance can be driven from multiple triggers (`…` button + long-
  // press). When `open` is omitted the component owns its own state (the
  // chat-header callsite, unchanged). Matches the Radix Dialog convention.
  // ---------------------------------------------------------------------------
  /** Controlled open state. When omitted, the component owns its own state. */
  open?: boolean
  /** Notifies the consumer when the controlled open state should change. */
  onOpenChange?: (open: boolean) => void
  /** Custom trigger node. `null` opts out of rendering ANY trigger (the row
   *  provides its own). When omitted, renders the title-pill trigger used
   *  by the chat header. */
  trigger?: React.ReactNode | null
}


// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

export interface RootPaneProps {
  sharedUrl?: string
  labelsCount: number
  hasLabels: boolean
  isFlagged: boolean
  isArchived: boolean
  hasMessages: boolean
  hasUnread: boolean
  hasRemoteWorkspaces?: boolean
  onShare?: () => void
  onOpenShareSub: () => void
  onSendToWorkspace?: () => void
  onOpenMessagingSub: () => void
  onOpenLabelsSub: () => void
  onFlag?: () => void
  onUnflag?: () => void
  onArchive?: () => void
  onUnarchive?: () => void
  onMarkUnread?: () => void
  onRename?: () => void
  onRefreshTitle?: () => void
  onOpenInNewPanel?: () => void
  onOpenInNewWindow?: () => void
  onShowInFinder?: () => void
  onCopyPath?: () => void
  onDelete?: () => void
}


export function RootPane({
  sharedUrl,
  labelsCount,
  hasLabels,
  isFlagged,
  isArchived,
  hasMessages,
  hasUnread,
  hasRemoteWorkspaces,
  onShare,
  onOpenShareSub,
  onSendToWorkspace,
  onOpenMessagingSub,
  onOpenLabelsSub,
  onFlag,
  onUnflag,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onRename,
  onRefreshTitle,
  onOpenInNewPanel,
  onOpenInNewWindow,
  onShowInFinder,
  onCopyPath,
  onDelete,
}: RootPaneProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col">
      {/* Share / Shared */}
      {!sharedUrl ? (
        <Row icon={<CloudUpload className="h-4 w-4" />} label={t('sessionMenu.share')} onTap={onShare} />
      ) : (
        <Row
          icon={<CloudUpload className="h-4 w-4" />}
          label={t('sessionMenu.shared')}
          chevron
          onTap={onOpenShareSub}
        />
      )}

      {hasRemoteWorkspaces && onSendToWorkspace && (
        <Row icon={<Send className="h-4 w-4" />} label={t('sessionMenu.sendToWorkspace')} onTap={onSendToWorkspace} />
      )}

      <Row
        icon={<MessageSquare className="h-4 w-4" />}
        label={t('sessionMenu.connectMessaging')}
        chevron
        onTap={onOpenMessagingSub}
      />

      <Separator />

      {hasLabels && (
        <Row
          icon={<Tag className="h-4 w-4" />}
          label={t('sessionMenu.labels')}
          trailing={labelsCount > 0 ? <CountBadge count={labelsCount} /> : undefined}
          chevron
          onTap={onOpenLabelsSub}
        />
      )}

      {!isFlagged ? (
        <Row icon={<Flag className="h-4 w-4 text-info" />} label={t('sessionMenu.flag')} onTap={onFlag} />
      ) : (
        <Row icon={<FlagOff className="h-4 w-4" />} label={t('sessionMenu.unflag')} onTap={onUnflag} />
      )}

      {!isArchived ? (
        <Row icon={<Archive className="h-4 w-4" />} label={t('sessionMenu.archive')} onTap={onArchive} />
      ) : (
        <Row icon={<ArchiveRestore className="h-4 w-4" />} label={t('sessionMenu.unarchive')} onTap={onUnarchive} />
      )}

      {!hasUnread && hasMessages && (
        <Row icon={<MailOpen className="h-4 w-4" />} label={t('sessionMenu.markAsUnread')} onTap={onMarkUnread} />
      )}

      <Separator />

      <Row icon={<Pencil className="h-4 w-4" />} label={t('common.rename')} onTap={onRename} />
      <Row icon={<RefreshCw className="h-4 w-4" />} label={t('sessionMenu.regenerateTitle')} onTap={onRefreshTitle} />

      <Separator />

      <Row icon={<Columns2 className="h-4 w-4" />} label={t('sessionMenu.openInNewPanel')} onTap={onOpenInNewPanel} />
      {onOpenInNewWindow && (
        <Row icon={<AppWindow className="h-4 w-4" />} label={t('sessionMenu.openInNewWindow')} onTap={onOpenInNewWindow} />
      )}
      <Row
        icon={<FolderOpen className="h-4 w-4" />}
        label={t('sessionMenu.showInFileManager', { fileManager: getFileManagerName() })}
        onTap={onShowInFinder}
      />
      <Row icon={<Copy className="h-4 w-4" />} label={t('sessionMenu.copyPath')} onTap={onCopyPath} />

      <Separator />

      <Row
        icon={<Trash2 className="h-4 w-4" />}
        label={t('common.delete')}
        destructive
        onTap={onDelete}
      />
    </div>
  )
}


export function LabelsPane({
  items,
  appliedLabelIds,
  onToggle,
}: {
  items: LabelMenuItem[]
  appliedLabelIds: Set<string>
  onToggle: (id: string) => void
}) {
  const { t } = useTranslation()

  // The Labels row in RootPane is gated on `hasLabels`, so this pane is only
  // ever entered when items.length > 0 — no empty-state branch needed.
  return (
    <div className="flex flex-col">
      {items.map((item) => {
        const isApplied = appliedLabelIds.has(item.id)
        return (
          <Row
            key={item.id}
            icon={<LabelIcon label={item.config} size="lg" />}
            label={item.parentPath ? (
              <>
                <span className="text-foreground/50">{item.parentPath}</span>
                {resolveLabelDisplayName(item.config, t)}
              </>
            ) : resolveLabelDisplayName(item.config, t)}
            radioSelected={isApplied}
            onTap={() => onToggle(item.id)}
          />
        )
      })}
    </div>
  )
}


export function SharePane({
  onOpenInBrowser,
  onCopyLink,
  onUpdateShare,
  onRevokeShare,
}: {
  onOpenInBrowser: () => void
  onCopyLink: () => void
  onUpdateShare: () => void
  onRevokeShare: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col">
      <Row icon={<Globe className="h-4 w-4" />} label={t('sessionMenu.openInBrowser')} onTap={onOpenInBrowser} />
      <Row icon={<Copy className="h-4 w-4" />} label={t('sessionMenu.copyLink')} onTap={onCopyLink} />
      <Row icon={<RefreshCw className="h-4 w-4" />} label={t('sessionMenu.updateShare')} onTap={onUpdateShare} />
      <Separator />
      <Row icon={<Link2Off className="h-4 w-4" />} label={t('sessionMenu.stopSharing')} destructive onTap={onRevokeShare} />
    </div>
  )
}


export function MessagingPane({ onConnect }: { onConnect: (platform: MessagingPlatform) => void }) {
  return (
    <div className="flex flex-col">
      <Row icon={<MessageSquare className="h-4 w-4" />} label="Telegram" onTap={() => onConnect('telegram')} />
      <Row icon={<MessageSquare className="h-4 w-4" />} label="WhatsApp" onTap={() => onConnect('whatsapp')} />
      <Row icon={<MessageSquare className="h-4 w-4" />} label="Lark / Feishu" onTap={() => onConnect('lark')} />
    </div>
  )
}


// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface RowProps {
  icon: React.ReactNode
  label: React.ReactNode
  trailing?: React.ReactNode
  chevron?: boolean
  radioSelected?: boolean
  destructive?: boolean
  onTap?: () => void
}


export function Row({
  icon,
  label,
  trailing,
  chevron,
  radioSelected,
  destructive,
  onTap,
}: RowProps) {
  if (!onTap) return null
  return (
    <button
      type="button"
      onClick={onTap}
      className={cn(
        'flex items-center gap-3 w-full px-3 py-3 rounded-[10px] text-left transition-colors',
        'hover:bg-foreground/5 active:bg-foreground/10',
        destructive && 'text-destructive hover:bg-destructive/10 active:bg-destructive/15',
      )}
    >
      <span className="shrink-0 inline-flex items-center justify-center h-5 w-5">
        {icon}
      </span>
      <span className="flex-1 min-w-0 text-sm truncate">{label}</span>
      {trailing}
      {radioSelected && <Check className="h-4 w-4 shrink-0 text-foreground/70" />}
      {chevron && <ChevronRight className="h-4 w-4 shrink-0 text-foreground/50" />}
    </button>
  )
}


export function Separator() {
  return <div className="my-1 mx-3 h-px bg-foreground/[0.06]" />
}


export function CountBadge({ count }: { count: number }) {
  return (
    <span className="text-[11px] tabular-nums text-foreground/50">
      {count}
    </span>
  )
}
