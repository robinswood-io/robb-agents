import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from 'react';
import "lucide-react";
import "sonner";
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useAppShellContext } from '@/context/AppShellContext';
import { sessionMetaMapAtom, updateSessionMetaAtom, type SessionMeta } from '@/atoms/sessions';
import { projectsAtom } from '@/atoms/projects';
import { kanbanProjectFilterAtom, kanbanColumnStatusAtom, kanbanEditorTargetAtom } from '@/atoms/kanban';
import { useNavigation } from '@/contexts/NavigationContext';
import { useProjectColorTreatment } from '@/hooks/useProjectColorTreatment';
import { useLabels } from '@/hooks/useLabels';
import { getSessionTitle } from '@/utils/session';
import "@/lib/navigate";
import { resolveTaskScopeLabelId } from '@craft-agent/shared/labels';
import { DEFAULT_MODEL } from '@config/models';
import { buildModelCatalog } from './model-catalog';
import "./KanbanBoard";
import { KANBAN_COLUMNS, statusToColumn } from './status-column';
import "./BoardListToggle";
import "./KanbanProjectFilter";
import { TaskEditor } from './TaskEditor';
import { mergeSubtaskRows, type SpecNodeSummary, type SubtaskChildRow } from './subtask-merge';

import { useKanbanBoardActions } from "./use-kanban-board-actions";
























import { KanbanBoardContent } from "./kanban-board-content";

import type { SessionStatus } from '@/config/session-status-config';

import { type KanbanProjectFilterOption } from './KanbanProjectFilter';

import type { SpecNode } from './task-spec-form';
import type { KanbanColumnMeta, KanbanProject, KanbanTask, SubtaskRunState } from './types';

/**
 * Subtask run-state from the child session. A closed status wins (done), then an
 * in-flight turn (running). A subtask that has exchanged at least one message has
 * been dispatched — in the create-then-run flow these are one-shot, so a finished
 * turn reads as done. Only a created-but-never-run child (no messages) is pending —
 * and that is exactly what the tile's Play button dispatches. `lastMessageAt` can't
 * carry this distinction: the server stamps it at creation time as a sort key.
 */
function deriveRunState(child: SessionMeta, statusesById: Map<string, SessionStatus>): SubtaskRunState {
  if (statusesById.get(child.sessionStatus ?? '')?.category === 'closed') return 'done'
  // The Conductor marks a failed node 'needs-review' (there is no 'failed' session
  // status), so within a task that reads as a failed subtask on the board. v1 heuristic;
  // the precise source is the run-log node-state (P1 inspector wires the live run snapshot).
  if (child.sessionStatus === 'needs-review') return 'failed'
  if (child.isProcessing) return 'running'
  if ((child.messageCount ?? 0) > 0) return 'done'
  return 'pending'
}

/**
 * Live Kanban board. Derives tiles from the session metadata map: top-level
 * sessions become task tiles, child sessions (those carrying a `parentSessionId`)
 * become subtask rows under their parent. Column placement comes from the
 * persisted `kanbanColumn`, falling back to the session status' default column;
 * the status badge is independent from the column.
 */
