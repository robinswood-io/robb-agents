import * as React from "react";
import { X } from "lucide-react";
import { getModelShortName } from "@config/models";
import { TaskChatPreview } from "@/components/app-shell/kanban/TaskChatPreview";
import type { KanbanSubtask, KanbanTask, SubtaskRunState } from "@/components/app-shell/kanban/types";
import { mockProjectsById, mockStatusesById } from "../../demos/kanban/mock-kanban-data";
import { SUBTASK_STATUS_BY_RUN_STATE } from "./fixtures";

// ============================================================================
// Simulated "separate window" — opening a task or subtask session
// ============================================================================

export type TaskWindowProps = React.ComponentProps<typeof TaskChatPreview>

export type OpenTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'subtask'; taskId: string; subtaskId: string }

/** Chat-window props for a parent task opened from its tile. */
export function buildTaskWindowProps(task: KanbanTask): TaskWindowProps {
  const project = task.projectId ? mockProjectsById.get(task.projectId) : undefined
  const hasSubtasks = task.subtasks.length > 0
  return {
    title: task.title,
    project,
    status: mockStatusesById.get(task.statusId),
    model: task.model,
    userMessage: `Coordinate "${task.title}" and route each part to the best-fit model.`,
    assistantIntro: hasSubtasks
      ? "I'm acting as the orchestrator — here are the subtasks I've spawned, each routed to a best-fit model:"
      : "I'm acting as the orchestrator. No subtasks have been spawned yet — add one from the tile to send it down to run.",
    subtasks: task.subtasks,
    assistantFollowUp: hasSubtasks
      ? "I'll update each subtask here as the spawned sessions report back."
      : undefined,
  }
}

/** Chat-window props for a single spawned subtask opened from its row. */
export function buildSubtaskWindowProps(sub: KanbanSubtask, parent: KanbanTask): TaskWindowProps {
  const project = parent.projectId ? mockProjectsById.get(parent.projectId) : undefined
  const followUp: Record<SubtaskRunState, string> = {
    done: 'This subtask has completed and reported back to the parent task.',
    running: 'This subtask is running now; results will report back to the parent task.',
    pending: 'This subtask is queued and will start once upstream work is ready.',
    failed: 'This subtask failed; the parent task can retry or rerun it.',
  }

  return {
    title: sub.title,
    project,
    status: mockStatusesById.get(SUBTASK_STATUS_BY_RUN_STATE[sub.runState]),
    model: sub.model,
    userMessage: sub.title,
    assistantIntro: `Spawned from "${parent.title}" and routed to ${getModelShortName(sub.model)} as the best fit for this subtask.`,
    subtasks: [],
    assistantFollowUp: followUp[sub.runState],
  }
}

/**
 * Stand-in for opening a session in its own OS window. The playground can't spawn
 * real windows, so this overlays the same `TaskChatPreview` body inside a faux
 * window chrome (with a close button + Escape-to-close).
 */
export function TaskWindowOverlay({ windowProps, onClose }: { windowProps: TaskWindowProps; onClose: () => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center">
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        className="relative z-10 flex h-[88%] w-[90%] max-w-2xl flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/40 bg-foreground/[0.02] px-3 py-1.5">
          <span className="text-[11px] font-medium text-foreground/40">Session window</span>
          <button
            type="button"
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground/80"
            aria-label="Close window"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <TaskChatPreview {...windowProps} />
        </div>
      </div>
    </div>
  )
}
