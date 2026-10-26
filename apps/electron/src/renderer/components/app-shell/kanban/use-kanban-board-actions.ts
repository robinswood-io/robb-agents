import * as React from 'react';

import { toast } from 'sonner';

import { type SessionMeta } from '@/atoms/sessions';

import type { SessionStatus } from '@/config/session-status-config';
import type { KanbanColumnDef } from '@craft-agent/shared/projects/types';

import type { KanbanColumnId, KanbanColumnMeta, KanbanTask, SubtaskRunState } from './types';

interface useKanbanBoardActionsInput {
  setExpandedTaskIds: React.Dispatch<React.SetStateAction<Set<string>>>
  activeWorkspaceId: string | null
  modelToConnection: Map<string, string>
  onCreateSession: (workspaceId: string, options?: import("@craft-agent/shared/protocol").CreateSessionOptions) => Promise<import("@craft-agent/shared/protocol").Session>
  metaMap: Map<string, SessionMeta>
  t: import("i18next").TFunction<"translation", undefined>
  deriveRunState: (child: SessionMeta, statusesById: Map<string, SessionStatus>) => SubtaskRunState
  statusesById: Map<string, SessionStatus>
  onSendMessage: (sessionId: string, message: string, attachments?: import("@craft-agent/shared/protocol").FileAttachment[], skillSlugs?: string[], badges?: import("@craft-agent/core").ContentBadge[]) => void
  updateSessionMeta: (sessionId: string, updates: Partial<SessionMeta>) => void
  projectFilter: string[]
  activeColumns: readonly KanbanColumnMeta[]
  columnStatus: Partial<Record<string, string>>
  editingProject: import("@craft-agent/shared/projects").LoadedProject | undefined
  visibleTasks: KanbanTask[]
  setColumnStatus: (args_0: Partial<Record<string, string>> | typeof import("jotai/utils").RESET | ((prev: Partial<Record<string, string>>) => Partial<Record<string, string>> | typeof import("jotai/utils").RESET)) => void
}

