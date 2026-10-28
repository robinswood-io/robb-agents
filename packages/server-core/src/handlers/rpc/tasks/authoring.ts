import { RPC_CHANNELS } from '@craft-agent/shared/protocol';

import type { TaskCreateRequest, TaskCreateResult, TaskGenerateRequest, TaskGenerateAck, TaskValidationResultDto } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';


import { type SpaceAction } from '@craft-agent/shared/governance';
import { parseTaskYaml, saveTaskSpec, buildGeneratorPrompt, buildRepairPrompt, ensureDurableTaskMetadata, loadDurableTaskMetadata, updateDurableTaskMetadata } from '@craft-agent/shared/tasks';
import { createLogger } from '@craft-agent/shared/utils';
import { pushTyped, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from "../../handler-deps";


export function registerTaskAuthoringHandlers(server: RpcServer, deps: HandlerDeps, authorizeTaskAction: (context: RequestContext, workspaceId: string, action: SpaceAction) => NonNullable<ReturnType<typeof getWorkspaceByNameOrId>>, toValidationDto: (result: ReturnType<typeof parseTaskYaml>) => TaskValidationResultDto, tasksLog: ReturnType<typeof createLogger>, GENERATE_TIMEOUT_MS: number, MAX_GENERATE_ATTEMPTS: number, extractYaml: (text: string) => string): void {

  // tasks:validate — lint/dry-run; no side effects.
  server.handle(RPC_CHANNELS.tasks.VALIDATE, async (_ctx, _workspaceId: string, yaml: string): Promise<TaskValidationResultDto> => {
    return toValidationDto(parseTaskYaml(yaml))
  })

  // tasks:create — write task.yaml + create the orchestrator parent session.
  server.handle(RPC_CHANNELS.tasks.CREATE, async (ctx, workspaceId: string, req: TaskCreateRequest): Promise<TaskCreateResult> => {
    const ws = authorizeTaskAction(ctx, workspaceId, 'playbook.update')
    const parsed = parseTaskYaml(req.yaml)
    const validation = toValidationDto(parsed)
    if (!parsed.valid || !parsed.spec) {
      return { slug: '', orchestratorSessionId: '', validation }
    }
    const spec = parsed.spec
    const priorMetadata = loadDurableTaskMetadata(ws.rootPath, spec.id)
    saveTaskSpec(ws.rootPath, spec)
    if (priorMetadata) updateDurableTaskMetadata(ws.rootPath, spec.id, {})
    else ensureDurableTaskMetadata(ws.rootPath, spec.id)

    // Single choke point for ALL orchestrator paths (attach / adopt / fresh): apply the reserved
    // "Task" label (surfacing its resolved id so the renderer can navigate to the label filter)
    // and enable the spec's sources on the orchestrator session. Fail-soft — neither a label nor
    // a sources problem may fail task creation.
    const finish = async (orchestratorSessionId: string): Promise<TaskCreateResult> => {
      ensureDurableTaskMetadata(ws.rootPath, spec.id, { orchestratorSessionId })
      const applied = await deps.sessionManager
        .applyTaskLabel(orchestratorSessionId)
        .catch((err: unknown) => {
          tasksLog.warn('applyTaskLabel failed for orchestrator', { orchestratorSessionId, err })
          return undefined
        })
      if (spec.sources?.length) {
        await Promise.resolve(deps.sessionManager.setSessionSources(orchestratorSessionId, spec.sources))
          .catch((err: unknown) => {
            tasksLog.warn('setSessionSources failed for orchestrator', { orchestratorSessionId, err })
          })
      }
      return { slug: spec.id, orchestratorSessionId, validation, ...(applied?.labelId !== undefined ? { taskLabelId: applied?.labelId } : {}) }
    }

    // Edit-mode bind: the user saved this spec onto an existing, visible tile (e.g. a quick-add
    // session). Bind that session to the slug. Unlike adoption this HARD-ERRORS on failure — it
    // must never fall through to createSession, which would leave a duplicate orchestrator tile.
    if (req.attachToExistingSession) {
      const bound = await deps.sessionManager.bindExistingSessionToTask(req.attachToExistingSession, spec.id, {
        name: spec.title,
        projectId: spec.project,
        ...(spec.cwd ? { workingDirectory: spec.cwd } : {}),
        ...(spec.defaults?.model ? { model: spec.defaults.model } : {}),
        ...(spec.defaults?.llmConnection ? { llmConnection: spec.defaults.llmConnection } : {}),
        ...(spec.defaults?.permissionMode ? { permissionMode: spec.defaults.permissionMode } : {}),
      })
      if (!bound) {
        throw new Error(
          `Cannot attach task "${spec.id}" to session ${req.attachToExistingSession}: ` +
            `session is missing or already bound to a different task.`,
        )
      }
      return finish(req.attachToExistingSession)
    }

    // Adoption path: when the YAML was authored by a generate orchestrator, promote that hidden
    // draft in place instead of creating a second top-level session (#bug1). Falls back to a fresh
    // session if the draft is gone / already adopted / bound to another slug.
    if (req.orchestratorSessionId) {
      const adopted = await deps.sessionManager.adoptGeneratedTaskOrchestrator(req.orchestratorSessionId, spec.id, {
        name: spec.title,
        projectId: spec.project,
        ...(spec.cwd ? { workingDirectory: spec.cwd } : {}),
        ...(spec.defaults?.model ? { model: spec.defaults.model } : {}),
        // Reconcile the connection + permission mode from the saved spec (bind already does this) so an
        // orch model/mode changed after generation actually takes effect on the promoted orchestrator.
        ...(spec.defaults?.llmConnection ? { llmConnection: spec.defaults.llmConnection } : {}),
        ...(spec.defaults?.permissionMode ? { permissionMode: spec.defaults.permissionMode } : {}),
      })
      if (adopted) {
        return finish(req.orchestratorSessionId)
      }
    }

    const orchestrator = await deps.sessionManager.createSession(workspaceId, {
      name: spec.title,
      projectId: spec.project,
      sessionStatus: 'todo',
      // Stable linkage: this session orchestrates task `spec.id` across all of its runs.
      taskSlug: spec.id,
      // Explicit cwd from the spec seeds the orchestrator; children inherit it at dispatch.
      // Omitted → orchestrator falls back to the project/workspace default working directory.
      ...(spec.cwd ? { workingDirectory: spec.cwd } : {}),
      ...(spec.defaults?.model ? { model: spec.defaults.model } : {}),
      ...(spec.defaults?.llmConnection ? { llmConnection: spec.defaults.llmConnection } : {}),
      // Persisted task autonomy also seeds the orchestrator session (children read it via the runner).
      ...(spec.defaults?.permissionMode ? { permissionMode: spec.defaults.permissionMode } : {}),
    })
    // createSession announces the orchestrator to the renderer by default, so its tile appears
    // on the board immediately.
    return finish(orchestrator.id)
  })

  // tasks:generate — the persistent orchestrator session AUTHORS the task.yaml from a goal (#2).
  // It also remains the home for "ask the agent to revise it" (it holds the conversation).
  //
  // ASYNC: the orchestrator session is created synchronously (cheap) and its id is returned
  // immediately so the RPC never approaches the uniform client timeout. The authored spec is
  // streamed back via the `tasks:generated` push event keyed by orchestratorSessionId. The
  // session is a hidden taskDraft (off the board) until adopted by tasks:create; the editor
  // discards an unadopted draft on close, and because drafts are hidden a give-up-early client
  // never leaves a visible orphan tile.
  server.handle(RPC_CHANNELS.tasks.GENERATE, async (ctx, workspaceId: string, req: TaskGenerateRequest): Promise<TaskGenerateAck> => {
    authorizeTaskAction(ctx, workspaceId, 'playbook.update')
    const orchestrator = await deps.sessionManager.createSession(workspaceId, {
      name: req.title?.trim() || 'New task',
      sessionStatus: 'todo',
      // Hidden until the authored spec is validated and adopted via tasks:create. Keeps the
      // generate-time session off the board so "Generate → Create & Run" can't mint a duplicate
      // top-level tile (#bug1). Promotion clears this flag in adoptGeneratedTaskOrchestrator.
      taskDraft: true,
      // Bind the draft to the project so it authors against the project's <project_context>.
      ...(req.projectId ? { projectId: req.projectId } : {}),
      // Seed the orchestrator with the cwd chosen in the composer so the authored spec and any
      // dispatched children inherit it. Omitted → project/workspace default working directory.
      ...(req.cwd ? { workingDirectory: req.cwd } : {}),
      ...(req.model ? { model: req.model } : {}),
      // Non-default (pi/*) models need their serving connection to resolve a backend — without it the
      // authoring turn completes instantly with no output, producing an invalid/empty spec.
      ...(req.llmConnection ? { llmConnection: req.llmConnection } : {}),
      // Task-level sources become the draft's enabled set (omitted → workspace default).
      ...(req.enabledSourceSlugs?.length ? { enabledSourceSlugs: req.enabledSourceSlugs } : {}),
      // Seed the visible task autonomy so authoring runs at the chosen mode, not the workspace default.
      ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
    })
    const sessionId = orchestrator.id
    tasksLog.info('generate started', {
      workspaceId,
      sessionId,
      hasCwd: Boolean(req.cwd),
      model: req.model,
      projectId: req.projectId,
      hasConnection: Boolean(req.llmConnection),
      permissionMode: req.permissionMode,
    })

    // Send `prompt` to the orchestrator and await its next final turn. Subscribe BEFORE
    // sending so a fast turn can't complete before we listen; a timeout keeps a hung turn
    // from blocking forever.
    const askOrchestrator = (prompt: string) =>
      new Promise<string>((resolve, reject) => {
        let settled = false
        let off: (() => void) | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          off?.()
          if (timer) clearTimeout(timer)
          fn()
        }
        off = deps.sessionManager.onSessionComplete((evt) => {
          if (evt.sessionId !== sessionId) return
          const text = evt.finalText ?? deps.sessionManager.getSessionFinalText(sessionId) ?? ''
          finish(() => resolve(text))
        })
        timer = setTimeout(() => finish(() => reject(new Error('Task generation timed out'))), GENERATE_TIMEOUT_MS)
        void Promise.resolve(deps.sessionManager.sendMessage(sessionId, prompt))
          .catch((err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
      })

    // Run the generate→repair loop in the background and push the result when done. Awaiting
    // here would re-introduce the synchronous-RPC-over-WS timeout this async path exists to avoid.
    void (async () => {
      const startedAt = Date.now()
      try {
        // Generate, then auto-repair: the orchestrator still holds the conversation, so if the
        // authored spec fails validation (commonly a ${nodes.X.output} ref to an undeclared
        // node) hand the concrete errors back and re-validate. Bounded so a model that can't
        // self-correct can't loop forever — the last attempt's validation is returned as-is.
        let prompt = buildGeneratorPrompt(req.goal, req.title)
        let yaml = ''
        let parsed = parseTaskYaml(yaml)
        let attempts = 0
        for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
          attempts = attempt + 1
          const finalText = await askOrchestrator(prompt)
          yaml = extractYaml(finalText)
          parsed = parseTaskYaml(yaml)
          if (parsed.valid) break
          prompt = buildRepairPrompt(parsed.errors)
        }
        const validation = toValidationDto(parsed)
        // Do NOT persist here. tasks:create is the only writer of the live task.yaml — writing
        // eagerly on generation would clobber an existing task before the user confirms the edit.
        // The authored spec is delivered below via tasks:generated and saved on save/create.
        tasksLog.info('generate finished', {
          sessionId,
          valid: parsed.valid,
          attempts,
          elapsedMs: Date.now() - startedAt,
          slug: parsed.spec?.id ?? '',
        })
        pushTyped(server, RPC_CHANNELS.tasks.GENERATED, { to: 'workspace', workspaceId }, workspaceId, {
          orchestratorSessionId: sessionId,
          slug: parsed.spec?.id ?? '',
          ...(parsed.spec !== undefined ? { spec: parsed.spec } : {}),
          yaml,
          validation,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        tasksLog.error('generate failed', { sessionId, elapsedMs: Date.now() - startedAt, error: message })
        // Deliver the failure so the client can stop its spinner and surface a toast. The
        // orchestrator stays a hidden taskDraft (never shown on the board); the editor discards
        // it on close, so a failed generation leaves nothing for the user to clean up.
        pushTyped(server, RPC_CHANNELS.tasks.GENERATED, { to: 'workspace', workspaceId }, workspaceId, {
          orchestratorSessionId: sessionId,
          slug: '',
          yaml: '',
          validation: { valid: false, errors: [], warnings: [] },
          error: message,
        })
      }
    })()

    return { orchestratorSessionId: sessionId }
  })
}
