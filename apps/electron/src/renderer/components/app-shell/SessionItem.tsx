import { formatDistanceToNowStrict } from "date-fns"
import type { Locale } from "date-fns"
import { Flag, Network, ShieldAlert } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useActionLabel } from "@/actions"
import { cn } from "@/lib/utils"
import { rendererPerf } from "@/lib/perf"
import { Spinner } from "@craft-agent/ui"
import { EntityRow } from "@/components/ui/entity-row"
import { EntityListBadge } from "@/components/ui/entity-list-badge"
import { SessionMenu } from "./SessionMenu"
import { BatchSessionMenu } from "./BatchSessionMenu"
import { CompactSessionMenu } from "./CompactSessionMenu"
import { AgentLifecyclePin } from "./AgentLifecyclePin"
import { SessionBadges } from "./SessionBadges"
import { SessionProjectColorWrapper } from "./SessionProjectColorWrapper"
import { useProjectColorTreatment } from "@/hooks/useProjectColorTreatment"
import { getSessionTitle, getSessionPreviewText, highlightMatch, hasUnreadMeta, shortTimeLocale } from "@/utils/session"
import { useSessionListContext } from "@/context/SessionListContext"
import { useAppShellContext } from "@/context/AppShellContext"
import { navigate, routes } from "@/lib/navigate"
import type { SessionMeta } from "@/atoms/sessions"
import { messagingBindingsBySessionAtom } from "@/atoms/messaging"
import { useAtomValue } from "jotai"
import { extractLabelId } from "@craft-agent/shared/labels"
import type { SessionSubagentSummary } from "@/utils/session-subagent-summary"

const PLATFORM_PILL: Record<'telegram' | 'whatsapp', { label: string; colorClass: string }> = {
  telegram: {
    label: 'Telegram',
    colorClass: 'bg-sky-500/10 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300',
  },
  whatsapp: {
    label: 'WhatsApp',
    colorClass: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300',
  },
}

export interface SessionItemProps {
  item: SessionMeta
  index: number
  itemProps: Record<string, unknown>
  isSelected: boolean
  isFirstInGroup: boolean
  isInMultiSelect: boolean
  /** Aggregated descendants hidden from direct sidebar navigation. */
  subagentSummary?: SessionSubagentSummary
  onSelect: () => void
  onToggleSelect?: () => void
  onRangeSelect?: () => void
}

