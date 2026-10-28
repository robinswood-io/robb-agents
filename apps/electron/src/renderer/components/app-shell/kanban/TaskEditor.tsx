import { useEffectEvent } from 'react';
import * as React from 'react';
import "lucide-react";
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import "@/lib/utils";
import "@craft-agent/ui";
import { DEFAULT_MODEL } from '@config/models';
import { useAtomValue, useStore } from 'jotai';
import { useProjects } from '@/hooks/useProjects';
import { sourcesAtom } from '@/atoms/sources';
import { skillsAtom } from '@/atoms/skills';
import { sessionMetaMapAtom } from '@/atoms/sessions';
import { getSessionTitle } from '@/utils/session';
import "@/components/ui/dropdown-menu";
import { specToSubtasks, quickAddNodeId, quickAddChildToSubtask, type EditorSubtask, type TaskAutonomyPolicy, type TaskPermissionMode } from './task-spec-form';
import "./node-state-pill";
import "@/components/ui/source-avatar";
import "@/components/ui/skill-avatar";
import "@/components/ui/SourceSelectorPopover";
import "@/components/ui/SkillSelectorPopover";
import "../input/WorkingDirectorySelector";

import { useTaskEditorGeneration } from "./use-task-editor-generation";






















import { TaskEditorContent } from "./task-editor-content";
import { FALLBACK_MODEL_GROUPS, type Mode, type Tab, type TaskResults } from "./task-editor-primitives";

import type { KanbanModelProviderGroup, TaskEditorTarget } from './types';

// The target type lives in ./types so the editor-target atom can import it without
// pulling in this component module; re-exported here for existing consumers.
export type { TaskEditorTarget } from './types'

// ---------------------------------------------------------------------------
// Task Editor
// ---------------------------------------------------------------------------
export interface TaskEditorProps {
  workspaceId: string
  /** What the editor points at: create-new or edit an existing tile. Defaults to create. */
  target?: TaskEditorTarget | undefined
  /** Return to the board. */
  onClose: () => void
  /** Jump to the underlying orchestrator chat session (edit mode only). */
  onOpenSession?: (() => void) | undefined
  /** Jump to a specific child/subtask session (used by Results "Open session" links). */
  onOpenChildSession?: ((sessionId: string) => void) | undefined
  /**
   * Fired after a successful CREATE (never for edit-mode saves) so the host can land the
   * user somewhere useful — e.g. the session list scoped to the task. `taskLabelId` is the
   * RESOLVED reserved-label id from tasks:create (may be 'task-2' after a name collision).
   */
  onCreated?: ((created: { sessionId: string; taskLabelId?: string; projectId?: string }) => void) | undefined
  /** Real provider→model groups (from the workspace's LLM connections). */
  modelGroups: KanbanModelProviderGroup[]
  /** model id → connection slug that serves it (so each node routes to the right backend). */
  modelToConnection: Map<string, string>
  /** Default model id. */
  defaultModel: string
}

