import * as React from 'react'
import { ChevronDown, Clock, Flag, MessageSquare, Pencil, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { cn } from '@/lib/utils'
import { shortTimeLocale } from '@/utils/session'
import { kanbanLivePulseAtom } from '@/atoms/kanban'
import { useKanbanColumnColors } from '@/hooks/useKanbanColumnColors'
import type { ProjectColorTreatment } from '@/utils/project-colors'
import type { SessionStatus } from '@/config/session-status-config'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import { SessionStatusMenu } from '@/components/ui/session-status-menu'
import { StatusBadge } from './StatusBadge'
import { SubtaskProgress } from './SubtaskProgress'
import type { KanbanModelProviderGroup, KanbanProject, KanbanTask } from './types'

interface TaskTileProps {
  task: KanbanTask
  /** Project the task is bound to (colors the tile). */
  project?: KanbanProject
  /** Resolved status for the badge. */
  status?: SessionStatus
  /** Ordered workspace statuses for the status picker. */
  statuses?: SessionStatus[]
  /** Change this task's status. When set (with `statuses`), the badge opens a picker. */
  onStatusChange?: (statusId: string) => void
  /** How the project color is drawn. Mirrors the SessionList project-color treatment. */
  treatment: ProjectColorTreatment
  /** Whether the subtask list is expanded. */
  expanded: boolean
  /** Open the task (focused chat window). */
  onClick?: () => void
  /** Open the full-pane editor for this task (edit mode). Enables the right-click "Edit task" item. */
  onEdit?: () => void
  /** Toggle the subtask list. */
  onToggleSubtasks?: () => void
  /** Open a spawned subtask's session window. */
  onSubtaskClick?: (subtaskId: string) => void
  /** Spawn a new subtask from a typed title, routed to the chosen model. */
  onAddSubtask?: (title: string, model: string) => void
  /** Run all pending (created-but-not-yet-dispatched) subtasks. Shows the Play button when set. */
  onRunSubtasks?: () => void
  /** Provider→model catalog for the "Add subtask" composer's picker. */
  subtaskModelGroups?: KanbanModelProviderGroup[]
  /** Model id pre-selected in the composer (defaults to the first catalog model). */
  defaultSubtaskModel?: string
}

/**
 * A parent-session ("Task") tile.
 *
 * Project color is drawn directly on the card: a full-height 3px leading stripe
 * plus an optional ~6% tint (same `color-mix` formula as
 * `SessionProjectColorWrapper`, applied on the card because a tile is an opaque
 * surface rather than a transparent list row).
 */
export function TaskTile({
  task,
  project,
  status,
  statuses,
  onStatusChange,
  treatment,
  onClick,
  onEdit,
  onRunSubtasks,
}: TaskTileProps) {
  const { t } = useTranslation()
  const livePulseEnabled = useAtomValue(kanbanLivePulseAtom)
  const columnColors = useKanbanColumnColors()
  const accent = columnColors.get(task.column)?.solid ?? 'var(--primary)'

  const color = project?.color ?? null
  const showStripe = !!color
  const showTint = !!color && treatment === 'stripe-tint'
  const subtaskCount = task.subtasks.length
  // Play runs a spec-backed task's whole DAG (pending rows count even without a session —
  // the Conductor creates them), but only dispatches session-backed rows on plain tiles.
  // Disabled while anything is in flight: a second Conductor run would be refused anyway.
  const hasRunningSubtasks = task.subtasks.some(s => s.runState === 'running')
  const canRunSubtasks =
    !hasRunningSubtasks &&
    !task.isProcessing &&
    task.subtasks.some(s => s.runState === 'pending' && (task.taskSlug ? true : !!s.sessionId))

  // Live treatment: an in-flight turn on a tile parked in the active column,
  // gated by the user's live-pulse preference.
  const isLive = livePulseEnabled && !!task.isProcessing && task.column === 'in-progress'

  const relativeTime = task.lastMessageAt
    ? formatDistanceToNowStrict(new Date(task.lastMessageAt), {
        locale: shortTimeLocale as Locale,
        roundingMethod: 'floor',
      })
    : null
  const hasMessages = typeof task.messageCount === 'number' && task.messageCount > 0

  const card = (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.()
        }
      }}
      className={cn(
        'group relative overflow-hidden rounded-lg border border-border/60 bg-card',
        isLive ? 'shadow-tinted ring-1 ring-accent/40' : 'shadow-minimal',
        'cursor-pointer transition-colors hover:border-border focus-visible:outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
    >
      {showTint && color && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 6%, transparent)` }}
          aria-hidden
        />
      )}
      {showStripe && color && (
        <div
          className="absolute left-0 top-0 bottom-0 w-[3px] pointer-events-none"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}

      {onEdit && (
        <button
          type="button"
          data-no-dnd="true"
          onClick={e => {
            e.stopPropagation()
            onEdit()
          }}
          onKeyDown={e => e.stopPropagation()}
          title={t('kanban.editTask')}
          aria-label={t('kanban.editTask')}
          className="absolute right-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-md border border-border/60 bg-card text-foreground/50 opacity-0 shadow-minimal transition-opacity hover:bg-foreground/[0.05] hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      )}

      <div className="relative p-3 pl-3.5">
        {(project || task.isFlagged) && (
          // Right padding keeps the flag clear of the hover-revealed corner pencil.
          <div className={cn('mb-1.5 flex items-center justify-between gap-2', onEdit && task.isFlagged && 'pr-7')}>
            {project ? (
              <span className="inline-flex min-w-0 items-center gap-1 text-[11px] font-medium text-foreground/55">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: project.color }}
                  aria-hidden
                />
                <span className="truncate">{project.name}</span>
              </span>
            ) : (
              <span />
            )}
            {task.isFlagged && (
              <Flag className="h-3.5 w-3.5 shrink-0 fill-amber-500 text-amber-500" aria-hidden />
            )}
          </div>
        )}

        <div
          className={cn(
            'text-sm font-medium leading-snug line-clamp-2',
            // Strike done/cancelled by *status* (not column — placement ≠ status).
            status?.category === 'closed' ? 'text-foreground/55 line-through' : 'text-foreground'
          )}
        >
          {task.title}
        </div>

        <div className="mt-2">
          {status &&
            (onStatusChange && statuses && statuses.length > 0 ? (
              <StatusPicker
                status={status}
                statuses={statuses}
                activeStateId={task.statusId}
                live={isLive}
                onSelect={onStatusChange}
              />
            ) : (
              <StatusBadge status={status} live={isLive} />
            ))}
        </div>

        {subtaskCount > 0 && (
          <div className="mt-2.5 border-t border-border/40 pt-2">
            <div className="flex items-center gap-1.5">
              <SubtaskProgress subtasks={task.subtasks} total={task.subtaskTotal} accent={accent} className="min-w-0 flex-1" />
              {onRunSubtasks && (
                <button
                  type="button"
                  data-no-dnd="true"
                  onClick={e => {
                    e.stopPropagation()
                    onRunSubtasks()
                  }}
                  disabled={!canRunSubtasks}
                  title={t('kanban.runSubtasks')}
                  aria-label={t('kanban.runSubtasks')}
                  // No `disabled:pointer-events-none`: it would let clicks pass THROUGH the
                  // disabled button to the card underneath (which opens the session list).
                  // A disabled button that keeps pointer events swallows the click instead.
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground/80 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-foreground/50"
                >
                  <Play className="h-3 w-3" strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        )}

        {(relativeTime || hasMessages) && (
          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/40 pt-2">
            <div className="flex shrink-0 items-center gap-2 text-[11px] text-foreground/45">
              {relativeTime && (
                <span className="inline-flex items-center gap-0.5 tabular-nums">
                  <Clock className="h-3 w-3" strokeWidth={2} />
                  {relativeTime}
                </span>
              )}
              {hasMessages && (
                <span className="inline-flex items-center gap-0.5 tabular-nums">
                  <MessageSquare className="h-3 w-3" strokeWidth={2} />
                  {task.messageCount}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )

  if (!onEdit) return card

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <StyledContextMenuContent>
        <StyledContextMenuItem onSelect={onEdit}>
          <Pencil className="h-4 w-4" />
          {t('kanban.editTask')}
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

/**
 * Status badge that opens the shared `SessionStatusMenu` in a popover. Stops
 * pointer/keyboard propagation so opening the picker never starts a drag or
 * triggers the tile's open-window handler; closes itself on select.
 */
function StatusPicker({
  status,
  statuses,
  activeStateId,
  live,
  onSelect,
}: {
  status: SessionStatus
  statuses: SessionStatus[]
  activeStateId: string
  live: boolean
  onSelect: (statusId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-no-dnd="true"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
          aria-label={t('kanban.changeStatus')}
          className="rounded-full transition-shadow hover:ring-2 hover:ring-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:ring-2 data-[state=open]:ring-foreground/20"
        >
          <StatusBadge status={status} live={live} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-auto border-0 bg-transparent p-0 shadow-none"
        data-no-dnd="true"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <SessionStatusMenu
          states={statuses}
          activeState={activeStateId}
          onSelect={statusId => {
            onSelect(statusId)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