export function useKanbanBoardActions({
  setExpandedTaskIds,
  activeWorkspaceId,
  modelToConnection,
  onCreateSession,
  metaMap,
  t,
  deriveRunState,
  statusesById,
  onSendMessage,
  updateSessionMeta,
  projectFilter,
  activeColumns,
  columnStatus,
  editingProject,
  visibleTasks,
  setColumnStatus,
}: useKanbanBoardActionsInput) {
const handleToggleSubtasks = React.useCallback((taskId: string) => {
    setExpandedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [setExpandedTaskIds])

const handleAddSubtask = React.useCallback(
    async (taskId: string, title: string, model: string) => {
      if (!activeWorkspaceId) return
      const llmConnection = modelToConnection.get(model)
      // Create only — the subtask lands as a pending row. The title is stored as
      // the session `name` so it shows on the row, is recovered as the prompt when
      // Play dispatches it, and suppresses AI title-gen. Execution is deferred.
      // applyTaskLabel: the child inherits the parent's task::N (numbering a
      // plain-chat parent in the same pass — it becomes a task by gaining a subtask).
      await onCreateSession(activeWorkspaceId, {
        parentSessionId: taskId,
        model,
        ...(llmConnection ? { llmConnection } : {}),
        name: title,
        applyTaskLabel: true,
      })
      setExpandedTaskIds(prev => new Set(prev).add(taskId))
    },
    [activeWorkspaceId, modelToConnection, onCreateSession, setExpandedTaskIds]
  )

const handleRunSubtasks = React.useCallback(
    (taskId: string) => {
      const meta = metaMap.get(taskId)
      if (activeWorkspaceId && meta?.taskSlug) {
        window.electronAPI
          .runTask(activeWorkspaceId, { slug: meta.taskSlug, orchestratorSessionId: taskId })
          .catch((err: unknown) => {
            toast.error(t('tasks.toastRunFailed'), {
              description: err instanceof Error ? err.message : String(err),
            })
          })
        return
      }
      for (const child of metaMap.values()) {
        if (child.parentSessionId !== taskId) continue
        // Skip Conductor-owned children: the TaskRunner drives their lifecycle (prompts,
        // status, retries). Dispatching them manually would double-run and race the runner.
        if (child.taskRunId) continue
        if (deriveRunState(child, statusesById) !== 'pending') continue
        const prompt = child.name?.trim()
        if (!prompt) continue
        onSendMessage(child.id, prompt)
        updateSessionMeta(child.id, { isProcessing: true })
      }
    },
    [metaMap, statusesById, onSendMessage, updateSessionMeta, activeWorkspaceId, t, deriveRunState]
  )

const handleCreateTask = React.useCallback(
    async (title: string) => {
      if (!activeWorkspaceId) return
      const boundProjectId = projectFilter[0]
      await onCreateSession(activeWorkspaceId, {
        name: title,
        sessionStatus: 'todo',
        ...(boundProjectId ? { projectId: boundProjectId } : {}),
        applyTaskLabel: true,
      })
    },
    [activeWorkspaceId, onCreateSession, projectFilter]
  )

const handleChangeStatus = React.useCallback(
    (taskId: string, statusId: string) => {
      updateSessionMeta(taskId, { sessionStatus: statusId })
      void window.electronAPI.sessionCommand(taskId, { type: 'setSessionStatus', state: statusId })
    },
    [updateSessionMeta]
  )

const handleMoveTask = React.useCallback(
    (taskId: string, toColumn: KanbanColumnId) => {
      // Optimistic: the column derives from `kanbanColumn` first, so writing it
      // immediately reflows the tile before the RPC lands.
      updateSessionMeta(taskId, { kanbanColumn: toColumn })
      void window.electronAPI.sessionCommand(taskId, { type: 'setKanbanColumn', column: toColumn })
      // Optionally fold the status to the column's configured target. Project
      // columns carry their own `dropStatusId`; the default view reads the global
      // atom. Guarded on a known status so a stale mapping is a no-op.
      const autoStatus = activeColumns.find(c => c.id === toColumn)?.dropStatusId ?? columnStatus[toColumn]
      if (autoStatus && statusesById.has(autoStatus)) {
        handleChangeStatus(taskId, autoStatus)
      }
    },
    [updateSessionMeta, activeColumns, columnStatus, statusesById, handleChangeStatus]
  )

const persistProjectColumns = React.useCallback(
    (columns: KanbanColumnDef[]) => {
      if (!activeWorkspaceId || !editingProject) return
      void window.electronAPI.updateProject(activeWorkspaceId, editingProject.config.slug, {
        kanbanColumns: columns,
      })
    },
    [activeWorkspaceId, editingProject]
  )

const resolveEditableColumns = React.useCallback((): KanbanColumnDef[] => {
    const custom = editingProject?.config.kanbanColumns
    if (custom?.length) return custom.map(c => ({ ...c }))
    return activeColumns.map(c => ({
      id: c.id,
      name: c.name ?? (c.labelKey ? t(c.labelKey) : c.id),
      color: c.color,
      dropStatusId: c.dropStatusId,
    }))
  }, [editingProject, activeColumns, t])

const handleAddColumn = React.useCallback(() => {
    const base = resolveEditableColumns()
    const id = `col-${crypto.randomUUID().slice(0, 8)}`
    persistProjectColumns([...base, { id, name: t('kanban.column.newColumnName') }])
  }, [resolveEditableColumns, persistProjectColumns, t])

const handleUpdateColumn = React.useCallback(
    (columnId: string, patch: Partial<KanbanColumnDef>) => {
      const next = resolveEditableColumns().map(c => (c.id === columnId ? { ...c, ...patch } : c))
      persistProjectColumns(next)
    },
    [resolveEditableColumns, persistProjectColumns]
  )

const handleRemoveColumn = React.useCallback(
    (columnId: string) => {
      const remaining = resolveEditableColumns().filter(c => c.id !== columnId)
      const fallbackId = remaining[0]?.id
      // Reassign orphaned cards to the first remaining column so none disappears
      // (optimistic per-task, mirroring handleMoveTask).
      if (fallbackId) {
        for (const task of visibleTasks) {
          if (task.column !== columnId) continue
          updateSessionMeta(task.id, { kanbanColumn: fallbackId })
          void window.electronAPI.sessionCommand(task.id, { type: 'setKanbanColumn', column: fallbackId })
        }
      }
      persistProjectColumns(remaining)
    },
    [resolveEditableColumns, persistProjectColumns, visibleTasks, updateSessionMeta]
  )

const handleSelectDropStatus = React.useCallback(
    (column: KanbanColumnId, statusId: string) => {
      if (editingProject) {
        handleUpdateColumn(column, { dropStatusId: statusId || undefined })
        return
      }
      setColumnStatus(prev => {
        const next = { ...prev }
        if (statusId) next[column] = statusId
        else delete next[column]
        return next
      })
    },
    [editingProject, handleUpdateColumn, setColumnStatus]
  )
return { handleToggleSubtasks, handleAddSubtask, handleRunSubtasks, handleCreateTask, handleChangeStatus, handleMoveTask, handleAddColumn, handleUpdateColumn, handleRemoveColumn, handleSelectDropStatus }
}