export function SessionItem({
  item,
  itemProps,
  isSelected,
  isFirstInGroup,
  isInMultiSelect,
  subagentSummary,
  onSelect,
  onToggleSelect,
  onRangeSelect,
}: SessionItemProps) {
  const { t } = useTranslation()
  const ctx = useSessionListContext()
  const { workspaces, isCompactMode } = useAppShellContext()
  const hasRemoteWorkspaces = workspaces?.some(w => w.remoteServer) ?? false
  const isConversationProcessing = item.isProcessing || (subagentSummary?.runningCount ?? 0) > 0
  const { hotkey: nextHotkey } = useActionLabel('chat.nextSearchMatch')
  const { hotkey: prevHotkey } = useActionLabel('chat.prevSearchMatch')
  const title = getSessionTitle(item)
  // For the active session, prefer logical match count over ripgrep count
  const activeMatch = ctx.activeChatMatchInfo
  const isActiveSession = isSelected && activeMatch?.sessionId === item.id
  const ripgrepMatchCount = ctx.contentSearchResults.get(item.id)?.matchCount
  const chatMatchCount = isActiveSession ? activeMatch!.count : ripgrepMatchCount
  const hasMatch = chatMatchCount != null && chatMatchCount > 0
  const hasLabels = !!(item.labels && item.labels.length > 0 && ctx.flatLabels.length > 0 && item.labels.some(entry => {
    const labelId = extractLabelId(entry)
    return ctx.flatLabels.some(l => l.id === labelId)
  }))
  const hasPendingPrompt = ctx.hasPendingPrompt?.(item.id) ?? false
  const previewText = isCompactMode ? getSessionPreviewText(item) : null
  const messagingBindingsBySession = useAtomValue(messagingBindingsBySessionAtom)
  const sessionBindings = messagingBindingsBySession.get(item.id) ?? []
  const hasMessagingBinding = sessionBindings.length > 0
  const subagentLabel = subagentSummary
    ? subagentSummary.runningCount > 0
      ? t('session.subagentsRunning', {
          running: subagentSummary.runningCount,
          count: subagentSummary.totalCount,
        })
      : t('session.subagentsSummary', { count: subagentSummary.totalCount })
    : undefined

  // Resolve the bound project so the row can show a project-themed stripe /
  // tint and reveal the project name on hover. Treatment is a user preference
  // under Appearance.
  const projectColorTreatment = useProjectColorTreatment()
  const boundProject = item.projectId
    ? ctx.projects?.find(p => p.id === item.projectId)
    : undefined
  const projectColor = boundProject?.color
  const projectName = boundProject?.name

  const handleClick = (e: React.MouseEvent) => {
    ctx.onFocusZone()
    if (e.button === 2) {
      if (ctx.isMultiSelectActive && !isInMultiSelect && onToggleSelect) onToggleSelect()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      // Cmd+Shift+Click: open session in a new panel
      e.preventDefault()
      navigate(routes.view.allSessions(item.id), { newPanel: true })
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      // Cmd+Click: always toggle multi-select (standard OS behavior)
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (e.shiftKey && onRangeSelect) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    rendererPerf.startSessionSwitch(item.id)
    onSelect()
  }

  return (
    <SessionProjectColorWrapper color={projectColor} treatment={projectColorTreatment}>
    <EntityRow
      className="session-item relative"
      dataAttributes={{
        'data-session-id': item.id,
      }}
      showSeparator={!isFirstInGroup}
      separatorClassName="pr-4 pl-[38px]"
      isSelected={isSelected}
      isInMultiSelect={isInMultiSelect}
      // When a project stripe is drawn at the leading edge, suppress EntityRow's
      // own blue selection bar so they don't stack. The row's background tint
      // continues to convey "selected".
      suppressSelectionBar={!!projectColor}
      onMouseDown={handleClick}
      menuContent={
        <SessionMenu
          item={item}
          sessionStatuses={ctx.sessionStatuses}
          labels={ctx.labels}
          onLabelsChange={ctx.onLabelsChange ? (ls) => ctx.onLabelsChange!(item.id, ls) : undefined}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onFlag={() => ctx.onFlag?.(item.id)}
          onUnflag={() => ctx.onUnflag?.(item.id)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          hasRemoteWorkspaces={hasRemoteWorkspaces}
          onDelete={() => ctx.onDelete(item.id)}
          projects={ctx.projects}
          onSetProjectId={ctx.onSetProjectId ? (pid) => ctx.onSetProjectId!(item.id, pid) : undefined}
        />
      }
      contextMenuContent={ctx.isMultiSelectActive && isInMultiSelect ? <BatchSessionMenu /> : undefined}
      isCompactMode={isCompactMode}
      buttonProps={{
        ...itemProps,
        className: (itemProps as Record<string, unknown>)?.className as string | undefined,
        onKeyDown: (e: React.KeyboardEvent) => {
          ;(itemProps as { onKeyDown: (event: React.KeyboardEvent) => void }).onKeyDown(e)
          ctx.onKeyDown(e, item)
        },
      }}
      compactMenu={({ open, onOpenChange }) => (
        <CompactSessionMenu
          open={open}
          onOpenChange={onOpenChange}
          trigger={null}
          title={title}
          item={item}
          sessionStatuses={ctx.sessionStatuses}
          labels={ctx.labels}
          hasRemoteWorkspaces={hasRemoteWorkspaces}
          onLabelsChange={ctx.onLabelsChange ? (ls) => ctx.onLabelsChange!(item.id, ls) : undefined}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onFlag={() => ctx.onFlag?.(item.id)}
          onUnflag={() => ctx.onUnflag?.(item.id)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          onDelete={() => ctx.onDelete(item.id)}
        />
      )}
      icon={
        <div className="relative w-5 h-5 flex items-center justify-center shrink-0">
          <AgentLifecyclePin
            item={item}
            subagentSummary={subagentSummary}
            hasPendingPrompt={hasPendingPrompt}
          />

          {/* Minimalist unread dot indicator — positioned at top-right corner */}
          {hasUnreadMeta(item) && (
            <span
              className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent ring-2 ring-background pointer-events-none"
              title={t("session.unread", "Unread")}
            />
          )}
        </div>
      }
      title={ctx.searchQuery ? highlightMatch(title, ctx.searchQuery) : title}
      titleClassName={cn(isCompactMode ? "text-[14px] font-semibold" : "text-[13px]", item.isAsyncOperationOngoing && "animate-shimmer-text")}
      subtitle={previewText}
      titleSuffix={
        (projectName || hasMessagingBinding) ? (
          <div className="flex items-center gap-1">
            {projectName && (
              <span
                className="text-[11px] text-foreground/40 whitespace-nowrap truncate max-w-[120px] opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                style={projectColor ? { color: projectColor } : undefined}
                title={projectName}
              >
                {projectName}
              </span>
            )}
            {hasMessagingBinding && sessionBindings.map((binding) => {
              const pill = PLATFORM_PILL[binding.platform as 'telegram' | 'whatsapp']
              if (!pill) return null
              return (
                <EntityListBadge
                  key={binding.id}
                  variant="text"
                  colorClass={pill.colorClass}
                  tooltip={`Connected to ${pill.label}`}
                >
                  {pill.label}
                </EntityListBadge>
              )
            })}
          </div>
        ) : undefined
      }
      titleTrailing={hasMatch ? (
        <span
          className={cn(
            "inline-flex items-center justify-center min-w-[24px] px-1 py-0.5 rounded-[6px] text-[10px] font-medium tabular-nums leading-tight whitespace-nowrap shadow-tinted",
            isSelected
              ? "bg-yellow-300/50 border border-yellow-500 text-yellow-900"
              : "bg-yellow-300/10 border border-yellow-600/20 text-yellow-800"
          )}
          style={{
            '--shadow-color': isSelected ? '234, 179, 8' : '133, 77, 14',
          } as React.CSSProperties}
          title={`Matches found (${nextHotkey} next, ${prevHotkey} prev)`}
        >
          {chatMatchCount}
        </span>
      ) : item.isFlagged ? (
        <div className="p-1 flex items-center justify-center">
          <Flag className="h-3.5 w-3.5 text-info" />
        </div>
      ) : item.lastMessageAt ? (
        <span className="text-[11px] text-foreground/40 whitespace-nowrap">
          {formatDistanceToNowStrict(new Date(item.lastMessageAt), { locale: shortTimeLocale as Locale, roundingMethod: 'floor' })}
        </span>
      ) : undefined}
      badges={(hasLabels || subagentLabel) ? (
        <>
          {subagentLabel && (
            <EntityListBadge
              colorClass={subagentSummary!.runningCount > 0
                ? 'bg-accent/10 text-accent'
                : 'bg-foreground/[0.05] text-foreground/60'}
              tooltip={subagentLabel}
            >
              <Network className="mr-1 h-3 w-3" aria-hidden="true" />
              {subagentLabel}
            </EntityListBadge>
          )}
          {hasLabels && <SessionBadges item={item} />}
        </>
      ) : undefined}
    />
    </SessionProjectColorWrapper>
  )
}
