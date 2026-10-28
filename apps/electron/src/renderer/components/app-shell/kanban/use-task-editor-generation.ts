import type { TaskCreateRequest } from '../../../../../../../packages/shared/src/protocol/dto/tasks.ts';
import type { SpecForm } from './task-spec-form.ts';
import type { TaskGenerateRequest } from '../../../../../../../packages/shared/src/protocol/dto/tasks.ts';
import { omitUndefined, type SnapshotInput } from '@craft-agent/shared/utils/json';
import * as React from 'react';

import { toast } from 'sonner';

import { uid, buildSpec, specToSubtasks, type EditorSubtask, type TaskAutonomyPolicy, type TaskPermissionMode } from './task-spec-form';

import { GENERATE_CLIENT_TIMEOUT_MS, type Mode } from "./task-editor-primitives";

interface useTaskEditorGenerationInput {
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  projects: import("@craft-agent/shared/projects").LoadedProject[]
  projectId: string
  setSubtasks: React.Dispatch<React.SetStateAction<EditorSubtask[]>>
  t: import("i18next").TFunction<"translation", undefined>
  setTitle: React.Dispatch<React.SetStateAction<string>>
  setGoal: React.Dispatch<React.SetStateAction<string>>
  setDescription: React.Dispatch<React.SetStateAction<string>>
  setAcceptanceCriteria: React.Dispatch<React.SetStateAction<string>>
  setMaxRepairs: React.Dispatch<React.SetStateAction<string>>
  setAutonomy: React.Dispatch<React.SetStateAction<TaskAutonomyPolicy | undefined>>
  setOrchModel: React.Dispatch<React.SetStateAction<string>>
  setOrchConnection: React.Dispatch<React.SetStateAction<string | undefined>>
  setPermissionMode: React.Dispatch<React.SetStateAction<TaskPermissionMode>>
  setMode: React.Dispatch<React.SetStateAction<Mode>>
  goal: string
  title: string
  workspaceId: string
  orchModel: string
  orchConnection: string | undefined
  modelToConnection: Map<string, string>
  permissionMode: TaskPermissionMode
  sourceSlugs: string[]
  cwd: string
  subtasks: EditorSubtask[]
  description: string
  acceptanceCriteria: string
  maxRepairs: string
  autonomy: TaskAutonomyPolicy | undefined
  boundProjectId: string
  skillSlugs: string[]
  editSlug: string | undefined
  isEdit: boolean
  editSessionId: string | undefined
  onCreated: ((created: { sessionId: string; taskLabelId?: string; projectId?: string; }) => void) | undefined
  onClose: () => void
}

export function useTaskEditorGeneration({
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
}: useTaskEditorGenerationInput) {
const pendingGenRef = React.useRef<string | null>(null)

const genTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

const generatedDraftRef = React.useRef<string | null>(null)

const discardDraft = React.useCallback((sessionId: string) => {
    void window.electronAPI.deleteSession(sessionId).catch(() => {})
  }, [])

const finishGenerate = React.useCallback(() => {
    pendingGenRef.current = null
    if (genTimeoutRef.current) {
      clearTimeout(genTimeoutRef.current)
      genTimeoutRef.current = null
    }
    setBusy(false)
  }, [setBusy])

const project = projects.find((p) => p.config.id === projectId)

const updateSubtask = (id: string, patch: Partial<SnapshotInput<EditorSubtask>>) =>
    setSubtasks((prev) => prev.map((s) => (s.uid === id ? omitUndefined<EditorSubtask>({ ...s, ...patch }) : s)))

const removeSubtask = (id: string) =>
    setSubtasks((prev) =>
      prev.filter((s) => s.uid !== id).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== id) })),
    )

const addSubtask = () =>
    setSubtasks((prev) => {
      const last = prev[prev.length - 1]
      // No explicit model → the new subtask inherits the orchestrator default (the picker still shows
      // that effective model). Picking a model in the row makes it explicit.
      return [...prev, { uid: uid(), title: '', prompt: '', dependsOn: last ? [last.uid] : [] }]
    })

