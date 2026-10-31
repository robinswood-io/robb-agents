import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from "react";
import { LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProjectColorTreatment } from "@/utils/project-colors";
import { KanbanBoard } from "@/components/app-shell/kanban/KanbanBoard";
import { TaskTile } from "@/components/app-shell/kanban/TaskTile";
import { TaskChatPreview } from "@/components/app-shell/kanban/TaskChatPreview";
import { StatusBadge } from "@/components/app-shell/kanban/StatusBadge";
import { ModelChip } from "@/components/app-shell/kanban/ModelChip";
import { KANBAN_COLUMNS, statusToColumn } from "@/components/app-shell/kanban/status-column";
import type { KanbanColumnId, KanbanSubtask, KanbanTask } from "@/components/app-shell/kanban/types";
import { mockTasks, mockProjectsById, mockStatuses, mockStatusesById, DEFAULT_EXPANDED_TASK_IDS, ANATOMY_SUBTASKS, mockTaskWindow } from "../../demos/kanban/mock-kanban-data";
import type { KanbanView } from "./fixtures";
import { makeSubtask, DEFAULT_SUBTASK_MODEL, SUBTASK_MODEL_GROUPS } from "./fixtures";
import type { OpenTarget, TaskWindowProps } from "./windows";
import { buildTaskWindowProps, buildSubtaskWindowProps, TaskWindowOverlay } from "./windows";

function ViewToggle({ value, onChange }: { value: KanbanView; onChange: (v: KanbanView) => void }) {
  const Btn = ({ view, icon: Icon, label }: { view: KanbanView; icon: typeof List; label: string }) => {
    const active = value === view
    return (
      <button
        type="button"
        onClick={() => onChange(view)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
          active ? 'bg-card text-foreground shadow-sm' : 'text-foreground/50 hover:text-foreground/80'
        )}
        aria-pressed={active}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        {label}
      </button>
    )
  }
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-foreground/[0.02] p-0.5">
      <Btn view="list" icon={List} label="List" />
      <Btn view="board" icon={LayoutGrid} label="Board" />
    </div>
  )
}

function StubSessionList() {
  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="mx-auto max-w-md divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-card">
        {mockTasks.map(task => {
          const project = task.projectId ? mockProjectsById.get(task.projectId) : undefined
          const status = mockStatusesById.get(task.statusId)
          return (
            <div key={task.id} className="flex items-center gap-2 px-3 py-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: project?.color ?? 'var(--muted-foreground)' }}
                aria-hidden
              />
              <span className="flex-1 truncate text-sm text-foreground">{task.title}</span>
              {status && <StatusBadge status={status} />}
              <ModelChip model={task.model} />
            </div>
          )
        })}
      </div>
      <p className="mx-auto mt-3 max-w-md text-center text-xs text-foreground/40">
        List view is a stub here — the Board toggle is the focus of this preview.
      </p>
    </div>
  )
}

// ============================================================================
// Entry 1 — full Kanban view (All-Sessions header + toggle + board)
// ============================================================================