export function KanbanBoardContainer() {
  const { activeWorkspaceId, llmConnections, sessionStatuses, onCreateSession, onSendMessage, onJumpToTaskSessions } =
    useAppShellContext()
  const { t } = useTranslation()
  const metaMap = useAtomValue(sessionMetaMapAtom)
  const projects = useAtomValue(projectsAtom)
  const [projectFilter, setProjectFilter] = useAtom(kanbanProjectFilterAtom)
  const [columnStatus, setColumnStatus] = useAtom(kanbanColumnStatusAtom)
  const treatment = useProjectColorTreatment()
  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)
  const { navigate, navigateToSession } = useNavigation()
  // Label tree for resolving the reserved Task label (scoped tile-click navigation).
  const { labels: labelConfigs } = useLabels(activeWorkspaceId ?? null)

  // Keep the (module-global) board project filter scoped to the current workspace + live projects:
  //  • on workspace switch, clear it — the previous workspace's project ids are meaningless here;
  //  • otherwise prune ids whose project no longer exists (e.g. after a delete) so the board can't
  //    stay filtered to nothing. Identity-preserving returns avoid needless re-renders/loops.
  const prevWorkspaceRef = React.useRef(activeWorkspaceId)
  React.useEffect(() => {
    if (prevWorkspaceRef.current !== activeWorkspaceId) {
      prevWorkspaceRef.current = activeWorkspaceId
      setProjectFilter(prev => (prev.length ? [] : prev))
      return
    }
    setProjectFilter(prev => {
      if (prev.length === 0) return prev
      const live = prev.filter(id => projects.some(p => p.config.id === id))
      return live.length === prev.length ? prev : live
    })
  }, [activeWorkspaceId, projects, setProjectFilter])

  const [expandedTaskIds, setExpandedTaskIds] = React.useState<Set<string>>(() => new Set())

  // Full-pane Task editor overlays the board pane (no global route needed). "Add task" opens it in
  // create mode; the tile "Edit task" affordance opens it in edit mode pointed at that session.
  // Atom-backed (not local state) so the chat header's "Edit task" can set the target and
  // navigate here — the overlay is already open when the board mounts. Declared before the
  // spec fetch below, which refetches when the editor closes (a save may have changed specs).
  const [editorTarget, setEditorTarget] = useAtom(kanbanEditorTargetAtom)

  const statusesById = React.useMemo(() => {
    const map = new Map<string, SessionStatus>()
    for (const status of sessionStatuses ?? []) map.set(status.id, status)
    return map
  }, [sessionStatuses])

  const projectsById = React.useMemo(() => {
    const map = new Map<string, KanbanProject>()
    for (const project of projects) {
      const color = project.config.color
      // Only color-bearing projects need an entry; a tile without one renders plain.
      if (!color) continue
      map.set(project.config.id, { id: project.config.id, name: project.config.name, color })
    }
    return map
  }, [projects])

  // Every project (with or without a color) is selectable in the header filter.
  const projectOptions = React.useMemo<KanbanProjectFilterOption[]>(
    () => projects.map(p => (omitUndefined({ id: p.config.id, name: p.config.name, color: p.config.color }))),
    [projects]
  )

  const { groups: subtaskModelGroups, modelToConnection } = React.useMemo(
    () => buildModelCatalog(llmConnections),
    [llmConnections]
  )

  // Per-project columns apply only when exactly one project is in focus — the
  // cross-project "all tasks" view always uses the default 3 columns so it stays
  // coherent. `editingProject` is that single project (column editing is a project
  // property, so it's only offered here).
  const editingProject = React.useMemo(
    () => (projectFilter.length === 1 ? projects.find(p => p.config.id === projectFilter[0]) : undefined),
    [projectFilter, projects]
  )

  // The active column set: the focused project's custom columns when it defines
  // any, otherwise the default built-ins. Custom defs map straight onto the
  // presentational meta (verbatim `name`, no i18n key).
  const activeColumns = React.useMemo<readonly KanbanColumnMeta[]>(() => {
    const custom = editingProject?.config.kanbanColumns
    if (custom?.length) {
      return custom.map(c => omitUndefined({ id: c.id, name: c.name, color: c.color, dropStatusId: c.dropStatusId }))
    }
    return KANBAN_COLUMNS
  }, [editingProject])

  const usingProjectColumns = !!editingProject?.config.kanbanColumns?.length

  // ---------------------------------------------------------------------------
  // Spec node summaries for spec-backed tiles, keyed by task slug. The tile merges
  // these with live child sessions (see mergeSubtaskRows) so authored-but-never-run
  // nodes show as pending rows. Refetched when the slug set changes and whenever the
  // editor closes — a save/generate may have rewritten any task.yaml.
  // ---------------------------------------------------------------------------
  const [specNodesBySlug, setSpecNodesBySlug] = React.useState<ReadonlyMap<string, SpecNodeSummary[]>>(
    () => new Map()
  )

  const specSlugsKey = React.useMemo(() => {
    const slugs = new Set<string>()
    for (const meta of metaMap.values()) {
      if (meta.parentSessionId || meta.isArchived || meta.hidden || meta.taskDraft) continue
      if (meta.taskSlug) slugs.add(meta.taskSlug)
    }
    return [...slugs].sort().join(',')
  }, [metaMap])

  const editorOpen = editorTarget != null
  React.useEffect(() => {
    if (!activeWorkspaceId || editorOpen) return
    const slugs = specSlugsKey ? specSlugsKey.split(',') : []
    if (slugs.length === 0) {
      setSpecNodesBySlug(new Map())
      return
    }
    let cancelled = false
    void Promise.all(
      slugs.map(async (slug): Promise<readonly [string, SpecNodeSummary[]]> => {
        try {
          const res = await window.electronAPI.getTask(activeWorkspaceId, slug)
          const spec = res.spec as { defaults?: { model?: string }; nodes?: SpecNode[] } | undefined
          const defaultModel = spec?.defaults?.model
          return [
            slug,
            (spec?.nodes ?? []).map(n => (omitUndefined({ id: n.id, title: n.title || n.id, model: n.model ?? defaultModel }))),
          ]
        } catch {
          // Unreadable spec → empty node list: the tile falls back to children-only rows.
          return [slug, []]
        }
      })
    ).then(entries => {
      if (!cancelled) setSpecNodesBySlug(new Map(entries))
    })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, specSlugsKey, editorOpen])

  const tasks = React.useMemo(() => {
    const childrenByParent = new Map<string, SessionMeta[]>()
    for (const meta of metaMap.values()) {
      if (!meta.parentSessionId) continue
      const siblings = childrenByParent.get(meta.parentSessionId)
      if (siblings) siblings.push(meta)
      else childrenByParent.set(meta.parentSessionId, [meta])
    }

    const result: KanbanTask[] = []
    for (const meta of metaMap.values()) {
      if (meta.parentSessionId) continue
      if (meta.isArchived || meta.hidden || meta.taskDraft) continue
      const statusId = meta.sessionStatus ?? 'todo'
      // Placement is the persisted free-string column, else the status' default column.
      // Validity against the *active* column set is enforced by KanbanBoard (unknown
      // ids fall back to the first column), so no built-in-only guard is needed here.
      const column = meta.kanbanColumn ?? statusToColumn(statusId)
      const children: SubtaskChildRow[] = (childrenByParent.get(meta.id) ?? []).map(child => (omitUndefined({
        id: child.id,
        title: getSessionTitle(child),
        runState: deriveRunState(child, statusesById),
        model: child.model ?? DEFAULT_MODEL,
        taskNodeId: child.taskNodeId,
        createdAt: child.createdAt,
      })))
      // Spec-backed tiles show one row per DAG node (bound to its latest child session,
      // or pending when never run) plus unadopted quick-adds; plain tiles show children.
      const specNodes = meta.taskSlug ? specNodesBySlug.get(meta.taskSlug) : undefined
      const subtasks = mergeSubtaskRows(specNodes, children, DEFAULT_MODEL)
      result.push(omitUndefined<KanbanTask>({
        id: meta.id,
        title: getSessionTitle(meta),
        column,
        statusId,
        model: meta.model ?? DEFAULT_MODEL,
        ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
        ...(meta.taskSlug !== undefined ? { taskSlug: meta.taskSlug } : {}),
        subtasks,
        // With merged spec rows the list already contains every node, so it IS the
        // denominator; the header count only backstops the not-yet-fetched window.
        subtaskTotal: specNodes?.length ? undefined : meta.taskNodeCount,
        ...(meta.isFlagged !== undefined ? { isFlagged: meta.isFlagged } : {}),
        ...(meta.isProcessing !== undefined ? { isProcessing: meta.isProcessing } : {}),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.lastMessageAt !== undefined ? { lastMessageAt: meta.lastMessageAt } : {}),
        ...(meta.messageCount !== undefined ? { messageCount: meta.messageCount } : {}),
        ...(meta.tokenUsage?.costUsd !== undefined ? { costUsd: meta.tokenUsage?.costUsd } : {}),
      }))
    }
    return result
  }, [metaMap, statusesById, specNodesBySlug])

  // Project filter: empty selection = show all. While a filter is active, tiles
  // with no project are hidden (an explicit "No project" option is a later add).
  const visibleTasks = React.useMemo(() => {
    if (projectFilter.length === 0) return tasks
    const allow = new Set(projectFilter)
    return tasks.filter(task => task.projectId !== undefined && allow.has(task.projectId))
  }, [tasks, projectFilter])

  const defaultSubtaskModel = modelToConnection.has(DEFAULT_MODEL) ? DEFAULT_MODEL : undefined

  const {
    handleToggleSubtasks,
    handleAddSubtask,
    handleRunSubtasks,
    handleCreateTask,
    handleChangeStatus,
    handleMoveTask,
    handleAddColumn,
    handleUpdateColumn,
    handleRemoveColumn,
    handleSelectDropStatus,
  } = useKanbanBoardActions({
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
  })

  // Board clicks land on All Sessions with the task's scope applied as the NORMAL,
  // user-clearable header-chip filters: label filter = the session's per-task item
  // label (`TASK-<slug>-<N>` — exactly this task's family; legacy root-only sessions
  // fall back to the Task root), project filter = the task's project (when bound).
  // Sessions without any task label (plain chats) fall back to plain navigation.
  // `projectFallbackId` lets subtask rows inherit the parent tile's project when
  // the child session itself carries none (older quick-add subtasks).
  const openSessionScoped = React.useCallback(
    (sessionId: string, projectFallbackId?: string) => {
      const meta = metaMap.get(sessionId)
      const scopeLabelId = resolveTaskScopeLabelId(meta?.labels, labelConfigs)
      if (scopeLabelId && onJumpToTaskSessions) {
        onJumpToTaskSessions(sessionId, omitUndefined({
          labelId: scopeLabelId,
          projectId: meta?.projectId ?? projectFallbackId,
        }))
        return
      }
      navigateToSession(sessionId)
    },
    [metaMap, labelConfigs, onJumpToTaskSessions, navigateToSession]
  )

  const handleEditTask = React.useCallback(
    (taskId: string) => {
      const meta = metaMap.get(taskId)
      setEditorTarget(omitUndefined({
        mode: 'edit' as const,
        sessionId: taskId,
        taskSlug: meta?.taskSlug,
        initialTitle: meta ? getSessionTitle(meta) : undefined,
      }))
    },
    [metaMap, setEditorTarget]
  )

  if (editorTarget && activeWorkspaceId) {
    return (
      <TaskEditor
        workspaceId={activeWorkspaceId}
        target={editorTarget}
        onClose={() => setEditorTarget(null)}
        onOpenSession={
          editorTarget.mode === 'edit'
            ? () => {
                const sessionId = editorTarget.sessionId
                setEditorTarget(null)
                navigateToSession(sessionId)
              }
            : undefined
        }
        onOpenChildSession={(sessionId) => {
          setEditorTarget(null)
          navigateToSession(sessionId)
        }}
        onCreated={({ sessionId, taskLabelId, projectId: createdProjectId }) => {
          // Same human-clearable scope as a tile click; no label (fail-soft) → plain open.
          if (taskLabelId && onJumpToTaskSessions) {
            onJumpToTaskSessions(sessionId, { labelId: taskLabelId, ...(createdProjectId !== undefined ? { projectId: createdProjectId } : {}) })
          } else {
            navigateToSession(sessionId)
          }
        }}
        modelGroups={subtaskModelGroups}
        modelToConnection={modelToConnection}
        defaultModel={defaultSubtaskModel ?? DEFAULT_MODEL}
      />
    )
  }

  return (
    <KanbanBoardContent
      t={t}
      projectOptions={projectOptions}
      projectFilter={projectFilter}
      setProjectFilter={setProjectFilter}
      usingProjectColumns={usingProjectColumns}
      editingProject={editingProject}
      setEditorTarget={setEditorTarget}
      activeWorkspaceId={activeWorkspaceId}
      navigate={navigate}
      activeColumns={activeColumns}
      visibleTasks={visibleTasks}
      projectsById={projectsById}
      statusesById={statusesById}
      sessionStatuses={sessionStatuses}
      handleChangeStatus={handleChangeStatus}
      treatment={treatment}
      expandedTaskIds={expandedTaskIds}
      openSessionScoped={openSessionScoped}
      handleEditTask={handleEditTask}
      handleToggleSubtasks={handleToggleSubtasks}
      metaMap={metaMap}
      handleAddSubtask={handleAddSubtask}
      handleRunSubtasks={handleRunSubtasks}
      subtaskModelGroups={subtaskModelGroups}
      defaultSubtaskModel={defaultSubtaskModel}
      handleCreateTask={handleCreateTask}
      handleMoveTask={handleMoveTask}
      columnStatus={columnStatus}
      handleSelectDropStatus={handleSelectDropStatus}
      handleUpdateColumn={handleUpdateColumn}
      handleRemoveColumn={handleRemoveColumn}
      handleAddColumn={handleAddColumn}
    />
  )
}
