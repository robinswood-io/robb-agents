import { omitUndefined, type SnapshotInput } from '@craft-agent/shared/utils/json';

import { Plus } from 'lucide-react';

import { type SessionMeta } from '@/atoms/sessions';

import { routes } from '@/lib/navigate';

import type { SessionStatus } from '@/config/session-status-config';
import type { KanbanColumnDef } from '@craft-agent/shared/projects/types';
import { KanbanBoard } from './KanbanBoard';

import { BoardListToggle } from './BoardListToggle';
import { KanbanProjectFilter, type KanbanProjectFilterOption } from './KanbanProjectFilter';

import type { KanbanColumnId, KanbanColumnMeta, KanbanProject, KanbanTask } from './types';

interface KanbanBoardContentProps {
  t: import("i18next").TFunction<"translation", undefined>
  projectOptions: KanbanProjectFilterOption[]
  projectFilter: string[]
  setProjectFilter: (args_0: string[] | ((prev: string[]) => string[])) => void
  usingProjectColumns: boolean
  editingProject: import("@craft-agent/shared/projects").LoadedProject | undefined
  setEditorTarget: (args_0: import("./types").TaskEditorTarget | ((prev: import("./types").TaskEditorTarget | null) => import("./types").TaskEditorTarget | null) | null) => void
  activeWorkspaceId: string | null
  navigate: (route: import("@/lib/navigate").Route, options?: import("@/lib/navigate").NavigateOptions) => void | Promise<void>
  activeColumns: readonly KanbanColumnMeta[]
  visibleTasks: KanbanTask[]
  projectsById: Map<string, KanbanProject>
  statusesById: Map<string, SessionStatus>
  sessionStatuses: SessionStatus[] | undefined
  handleChangeStatus: (taskId: string, statusId: string) => void
  treatment: import("../../../utils/project-colors").ProjectColorTreatment
  expandedTaskIds: Set<string>
  openSessionScoped: (sessionId: string, projectFallbackId?: string) => void
  handleEditTask: (taskId: string) => void
  handleToggleSubtasks: (taskId: string) => void
  metaMap: Map<string, SessionMeta>
  handleAddSubtask: (taskId: string, title: string, model: string) => Promise<void>
  handleRunSubtasks: (taskId: string) => void
  subtaskModelGroups: import("./types").KanbanModelProviderGroup[]
  defaultSubtaskModel: string | undefined
  handleCreateTask: (title: string) => Promise<void>
  handleMoveTask: (taskId: string, toColumn: KanbanColumnId) => void
  columnStatus: Partial<Record<string, string>>
  handleSelectDropStatus: (column: KanbanColumnId, statusId: string) => void
  handleUpdateColumn: (columnId: string, patch: Partial<SnapshotInput<KanbanColumnDef>>) => void
  handleRemoveColumn: (columnId: string) => void
  handleAddColumn: () => void
}

export function KanbanBoardContent({
  t,
  projectOptions,
  projectFilter,
  setProjectFilter,
  usingProjectColumns,
  editingProject,
  setEditorTarget,
  activeWorkspaceId,
  navigate,
  activeColumns,
  visibleTasks,
  projectsById,
  statusesById,
  sessionStatuses,
  handleChangeStatus,
  treatment,
  expandedTaskIds,
  openSessionScoped,
  handleEditTask,
  handleToggleSubtasks,
  metaMap,
  handleAddSubtask,
  handleRunSubtasks,
  subtaskModelGroups,
  defaultSubtaskModel,
  handleCreateTask,
  handleMoveTask,
  columnStatus,
  handleSelectDropStatus,
  handleUpdateColumn,
  handleRemoveColumn,
  handleAddColumn,
}: KanbanBoardContentProps) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-sm font-medium">{t('kanban.allTasks')}</span>
          {projectOptions.length > 0 && (
            <KanbanProjectFilter projects={projectOptions} value={projectFilter} onChange={setProjectFilter} />
          )}
          {usingProjectColumns && editingProject && (
            <span className="truncate text-[11px] text-foreground/45">
              {t('kanban.column.columnsFrom', { project: editingProject.config.name })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditorTarget(omitUndefined({ mode: 'create' as const, initialProjectId: projectFilter[0] }))}
            disabled={!activeWorkspaceId}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-semibold text-foreground transition-colors hover:bg-foreground/[0.03] disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> {t('kanban.newTask')}
          </button>
          <BoardListToggle
            value="board"
            onChange={view => {
              if (view === 'list') navigate(routes.view.allSessions())
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <KanbanBoard
          columns={activeColumns}
          tasks={visibleTasks}
          projectsById={projectsById}
          statusesById={statusesById}
          statuses={sessionStatuses ?? []}
          onChangeStatus={handleChangeStatus}
          treatment={treatment}
          expandedTaskIds={expandedTaskIds}
          onTaskClick={openSessionScoped}
          onEditTask={handleEditTask}
          onToggleSubtasks={handleToggleSubtasks}
          onSubtaskClick={(taskId, subtaskId) => openSessionScoped(subtaskId, metaMap.get(taskId)?.projectId)}
          onAddSubtask={handleAddSubtask}
          onRunSubtasks={handleRunSubtasks}
          subtaskModelGroups={subtaskModelGroups}
          defaultSubtaskModel={defaultSubtaskModel}
          onCreateTask={handleCreateTask}
          onMoveTask={handleMoveTask}
          columnDropStatus={columnStatus}
          onSelectDropStatus={handleSelectDropStatus}
          {...(editingProject
            ? {
                onUpdateColumn: handleUpdateColumn,
                onRemoveColumn: handleRemoveColumn,
                onAddColumn: handleAddColumn,
              }
            : {})}
        />
      </div>
    </div>
  )
}