const applyGeneratedSpec = React.useCallback(
    (res: { orchestratorSessionId: string; spec?: unknown; validation: { valid: boolean; errors: Array<{ path: string; message: string }> }; error?: string }) => {
      if (res.error) {
        // The hidden draft orchestrator can't produce a usable spec — discard it so it doesn't
        // linger off-board.
        discardDraft(res.orchestratorSessionId)
        toast.error(t('tasks.toastCreateFailed'), { description: res.error })
        return
      }
      const spec = res.spec as
        | { title?: string; description?: string; goal?: string; acceptance_criteria?: string; max_iterations?: number; autonomy?: TaskAutonomyPolicy; defaults?: { model?: string; llmConnection?: string; permissionMode?: TaskPermissionMode }; nodes?: Array<{ id: string; title?: string; prompt?: string; model?: string; llmConnection?: string; depends_on?: string[] }> }
        | undefined
      if (!spec || !res.validation.valid) {
        discardDraft(res.orchestratorSessionId)
        const first = res.validation.errors[0]
        toast.error(t('tasks.toastInvalid'), { description: first ? `${first.path}: ${first.message}` : undefined })
        return
      }
      if (spec.title) setTitle(spec.title)
      if (spec.goal) setGoal(spec.goal)
      setDescription(spec.description ?? spec.goal ?? '')
      setAcceptanceCriteria(spec.acceptance_criteria ?? '')
      setMaxRepairs(spec.max_iterations != null ? String(spec.max_iterations) : '')
      setAutonomy(spec.autonomy)
      // Adopt the generator's routing only when it explicitly authored it — don't wipe the user's picks.
      if (spec.defaults?.model) setOrchModel(spec.defaults.model)
      if (spec.defaults?.llmConnection) setOrchConnection(spec.defaults.llmConnection)
      if (spec.defaults?.permissionMode) setPermissionMode(spec.defaults.permissionMode)
      setSubtasks(specToSubtasks(spec.nodes ?? []))
      setMode('manual')
      // Record the draft as adoptable: submit reuses it in place (edits are fine to run on it).
      generatedDraftRef.current = res.orchestratorSessionId
      // No success toast here: switching to Manual mode and populating the Subtasks panel is
      // the visible signal. A top-right toast would also overlap the editor's top-right
      // Cancel/Create/Create & Run buttons and swallow their clicks.
    },
    [t, discardDraft, setAcceptanceCriteria, setAutonomy, setDescription, setGoal, setMaxRepairs, setMode, setOrchConnection, setOrchModel, setPermissionMode, setSubtasks, setTitle],
  )

React.useEffect(() => {
    const off = window.electronAPI.onTaskGenerated((_wsId, res) => {
      if (res.orchestratorSessionId !== pendingGenRef.current) return
      finishGenerate()
      applyGeneratedSpec(res)
    })
    return off
  }, [finishGenerate, applyGeneratedSpec])

React.useEffect(() => () => {
    if (genTimeoutRef.current) clearTimeout(genTimeoutRef.current)
    const draftId = generatedDraftRef.current
    if (draftId) {
      generatedDraftRef.current = null
      void window.electronAPI.deleteSession(draftId).catch(() => {})
    }
  }, [])

async function generatePlan() {
    const g = goal.trim() || title.trim()
    if (!g) {
      toast.error(t('tasks.toastNeedTitle'))
      return
    }
    // Regenerating abandons any previously authored draft — discard it before minting a new one.
    if (generatedDraftRef.current) {
      discardDraft(generatedDraftRef.current)
      generatedDraftRef.current = null
    }
    setBusy(true)
    try {
      const ack = await window.electronAPI.generateTask(workspaceId, omitUndefined<TaskGenerateRequest>({
        goal: g,
        title: title.trim() || undefined,
        model: orchModel,
        // Route the authoring turn through the preserved connection (falls back to the model's default),
        // and give the draft the project context + sources + autonomy it will author against — else a
        // pi/* model produces nothing and the draft runs at the workspace-default permission mode.
        llmConnection: orchConnection ?? modelToConnection.get(orchModel),
        permissionMode,
        ...(projectId ? { projectId } : {}),
        ...(sourceSlugs.length ? { enabledSourceSlugs: sourceSlugs } : {}),
        cwd: cwd.trim() || undefined,
      }))
      // Authoring continues on the server; the spec arrives via onTaskGenerated. Keep busy until
      // then, with a fallback timer that releases the spinner if the event never lands.
      pendingGenRef.current = ack.orchestratorSessionId
      if (genTimeoutRef.current) clearTimeout(genTimeoutRef.current)
      genTimeoutRef.current = setTimeout(() => {
        if (pendingGenRef.current !== ack.orchestratorSessionId) return
        finishGenerate()
        toast.error(t('tasks.toastCreateFailed'), { description: t('tasks.toastGenerateTimeout') })
      }, GENERATE_CLIENT_TIMEOUT_MS)
    } catch (err) {
      finishGenerate()
      toast.error(t('tasks.toastCreateFailed'), { description: err instanceof Error ? err.message : String(err) })
    }
  }