export function TaskEditor({
  workspaceId,
  target = { mode: 'create' },
  onClose,
  onOpenSession,
  onCreated,
  modelGroups,
  modelToConnection,
  defaultModel,
}: TaskEditorProps) {
  const { t } = useTranslation()
  const isEdit = target.mode === 'edit'
  // The slug to pin on save (edit mode). Undefined for create and for quick-add tiles with no slug;
  // in those cases buildSpec derives the id from the title.
  const editSlug = target.mode === 'edit' ? target.taskSlug : undefined
  const editSessionId = target.mode === 'edit' ? target.sessionId : undefined
  const groups = modelGroups.length > 0 ? modelGroups : FALLBACK_MODEL_GROUPS
  const fallbackModel = defaultModel || groups[0]?.models[0]?.id || DEFAULT_MODEL
  const { projects } = useProjects(workspaceId)
  const [tab, setTab] = React.useState<Tab>('definition')
  const [mode, setMode] = React.useState<Mode>('manual')
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [goal, setGoal] = React.useState('')
  const [acceptanceCriteria, setAcceptanceCriteria] = React.useState('')
  // Empty string = "use the runner default"; a number pins the spec's max_iterations.
  const [maxRepairs, setMaxRepairs] = React.useState('')
  // The backend owns safe defaults. The editor keeps explicit YAML overrides lossless even though
  // the compact UI does not expose three additional expert-only numeric controls.
  const [autonomy, setAutonomy] = React.useState<TaskAutonomyPolicy | undefined>(undefined)
  // Create mode seeds the project from the board's active filter (so a new card stays
  // visible under that filter); edit mode starts empty and is prefilled from the spec below.
  const [projectId, setProjectId] = React.useState(target.mode === 'create' ? (target.initialProjectId ?? '') : '')
  const [orchModel, setOrchModel] = React.useState(fallbackModel)
  // Explicit connection serving the orch model; undefined lets buildSpec derive it from orchModel.
  // Preserved from the loaded spec so an authored connection isn't rewritten on save (round-trip).
  const [orchConnection, setOrchConnection] = React.useState<string | undefined>(undefined)
  // Task-family permission mode. New UI tasks default to autonomous (Execute/allow-all) so product
  // behavior is unchanged; edit mode prefills from the spec. Persisted to defaults.permissionMode so
  // subtask autonomy is explicit + visible, never a hidden runner default.
  const [permissionMode, setPermissionMode] = React.useState<TaskPermissionMode>('allow-all')
  // The task's project binding at load (edit mode). Floor for buildSpec so leaving the picker on
  // "No Project" can't silently drop a binding, and the gate for whether "No Project" is offered.
  const [boundProjectId, setBoundProjectId] = React.useState('')
  const [subtasks, setSubtasks] = React.useState<EditorSubtask[]>([])
  const [cwd, setCwd] = React.useState('')
  // Task-level sources (enabled on orchestrator + children) and skills (read as context
  // before each child works). Empty = leave workspace defaults / no skill preamble.
  const [sourceSlugs, setSourceSlugs] = React.useState<string[]>([])
  const [skillSlugs, setSkillSlugs] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)

  // Pickable catalogs from the active workspace (AppShell keeps these atoms populated).
  const workspaceSources = useAtomValue(sourcesAtom)
  const workspaceSkills = useAtomValue(skillsAtom)
  // Sources are the task-level pickable catalog (children inherit them); skills are
  // read as context before each child. Both feed the icon-rich selector fields below.
  const enabledSources = React.useMemo(
    () => workspaceSources.filter((s) => s.config.enabled !== false),
    [workspaceSources],
  )

  // Results tab (edit mode): storage-backed run outcome, loaded lazily on tab open / refresh.
  const [results, setResults] = React.useState<TaskResults | null>(null)
  const [resultsLoading, setResultsLoading] = React.useState(false)

  // Jotai store handle for one-shot reads (no subscription — the editor must not re-render
  // on every streaming metadata tick just to have read children once at open).
  const store = useStore()

  /**
   * The tile's quick-add children as editor rows, so hand-spawned subtasks show up (and get
   * adopted into the spec on save) instead of living only on the tile. Each row carries the
   * deterministic node id `qa-<sessionId>`; a child whose qa-id is already a spec node was
   * adopted by a previous save and is skipped. Conductor-owned children (`taskNodeId`) are
   * executions of spec nodes — the node row already represents them.
   */
  const collectQuickAddRows = React.useCallback(
    (adoptedNodeIds: ReadonlySet<string>): EditorSubtask[] => {
      if (!editSessionId) return []
      const metaMap = store.get(sessionMetaMapAtom)
      const children = [...metaMap.values()]
        .filter(
          (child) =>
            child.parentSessionId === editSessionId &&
            !child.taskNodeId &&
            !child.hidden &&
            !child.isArchived &&
            !adoptedNodeIds.has(quickAddNodeId(child.id)),
        )
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      return children.map((child) => {
        // Quick-add contract: the typed title is the session name AND the dispatch prompt. Preserve the
        // child's explicit model + connection (custom-routed children must not lose their backend).
        const title = child.name?.trim() || getSessionTitle(child)
        return quickAddChildToSubtask({ sessionId: child.id, title, ...(child.model !== undefined ? { model: child.model } : {}), ...(child.llmConnection !== undefined ? { llmConnection: child.llmConnection } : {}) })
      })
    },
    [store, editSessionId],
  )

  // Edit-mode prefill: spec-backed tiles load their authored task.yaml; either way the tile's
  // quick-add children merge in as editable rows (adopted into the spec on the next save).
  const initializeTaskEditor = useEffectEvent(() => {
    if (target.mode !== 'edit') return
    let cancelled = false
    // The tile's existing project binding (spec-less quick-add tiles have no spec.project, so fall
    // back to the session's own projectId) — prefilled into the picker and kept as the buildSpec floor.
    const sessionMeta = editSessionId ? store.get(sessionMetaMapAtom).get(editSessionId) : undefined
    const sessionProjectId = sessionMeta?.projectId ?? ''
    if (target.taskSlug) {
      void window.electronAPI
        .getTask(workspaceId, target.taskSlug)
        .then((res) => {
          if (cancelled) return
          const spec = res.spec as
            | { title?: string; description?: string; goal?: string; acceptance_criteria?: string; max_iterations?: number; autonomy?: TaskAutonomyPolicy; project?: string; cwd?: string; sources?: string[]; skills?: string[]; defaults?: { model?: string; llmConnection?: string; permissionMode?: TaskPermissionMode }; nodes?: Array<{ id: string; title?: string; prompt?: string; model?: string; llmConnection?: string; depends_on?: string[] }> }
            | undefined
          if (!spec) return
          if (spec.title) setTitle(spec.title)
          if (spec.goal) setGoal(spec.goal)
          setDescription(spec.description ?? spec.goal ?? '')
          setAcceptanceCriteria(spec.acceptance_criteria ?? '')
          setMaxRepairs(spec.max_iterations != null ? String(spec.max_iterations) : '')
          setAutonomy(spec.autonomy)
          // Bind from the spec, else the session's existing binding. Record it as the immutable floor.
          const bound = spec.project ?? sessionProjectId
          setProjectId(bound)
          setBoundProjectId(bound)
          if (spec.cwd) setCwd(spec.cwd)
          setSourceSlugs(spec.sources ?? [])
          setSkillSlugs(spec.skills ?? [])
          if (spec.defaults?.model) setOrchModel(spec.defaults.model)
          // Preserve the authored orchestrator connection + permission mode (round-trip, no silent rewrite).
          // Fall back to the session's actual mode so saving a bound tile can't silently escalate it.
          setOrchConnection(spec.defaults?.llmConnection)
          if (spec.defaults?.permissionMode) setPermissionMode(spec.defaults.permissionMode)
          else if (sessionMeta?.permissionMode) setPermissionMode(sessionMeta.permissionMode as TaskPermissionMode)
          const nodes = spec.nodes ?? []
          setSubtasks([
            ...specToSubtasks(nodes),
            ...collectQuickAddRows(new Set(nodes.map((n) => n.id))),
          ])
        })
        .catch(() => {})
    } else {
      if (target.initialTitle) setTitle(target.initialTitle)
      // A bound quick-add tile with no task.yaml: prefill + floor from the session's own state, so
      // saving it as a task neither drops its project nor silently changes its permission mode.
      setProjectId(sessionProjectId)
      setBoundProjectId(sessionProjectId)
      if (sessionMeta?.permissionMode) setPermissionMode(sessionMeta.permissionMode as TaskPermissionMode)
      setSubtasks(collectQuickAddRows(new Set()))
    }
    return () => {
      cancelled = true
    }
    // Prefill runs once per target identity; fallbackModel is stable enough for this load.
  });