export function KanbanViewPreview({
  view = 'board',
  treatment = 'stripe-tint',
}: {
  view?: KanbanView | undefined
  treatment?: ProjectColorTreatment | undefined
}) {
  const [activeView, setActiveView] = React.useState<KanbanView>(view)
  React.useEffect(() => setActiveView(view), [view])

  // Clone the module-level mock so the demo can mutate (add subtasks) without
  // leaking edits across previews.
  const [tasks, setTasks] = React.useState<KanbanTask[]>(() =>
    mockTasks.map(t => ({ ...t, subtasks: [...t.subtasks] }))
  )
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(DEFAULT_EXPANDED_TASK_IDS))
  const [openTarget, setOpenTarget] = React.useState<OpenTarget | null>(null)

  const toggleSubtasks = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const addSubtask = (taskId: string, title: string, model: string) => {
    setTasks(prev =>
      prev.map(t =>
        t.id === taskId ? { ...t, subtasks: [...t.subtasks, makeSubtask(title, taskId, model)] } : t
      )
    )
    setExpanded(prev => new Set(prev).add(taskId))
  }

  // Dispatch a tile's pending subtasks: flip them to running (the "Play" path).
  const runSubtasks = (taskId: string) => {
    setTasks(prev =>
      prev.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.runState === 'pending' ? { ...s, runState: 'running' } : s)) }
          : t
      )
    )
  }

  // Create a named task tile in the ToDo column (the inline "New Task" composer path).
  const createTask = (title: string) => {
    setTasks(prev => [
      ...prev,
      { id: `task-new-${Date.now()}`, title, column: 'todo', statusId: 'todo', model: DEFAULT_SUBTASK_MODEL, subtasks: [] },
    ])
  }

  const changeStatus = (taskId: string, statusId: string) => {
    setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, statusId } : t)))
  }

  // Demo of the per-column "status on move" mapping the live board reads from
  // settings: dropping into a column also folds the status to that column.
  const COLUMN_STATUS: Record<KanbanColumnId, string> = {
    todo: 'todo',
    'in-progress': 'in-progress',
    done: 'done',
  }
  const moveTask = (taskId: string, toColumn: KanbanColumnId) => {
    setTasks(prev =>
      prev.map(t => (t.id === taskId ? omitUndefined<KanbanTask>({ ...t, column: toColumn, statusId: COLUMN_STATUS[toColumn] ?? t.statusId }) : t))
    )
  }

  // Derive overlay props from the *current* tasks so a freshly added subtask
  // shows up live in an already-open parent window.
  const windowProps = React.useMemo<TaskWindowProps | null>(() => {
    if (!openTarget) return null
    const task = tasks.find(t => t.id === openTarget.taskId)
    if (!task) return null
    if (openTarget.kind === 'task') return buildTaskWindowProps(task)
    const sub = task.subtasks.find(s => s.id === openTarget.subtaskId)
    return sub ? buildSubtaskWindowProps(sub, task) : null
  }, [openTarget, tasks])

  return (
    <div className="relative flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
        <span className="text-sm font-medium">All Tasks</span>
        <ViewToggle value={activeView} onChange={setActiveView} />
      </div>
      {activeView === 'board' ? (
        <div className="min-h-0 flex-1">
          <KanbanBoard
            columns={KANBAN_COLUMNS}
            tasks={tasks}
            projectsById={mockProjectsById}
            statusesById={mockStatusesById}
            statuses={mockStatuses}
            onChangeStatus={changeStatus}
            treatment={treatment}
            expandedTaskIds={expanded}
            onTaskClick={taskId => setOpenTarget({ kind: 'task', taskId })}
            onToggleSubtasks={toggleSubtasks}
            onSubtaskClick={(taskId, subtaskId) => setOpenTarget({ kind: 'subtask', taskId, subtaskId })}
            onAddSubtask={addSubtask}
            onRunSubtasks={runSubtasks}
            subtaskModelGroups={SUBTASK_MODEL_GROUPS}
            defaultSubtaskModel={DEFAULT_SUBTASK_MODEL}
            onCreateTask={createTask}
            onMoveTask={moveTask}
          />
        </div>
      ) : (
        <StubSessionList />
      )}

      {windowProps && <TaskWindowOverlay windowProps={windowProps} onClose={() => setOpenTarget(null)} />}
    </div>
  )
}

// ============================================================================
// Entry 2 — single tile (anatomy)
// ============================================================================

export function TaskTilePreview({
  subtasksExpanded = true,
  statusId = 'in-progress',
  treatment = 'stripe-tint',
  model = 'claude-opus-4-7',
}: {
  subtasksExpanded?: boolean | undefined
  statusId?: string | undefined
  treatment?: ProjectColorTreatment | undefined
  model?: string | undefined
}) {
  const [expanded, setExpanded] = React.useState(subtasksExpanded)
  React.useEffect(() => setExpanded(subtasksExpanded), [subtasksExpanded])

  const [subtasks, setSubtasks] = React.useState<KanbanSubtask[]>(() => [...ANATOMY_SUBTASKS])

  const task: KanbanTask = {
    id: 'anatomy',
    title: 'Migrate auth to new session model',
    column: statusToColumn(statusId),
    statusId,
    model,
    projectId: 'p-eng',
    subtasks,
  }

  return (
    <div className="w-[340px]">
      <TaskTile
        task={task}
        project={mockProjectsById.get('p-eng')}
        status={mockStatusesById.get(statusId)}
        treatment={treatment}
        expanded={expanded}
        onClick={() => {}}
        onToggleSubtasks={() => setExpanded(v => !v)}
        onAddSubtask={(title, subtaskModel) => {
          setSubtasks(prev => [...prev, makeSubtask(title, 'anatomy', subtaskModel)])
          setExpanded(true)
        }}
        onRunSubtasks={() =>
          setSubtasks(prev => prev.map(s => (s.runState === 'pending' ? { ...s, runState: 'running' } : s)))
        }
        subtaskModelGroups={SUBTASK_MODEL_GROUPS}
        defaultSubtaskModel={DEFAULT_SUBTASK_MODEL}
      />
    </div>
  )
}

// ============================================================================
// Entry 3 — focused task window (chat-only)
// ============================================================================

export function KanbanTaskWindowPreview() {
  return <TaskChatPreview {...mockTaskWindow} />
}