async function submit(run: boolean) {
    if (!title.trim()) {
      toast.error(t('tasks.toastNeedTitle'))
      return
    }
    if (subtasks.length === 0) {
      toast.error(t('tasks.toastNeedSubtask'))
      return
    }
    if (subtasks.some((s) => !s.prompt.trim())) {
      toast.error(t('tasks.toastNeedPrompt'))
      return
    }
    // Edit mode pins the existing slug so the title can change without forking a new task folder
    // and orphaning the bound orchestrator session.
    const spec = buildSpec(
      omitUndefined<SpecForm>({
        title,
        description,
        goal,
        acceptanceCriteria,
        maxRepairs: maxRepairs.trim() === '' ? undefined : Number(maxRepairs),
        ...(autonomy !== undefined ? { autonomy: autonomy } : {}),
        projectId,
        orchModel,
        ...(orchConnection !== undefined ? { orchConnection: orchConnection } : {}),
        permissionMode,
        boundProjectId,
        subtasks,
        cwd,
        sourceSlugs,
        skillSlugs,
        ...(editSlug !== undefined ? { fixedId: editSlug } : {}),
      }),
      modelToConnection,
    )
    const yaml = JSON.stringify(spec, null, 2) // JSON is a valid YAML subset
    // Adopt the generate draft in place whenever we have one — spec edits run fine on the draft
    // orchestrator, so there's no need to mint a fresh session.
    const draftId = generatedDraftRef.current
    setBusy(true)
    try {
      // Edit mode binds the authored spec onto the tile's existing session; create mode reuses
      // a generate draft if present, else mints a fresh orchestrator.
      const created = await window.electronAPI.createTask(workspaceId, omitUndefined<TaskCreateRequest>({
        yaml,
        ...(isEdit && editSessionId
          ? { attachToExistingSession: editSessionId }
          : { orchestratorSessionId: draftId ?? undefined }),
      }))
      if (!created.validation.valid) {
        const first = created.validation.errors[0]
        toast.error(t('tasks.toastInvalid'), { description: first ? `${first.path}: ${first.message}` : undefined })
        return
      }
      // Resolve the draft: if the server reused it, it's now a live orchestrator — stop tracking it.
      // If it minted a fresh session instead (draft gone server-side), discard the orphan.
      if (draftId) {
        if (created.orchestratorSessionId !== draftId) discardDraft(draftId)
        generatedDraftRef.current = null
      }
      // After a successful CREATE, hand off to the host so it can land the user on the
      // task-scoped session list (edit-mode saves stay on the board).
      const notifyCreated = () => {
        if (isEdit) return
        onCreated?.({
          sessionId: created.orchestratorSessionId,
          ...(created.taskLabelId !== undefined ? { taskLabelId: created.taskLabelId } : {}),
          ...(projectId ? { projectId } : {}),
        })
      }
      if (!run) {
        toast.success(t('tasks.toastCreated'), { description: t('tasks.toastCreatedDesc', { slug: created.slug }) })
        onClose()
        notifyCreated()
        return
      }
      const runResult = await window.electronAPI.runTask(workspaceId, {
        slug: created.slug,
        orchestratorSessionId: created.orchestratorSessionId,
      })
      toast.success(t('tasks.toastStarted'), {
        description: t('tasks.toastStartedDesc', { slug: created.slug, runId: runResult.runId, count: runResult.nodes.length }),
      })
      onClose()
      notifyCreated()
    } catch (err) {
      toast.error(t('tasks.toastCreateFailed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
return { submit, project, addSubtask, updateSubtask, removeSubtask, generatePlan }
}