React.useEffect(() => initializeTaskEditor(), [target.mode, editSessionId, editSlug, workspaceId]);

  const loadResults = React.useCallback(() => {
    if (!editSlug) return
    setResultsLoading(true)
    void window.electronAPI
      .getTaskResults(workspaceId, editSlug)
      .then((res) => setResults(res))
      .catch(() => {})
      .finally(() => setResultsLoading(false))
  }, [workspaceId, editSlug])

  const controlMission = React.useCallback(
    async (action: 'pause' | 'resume' | 'stop') => {
      if (!editSlug || !results?.runId) return
      try {
        if (action === 'pause') await window.electronAPI.pauseTask(workspaceId, editSlug, results.runId)
        else if (action === 'resume') await window.electronAPI.resumeTask(workspaceId, editSlug, results.runId)
        else await window.electronAPI.stopTask(workspaceId, editSlug, results.runId)
        loadResults()
      } catch (error) {
        toast.error(t('tasks.controlActionFailed'), {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [editSlug, results?.runId, workspaceId, loadResults, t],
  )

  const resolveMissionApproval = React.useCallback(
    async (requestId: string, decision: 'approved' | 'rejected') => {
      if (!editSlug || !results?.runId) return
      try {
        await window.electronAPI.resolveTaskApproval(workspaceId, {
          slug: editSlug,
          runId: results.runId,
          requestId,
          decision,
          actor: 'desktop-operator',
        })
        loadResults()
      } catch (error) {
        toast.error(t('tasks.controlActionFailed'), {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [editSlug, results?.runId, workspaceId, loadResults, t],
  )

  const repairMissionNode = React.useCallback(
    async (nodeId: string) => {
      if (!editSlug || !results?.runId) return
      try {
        const repaired = await window.electronAPI.repairTask(workspaceId, {
          slug: editSlug,
          sourceRunId: results.runId,
          nodeIds: [nodeId],
          ...(editSessionId !== undefined ? { orchestratorSessionId: editSessionId } : {}),
        })
        toast.success(t('tasks.repairStarted'), { description: repaired.runId })
        loadResults()
      } catch (error) {
        toast.error(t('tasks.controlActionFailed'), {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [editSlug, editSessionId, results?.runId, workspaceId, loadResults, t],
  )

  const archiveTask = React.useCallback(async () => {
    if (!editSlug) return
    try {
      await window.electronAPI.updateTaskMetadata(workspaceId, { slug: editSlug, archived: true })
      toast.success(t('tasks.archived'))
      onClose()
    } catch (error) {
      toast.error(t('tasks.archiveTaskFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [editSlug, workspaceId, onClose, t])

  // Load results when the Results tab is first opened (and there's a slug to read).
  React.useEffect(() => {
    if (tab === 'results' && editSlug && !results && !resultsLoading) loadResults()
  }, [tab, editSlug, results, resultsLoading, loadResults])

  // Async generate: tasks:generate returns the orchestrator session id immediately and the
  // authored spec arrives later via the onTaskGenerated push event. We track the pending
  // orchestrator id so the listener only reacts to *our* generation, plus a client-side
  // fallback timer so the spinner can't hang forever if the event never lands.
  const {
    submit,
    project,
    addSubtask,
    updateSubtask,
    removeSubtask,
    generatePlan,
  } = useTaskEditorGeneration({
    setBusy,
    projects,
    projectId,
    setSubtasks,
    t,
    setTitle,
    setGoal,
    setDescription,
    setAcceptanceCriteria,
    setMaxRepairs,
    setAutonomy,
    setOrchModel,
    setOrchConnection,
    setPermissionMode,
    setMode,
    goal,
    title,
    workspaceId,
    orchModel,
    orchConnection,
    modelToConnection,
    permissionMode,
    sourceSlugs,
    cwd,
    subtasks,
    description,
    acceptanceCriteria,
    maxRepairs,
    autonomy,
    boundProjectId,
    skillSlugs,
    editSlug,
    isEdit,
    editSessionId,
    onCreated,
    onClose,
  })

  return (
    <TaskEditorContent
      onClose={onClose}
      t={t}
      isEdit={isEdit}
      setTab={setTab}
      tab={tab}
      onOpenSession={onOpenSession}
      busy={busy}
      editSlug={editSlug}
      archiveTask={archiveTask}
      submit={submit}
      loadResults={loadResults}
      resultsLoading={resultsLoading}
      results={results}
      controlMission={controlMission}
      resolveMissionApproval={resolveMissionApproval}
      repairMissionNode={repairMissionNode}
      setMode={setMode}
      mode={mode}
      title={title}
      setTitle={setTitle}
      description={description}
      setDescription={setDescription}
      goal={goal}
      setGoal={setGoal}
      acceptanceCriteria={acceptanceCriteria}
      setAcceptanceCriteria={setAcceptanceCriteria}
      project={project}
      boundProjectId={boundProjectId}
      setProjectId={setProjectId}
      projectId={projectId}
      projects={projects}
      orchModel={orchModel}
      setOrchModel={setOrchModel}
      setOrchConnection={setOrchConnection}
      modelToConnection={modelToConnection}
      groups={groups}
      permissionMode={permissionMode}
      setPermissionMode={setPermissionMode}
      enabledSources={enabledSources}
      sourceSlugs={sourceSlugs}
      setSourceSlugs={setSourceSlugs}
      workspaceSkills={workspaceSkills}
      skillSlugs={skillSlugs}
      setSkillSlugs={setSkillSlugs}
      workspaceId={workspaceId}
      cwd={cwd}
      setCwd={setCwd}
      maxRepairs={maxRepairs}
      setMaxRepairs={setMaxRepairs}
      subtasks={subtasks}
      addSubtask={addSubtask}
      fallbackModel={fallbackModel}
      updateSubtask={updateSubtask}
      removeSubtask={removeSubtask}
      generatePlan={generatePlan}
    />
  )
}
