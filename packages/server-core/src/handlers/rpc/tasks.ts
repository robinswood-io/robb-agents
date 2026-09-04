/**
 * RPC handlers for the Tasks Conductor.
 *
 * Channels (all REMOTE_ELIGIBLE — tasks are workspace content):
 *   tasks:validate — lint/dry-run a task.yaml string (no side effects)
 *   tasks:create   — write task.yaml + create the orchestrator parent session
 *   tasks:run      — start a run (returns the run snapshot)
 *   tasks:pause | resume | stop — run control
 *   tasks:get      — spec + (optional) active run-state
 *   tasks:list     — task slugs with a task.yaml
 *
 * The legacy `tasks:getOutput` (background-task remnant) is handled in sessions.ts
 * and intentionally left untouched; retiring it is a separate cleanup.
 */
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { join } from 'node:path'
import type {
  TaskCreateRequest,
  TaskCreateResult,
  TaskGenerateRequest,
  TaskGenerateAck,
  TaskGenerateResult,
  TaskRunRequest,
  TaskRepairRequest,
  TaskValidationResultDto,
  TaskGetResult,
  TaskResultsDto,
  TaskResultNodeDto,
  TaskApprovalRequestDto,
  TaskApprovalDecisionRequest,
  TaskKillSwitchSnapshotDto,
  TaskKillSwitchUpdateRequest,
  DurableTaskSnapshotDto,
  DurableTaskMetadataUpdateRequest,
  DurableTaskCockpitProjectionsDto,
} from '@craft-agent/shared/protocol'
import {
  getDefaultLlmConnection,
  getLlmConnections,
  getWorkspaceByNameOrId,
  resolveConfigDir,
} from '@craft-agent/shared/config'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import {
  WorkspaceGovernanceProfileSchema,
  assertSpaceAction,
  createDefaultWorkspaceGovernance,
  DurableKillSwitchRegistry,
  type SpaceAction,
} from '@craft-agent/shared/governance'
import {
  parseTaskYaml,
  saveTaskSpec,
  loadTaskSpec,
  listTaskSlugs,
  buildGeneratorPrompt,
  buildRepairPrompt,
  listRunIds,
  readRunLog,
  readNodeOutput,
  readRunSpecSnapshot,
  nodeTitle,
  DEFAULT_REPAIR_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS_CAP,
  buildMissionControlSnapshot,
  planMissionReplay,
  exportMissionReportMarkdown,
  authorizeWorkspacePath,
  validateExecutionIsolationPolicy,
  type GuardDecision,
  ensureDurableTaskMetadata,
  loadDurableTaskMetadata,
  updateDurableTaskMetadata,
  buildDurableTaskSnapshot,
  projectDurableTaskToCockpits,
} from '@craft-agent/shared/tasks'
import { createLogger } from '@craft-agent/shared/utils'
import {
  assertRequestWorkspace,
  pushTyped,
  type RequestContext,
  type RpcServer,
} from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  TaskRunner,
  DEFAULT_AUTONOMOUS_RETRY_POLICY,
  loadWorkspaceExecutionProofIssuer,
  resolveTaskNodeExecutionRoute,
  type TaskExecutionGuardContext,
} from '../../tasks'

const tasksLog = createLogger('tasks-generate')

/**
 * Admission boundary for the capabilities the local SessionManager can
 * actually enforce today. Strict children enforce file access and disabled
 * egress again before every tool call through the persisted isolation envelope.
 * A fully inherited Execute child deliberately uses the ordinary session tool
 * surface instead; the two-key inheritance resolver is authoritative for that
 * exception.
 *
 * External mutations remain broker-only and explicit CPU/memory envelopes
 * remain unavailable until a dedicated worker runtime enforces them.
 */
export function createProductionTaskExecutionGuard(
  hostWorkspaceRoot: string,
): (context: TaskExecutionGuardContext) => GuardDecision {
  return (context) => {
    const policyDecision = validateExecutionIsolationPolicy(context.policy, hostWorkspaceRoot)
    if (!policyDecision.allowed) return policyDecision

    const workingDirectory = context.workingDirectory ?? context.policy.workspaceRoot
    const pathDecision = authorizeWorkspacePath(
      context.policy.workspaceRoot,
      workingDirectory,
      context.policy.allowedReadPaths,
    )
    if (!pathDecision.allowed) {
      return { allowed: false, reason: `Working directory is not sandbox-authorized: ${pathDecision.reason}` }
    }

    if (context.effect === 'external-mutation') {
      return {
        allowed: false,
        reason: 'External mutation nodes require a broker-backed connector worker',
      }
    }
    if (
      !context.fullAutonomyInherited
      && (context.policy.networkAccess !== 'disabled' || context.policy.allowedHosts.length > 0)
    ) {
      return {
        allowed: false,
        reason: 'Network access requested without an enforceable per-task egress proxy',
      }
    }
    if (context.resourceLimitsExplicit) {
      return {
        allowed: false,
        reason: 'CPU or memory isolation requested without an enforceable per-task OS resource sandbox',
      }
    }

    if (context.effect === 'workspace-write' && context.permissionMode === 'safe') {
      return {
        allowed: false,
        reason: 'A workspace-write node cannot run in safe permission mode',
      }
    }

    return { allowed: true }
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.tasks.VALIDATE,
  RPC_CHANNELS.tasks.CREATE,
  RPC_CHANNELS.tasks.GENERATE,
  RPC_CHANNELS.tasks.RUN,
  RPC_CHANNELS.tasks.PAUSE,
  RPC_CHANNELS.tasks.RESUME,
  RPC_CHANNELS.tasks.STOP,
  RPC_CHANNELS.tasks.REPAIR,
  RPC_CHANNELS.tasks.LIST_APPROVALS,
  RPC_CHANNELS.tasks.RESOLVE_APPROVAL,
  RPC_CHANNELS.tasks.GET_KILL_SWITCHES,
  RPC_CHANNELS.tasks.SET_KILL_SWITCH,
  RPC_CHANNELS.tasks.GET,
  RPC_CHANNELS.tasks.LIST,
  RPC_CHANNELS.tasks.LIST_DURABLE,
  RPC_CHANNELS.tasks.UPDATE_METADATA,
  RPC_CHANNELS.tasks.GET_COCKPIT_PROJECTIONS,
  RPC_CHANNELS.tasks.GET_RESULTS,
] as const

/** Map a shared ValidationResult (+ parsed spec) onto the wire DTO. */
function toValidationDto(result: ReturnType<typeof parseTaskYaml>): TaskValidationResultDto {
  const issue = (i: { path: string; message: string; severity: 'error' | 'warning'; suggestion?: string }) => ({
    path: i.path,
    message: i.message,
    severity: i.severity,
    ...(i.suggestion ? { suggestion: i.suggestion } : {}),
  })
  const sessionNodeCount = result.spec?.nodes.filter((n) => n.kind === 'session').length ?? 0
  return {
    valid: result.valid,
    errors: result.errors.map(issue),
    warnings: result.warnings.map(issue),
    estimate: result.spec ? { nodeCount: result.spec.nodes.length, sessionNodeCount } : undefined,
  }
}

const GENERATE_TIMEOUT_MS = 180_000

// One initial generation plus up to one feedback-driven repair turn. Bounded so a model
// that keeps emitting invalid specs can't loop forever; the last attempt is returned as-is.
const MAX_GENERATE_ATTEMPTS = 2

/** Pull the YAML body out of an LLM reply (tolerate ```yaml fences or surrounding prose). */
function extractYaml(text: string): string {
  const fenced = text.match(/```(?:ya?ml)?\s*\n?([\s\S]*?)```/i)
  return (fenced ? fenced[1] : text).trim()
}

export interface TaskHandlerRuntimeOptions {
  killSwitchRegistry?: DurableKillSwitchRegistry;
  onKillSwitchActivated?: () => Promise<number> | number;
}

export function registerTasksHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  runtimeOptions: TaskHandlerRuntimeOptions = {},
): void {
  // One Conductor per workspace, created on demand. Holds active runs in memory.
  const runners = new Map<string, TaskRunner>()
  const runnerPromises = new Map<string, Promise<TaskRunner>>()
  const killSwitchRegistry = runtimeOptions.killSwitchRegistry ?? new DurableKillSwitchRegistry(
    join(resolveConfigDir(), 'governance', 'kill-switches.jsonl'),
  )

  function workspaceOrThrow(workspaceId: string) {
    const ws = getWorkspaceByNameOrId(workspaceId)
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`)
    return ws
  }

  function authorizeTaskAction(
    context: RequestContext,
    workspaceId: string,
    action: SpaceAction,
  ) {
    assertRequestWorkspace(context, workspaceId)
    const workspace = workspaceOrThrow(workspaceId)
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) throw new Error(`Failed to load workspace config: ${workspaceId}`)
    const governance = config.governance
      ? WorkspaceGovernanceProfileSchema.parse(config.governance)
      : createDefaultWorkspaceGovernance({
          workspaceId: config.id,
          workspaceName: config.name,
          createdAt: new Date(config.createdAt).toISOString(),
        })
    assertSpaceAction(governance.space, context.actorId, action)
    return workspace
  }

  async function runnerFor(workspaceId: string): Promise<TaskRunner> {
    let runner = runners.get(workspaceId)
    if (runner) return runner
    const pending = runnerPromises.get(workspaceId)
    if (pending) return pending

    const creation = (async () => {
      const ws = workspaceOrThrow(workspaceId)
      const proofIssuer = await loadWorkspaceExecutionProofIssuer(ws.id)
      runner = new TaskRunner({
        host: deps.sessionManager,
        workspaceId: ws.id,
        workspaceRoot: ws.rootPath,
        getKillSwitch: () => killSwitchRegistry.taskSnapshot(),
        executionGuard: createProductionTaskExecutionGuard(ws.rootPath),
        resolveSubagentAutonomyContext: (parentSessionId) => {
          const workspaceConfig = loadWorkspaceConfig(ws.rootPath)
          const parent = parentSessionId
            ? deps.sessionManager.getSessions(ws.id).find((session) => session.id === parentSessionId)
            : undefined
          return {
            workspacePermissionMode: workspaceConfig?.defaults?.permissionMode,
            // A supplied-but-missing parent is not permission to fall back to
            // a more permissive workspace default.
            parentPermissionMode: parentSessionId ? (parent?.permissionMode ?? 'safe') : undefined,
            externalActionPolicy: workspaceConfig?.defaults?.externalActionPolicy,
          }
        },
        defaultRetry: DEFAULT_AUTONOMOUS_RETRY_POLICY,
        resolveNodeRoute: (context) => {
          const workspaceConfig = loadWorkspaceConfig(ws.rootPath)
          return resolveTaskNodeExecutionRoute({
            ...context,
            connections: getLlmConnections(),
            routingPolicy: workspaceConfig?.routingPolicy,
            defaultConnectionSlug:
              workspaceConfig?.defaults?.defaultLlmConnection ?? getDefaultLlmConnection() ?? undefined,
          })
        },
        verifyExecutionProof: (proof, binding) => proofIssuer.verifyForTask(proof, binding),
      })
      runners.set(workspaceId, runner)
      try {
        const recovered = runner.recoverNonTerminalRuns()
        if (recovered.length > 0) {
          tasksLog.info('recovered durable task runs', {
            workspaceId: ws.id,
            runs: recovered.map((snapshot) => `${snapshot.slug}:${snapshot.runId}:${snapshot.status}`),
          })
        }
      } catch (err) {
        tasksLog.error('durable task recovery failed closed', {
          workspaceId: ws.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return runner
    })()
    runnerPromises.set(workspaceId, creation)
    try {
      return await creation
    } finally {
      runnerPromises.delete(workspaceId)
    }
  }

  async function durableTaskFor(
    workspaceId: string,
    slug: string,
    runId?: string,
  ): Promise<DurableTaskSnapshotDto> {
    const ws = workspaceOrThrow(workspaceId)
    const loaded = loadTaskSpec(ws.rootPath, slug)
    if (!loaded?.spec || !loaded.valid) throw new Error(`Task "${slug}" has no valid task.yaml`)
    const proofIssuer = await loadWorkspaceExecutionProofIssuer(ws.id)
    return buildDurableTaskSnapshot(ws.rootPath, slug, loaded.spec, {
      runId,
      workspaceId: ws.id,
      verifyExecutionProof: (proof, binding) => proofIssuer.verifyForTask(proof, binding),
    })
  }

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
      return { slug: spec.id, orchestratorSessionId, validation, taskLabelId: applied?.labelId }
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
          spec: parsed.spec,
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

  // tasks:run — start a run.
  server.handle(RPC_CHANNELS.tasks.RUN, async (ctx, workspaceId: string, req: TaskRunRequest) => {
    authorizeTaskAction(ctx, workspaceId, 'mission.run')
    return (await runnerFor(workspaceId)).run(req.slug, {
      runId: req.runId,
      orchestratorSessionId: req.orchestratorSessionId,
      params: req.params,
    })
  })

  server.handle(RPC_CHANNELS.tasks.REPAIR, async (ctx, workspaceId: string, req: TaskRepairRequest) => {
    authorizeTaskAction(ctx, workspaceId, 'mission.run')
    return (await runnerFor(workspaceId)).repair(req.slug, req.sourceRunId, req.nodeIds, {
      runId: req.runId,
      orchestratorSessionId: req.orchestratorSessionId,
      approveExternalMutations: req.approveExternalMutations,
    })
  })

  server.handle(RPC_CHANNELS.tasks.PAUSE, async (ctx, workspaceId: string, slug: string, runId: string) => {
    authorizeTaskAction(ctx, workspaceId, 'mission.cancel')
    ;(await runnerFor(workspaceId)).pause(slug, runId)
  })

  server.handle(RPC_CHANNELS.tasks.RESUME, async (ctx, workspaceId: string, slug: string, runId: string) => {
    authorizeTaskAction(ctx, workspaceId, 'mission.run')
    ;(await runnerFor(workspaceId)).resume(slug, runId)
  })

  server.handle(RPC_CHANNELS.tasks.STOP, async (ctx, workspaceId: string, slug: string, runId: string) => {
    authorizeTaskAction(ctx, workspaceId, 'mission.cancel')
    await (await runnerFor(workspaceId)).stop(slug, runId)
  })

  server.handle(
    RPC_CHANNELS.tasks.LIST_APPROVALS,
    async (ctx, workspaceId: string, slug?: string, runId?: string): Promise<TaskApprovalRequestDto[]> => {
      authorizeTaskAction(ctx, workspaceId, 'mission.read')
      return (await runnerFor(workspaceId)).listPendingApprovals(slug, runId)
    },
  )

  server.handle(
    RPC_CHANNELS.tasks.RESOLVE_APPROVAL,
    async (ctx, workspaceId: string, req: TaskApprovalDecisionRequest) => {
      authorizeTaskAction(ctx, workspaceId, 'mission.approve')
      return (await runnerFor(workspaceId)).resolveApproval(
        req.slug,
        req.runId,
        req.requestId,
        req.decision,
        ctx.actorId,
        req.comment,
      )
    },
  )

  server.handle(
    RPC_CHANNELS.tasks.GET_KILL_SWITCHES,
    async (ctx, workspaceId: string): Promise<TaskKillSwitchSnapshotDto> => {
      authorizeTaskAction(ctx, workspaceId, 'mission.read')
      return killSwitchRegistry.snapshot()
    },
  )

  server.handle(
    RPC_CHANNELS.tasks.SET_KILL_SWITCH,
    async (
      ctx,
      workspaceId: string,
      request: TaskKillSwitchUpdateRequest,
    ): Promise<TaskKillSwitchSnapshotDto> => {
      authorizeTaskAction(ctx, workspaceId, 'mission.kill-switch')
      if (request.scope === 'workspace' && request.id !== workspaceId) {
        throw new Error('Workspace kill switch must target the authenticated workspace')
      }
      if (request.scope === 'global' && (ctx.allowedWorkspaceIds !== '*' || !ctx.roles.includes('owner'))) {
        throw new Error('Global kill switch requires an authoritative global owner')
      }
      const snapshot = killSwitchRegistry.set({
        scope: request.scope,
        active: request.active,
        ...(request.id ? { id: request.id } : {}),
        reason: request.reason,
        actorId: ctx.actorId,
        ...(request.expectedGeneration !== undefined
          ? { expectedGeneration: request.expectedGeneration }
          : {}),
      })
      if (request.active) {
        let stopped = 0
        for (const runner of runners.values()) stopped += runner.enforceKillSwitches()
        const stoppedMissions = await runtimeOptions.onKillSwitchActivated?.() ?? 0
        tasksLog.warn('kill switch activated', {
          scope: request.scope,
          id: request.id,
          actorId: ctx.actorId,
          generation: snapshot.generation,
          stoppedRuns: stopped,
          stoppedMissions,
        })
      }
      return snapshot
    },
  )

  // tasks:get — spec + (optional) active run-state.
  server.handle(RPC_CHANNELS.tasks.GET, async (ctx, workspaceId: string, slug: string, runId?: string): Promise<TaskGetResult> => {
    const ws = authorizeTaskAction(ctx, workspaceId, 'playbook.read')
    const loaded = loadTaskSpec(ws.rootPath, slug)
    if (!loaded) {
      return {
        slug,
        validation: { valid: false, errors: [{ path: 'root', message: `Task "${slug}" not found`, severity: 'error' }], warnings: [] },
        run: null,
      }
    }
    const run = runId ? (await runnerFor(workspaceId)).getRunState(slug, runId) : null
    const task = loaded.spec ? await durableTaskFor(workspaceId, slug, runId) : undefined
    return { slug, validation: toValidationDto(loaded), spec: loaded.spec, run, task }
  })

  // tasks:list — slugs with a task.yaml.
  server.handle(RPC_CHANNELS.tasks.LIST, async (ctx, workspaceId: string): Promise<string[]> => {
    return listTaskSlugs(authorizeTaskAction(ctx, workspaceId, 'playbook.read').rootPath)
  })

  server.handle(
    RPC_CHANNELS.tasks.LIST_DURABLE,
    async (ctx, workspaceId: string, includeArchived = false): Promise<DurableTaskSnapshotDto[]> => {
      const root = authorizeTaskAction(ctx, workspaceId, 'playbook.read').rootPath
      const snapshots: DurableTaskSnapshotDto[] = []
      for (const slug of listTaskSlugs(root)) {
        const task = await durableTaskFor(workspaceId, slug)
        if (includeArchived || !task.archived) snapshots.push(task)
      }
      return snapshots
    },
  )

  server.handle(
    RPC_CHANNELS.tasks.UPDATE_METADATA,
    async (
      ctx,
      workspaceId: string,
      request: DurableTaskMetadataUpdateRequest,
    ): Promise<DurableTaskSnapshotDto> => {
      const ws = authorizeTaskAction(ctx, workspaceId, 'playbook.update')
      const loaded = loadTaskSpec(ws.rootPath, request.slug)
      if (!loaded?.spec || !loaded.valid) throw new Error(`Task "${request.slug}" has no valid task.yaml`)
      const before = await durableTaskFor(workspaceId, request.slug)
      if (
        request.archived === true
        && ['running', 'paused', 'waiting-approval', 'verifying'].includes(before.status)
      ) {
        throw new Error(`Cannot archive active task "${request.slug}" (${before.status}); stop the run first`)
      }
      const orchestratorId = before.linkedSessions.orchestratorSessionId
      if (request.archived === true && orchestratorId) await deps.sessionManager.archiveSession(orchestratorId)
      else if (request.archived === false && orchestratorId) await deps.sessionManager.unarchiveSession(orchestratorId)
      try {
        updateDurableTaskMetadata(ws.rootPath, request.slug, {
          expectedRevision: request.expectedRevision,
          archived: request.archived,
          nextAction: request.nextAction,
          externalRefs: request.externalRefs,
        })
      } catch (error) {
        // Keep the session tile and canonical metadata convergent if a guarded
        // metadata write loses a race after the session mutation succeeded.
        if (request.archived === true && orchestratorId) await deps.sessionManager.unarchiveSession(orchestratorId).catch(() => {})
        else if (request.archived === false && orchestratorId) await deps.sessionManager.archiveSession(orchestratorId).catch(() => {})
        throw error
      }
      return durableTaskFor(workspaceId, request.slug)
    },
  )

  server.handle(
    RPC_CHANNELS.tasks.GET_COCKPIT_PROJECTIONS,
    async (ctx, workspaceId: string, slug: string): Promise<DurableTaskCockpitProjectionsDto> => {
      authorizeTaskAction(ctx, workspaceId, 'mission.read')
      return projectDurableTaskToCockpits(await durableTaskFor(workspaceId, slug))
    },
  )

  // tasks:getResults — storage-backed read of a run's outcome (verdict + per-node output).
  // Reads the durable artifacts (run-log.jsonl, nodes/<id>.json, per-run spec.json snapshot), so it
  // works after restart and without an active in-memory run — unlike tasks:get's run snapshot.
  server.handle(RPC_CHANNELS.tasks.GET_RESULTS, async (ctx, workspaceId: string, slug: string, runId?: string): Promise<TaskResultsDto> => {
    const root = authorizeTaskAction(ctx, workspaceId, 'mission.read').rootPath
    const runIds = listRunIds(root, slug)
    const chosen = runId ?? runIds.at(-1) ?? null
    const loadedSpec = loadTaskSpec(root, slug)?.spec
    const durableTask = loadedSpec
      ? await durableTaskFor(workspaceId, slug, chosen ?? undefined)
      : undefined
    if (!chosen) return { slug, runId: null, runIds, ...(durableTask ? { task: durableTask } : {}), nodes: [] }

    const log = readRunLog(root, slug, chosen)

    // Node titles come from the run-time spec snapshot (so historical runs aren't relabeled by a
    // later edit). Older runs predate snapshots → fall back to the run-log node ids.
    const snapshot = readRunSpecSnapshot(root, slug, chosen)
    const titleById = new Map<string, string>()
    if (snapshot) for (const n of snapshot.nodes) titleById.set(n.id, nodeTitle(n))

    // Fold the append-only log into the latest per-node state + session id, preserving first-seen
    // order. node-spawned/node-finished both carry sessionId; the last one wins.
    const byId = new Map<string, { id: string; state: string; sessionId?: string }>()
    const attemptsById = new Map<string, number>()
    const proofById = new Map<string, string>()
    const ensure = (id: string) => {
      let e = byId.get(id)
      if (!e) { e = { id, state: 'pending' }; byId.set(id, e) }
      return e
    }
    const verdicts: NonNullable<TaskResultsDto['verdicts']> = []
    // Recover the terminal run status from the run-log's lifecycle markers (last one wins).
    let runStatus: string | undefined
    for (const entry of log) {
      if (entry.kind === 'node-scheduled' || entry.kind === 'node-spawned') {
        const e = ensure(entry.nodeId)
        e.state = 'running'
        if (entry.kind === 'node-spawned') e.sessionId = entry.sessionId
        else attemptsById.set(entry.nodeId, (attemptsById.get(entry.nodeId) ?? 0) + 1)
      } else if (entry.kind === 'node-finished') {
        const e = ensure(entry.nodeId)
        e.state = entry.state
        if (entry.sessionId) e.sessionId = entry.sessionId
      } else if (entry.kind === 'approval-requested') {
        ensure(entry.nodeId).state = 'waiting-approval'
        runStatus = 'waiting-approval'
      } else if (entry.kind === 'approval-resolved') {
        const e = ensure(entry.nodeId)
        e.state = entry.decision === 'approved' ? 'pending' : 'failed'
        runStatus = entry.decision === 'approved' ? 'running' : 'failed'
      } else if (entry.kind === 'node-reused') {
        ensure(entry.nodeId).state = 'done'
        if (entry.proofHash) proofById.set(entry.nodeId, entry.proofHash)
      } else if (entry.kind === 'node-checkpoint' && entry.status === 'confirmed') {
        if (entry.proofHash) proofById.set(entry.nodeId, entry.proofHash)
      } else if (entry.kind === 'verdict') {
        verdicts.push({
          result: entry.result,
          ...(entry.reason ? { reason: entry.reason } : {}),
          ...(entry.nodes?.length ? { nodes: entry.nodes } : {}),
        })
      } else if (entry.kind === 'run-completed') {
        runStatus = 'completed'
      } else if (entry.kind === 'run-failed') {
        runStatus = 'failed'
      } else if (entry.kind === 'run-stopped') {
        runStatus = 'stopped'
      } else if (entry.kind === 'run-verifying') {
        runStatus = 'verifying'
      }
    }

    // Repair accounting: each FAIL verdict consumed one repair attempt; the cap is the per-run
    // snapshot's max_iterations clamped to the shared bound (default when omitted).
    const repairUsed = verdicts.filter((v) => v.result === 'fail').length
    const repairMax = Math.min(snapshot?.max_iterations ?? DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP)
    const reportSpec = snapshot ?? loadTaskSpec(root, slug)?.spec
    const lastUsage = [...log].reverse().find((entry) => entry.kind === 'usage-updated')
    const governanceResult = WorkspaceGovernanceProfileSchema.safeParse(loadWorkspaceConfig(root)?.governance)
    const governanceBudgets = governanceResult.success ? governanceResult.data.budgets : undefined
    const usageCurrency = lastUsage?.kind === 'usage-updated' ? lastUsage.currency : undefined
    const workspaceMaxCost = usageCurrency == null || usageCurrency === 'USD'
      ? governanceBudgets?.missionMaxCostUsd
      : undefined
    const controlRoom = reportSpec
      ? buildMissionControlSnapshot(reportSpec, chosen, log, {
          ...(lastUsage?.kind === 'usage-updated' ? {
            tokensUsed: lastUsage.tokensUsed,
            ...(lastUsage.costUsed != null ? { costUsed: lastUsage.costUsed } : {}),
            ...(lastUsage.currency ? { currency: lastUsage.currency } : {}),
          } : {}),
          ...(governanceBudgets?.missionMaxTokens != null ? { maxTokens: governanceBudgets.missionMaxTokens } : {}),
          ...(workspaceMaxCost != null ? { maxCost: workspaceMaxCost, currency: 'USD' as const } : {}),
          ...(governanceBudgets?.warningPercent != null ? { warningPercent: governanceBudgets.warningPercent } : {}),
        })
      : undefined
    const replayPlan = reportSpec
      ? planMissionReplay(reportSpec, chosen, log, (nodeId) => readNodeOutput(root, slug, chosen, nodeId))
      : undefined
    const replayById = new Map(replayPlan?.nodes.map((node) => [node.nodeId, node]))
    const specNodeById = new Map(reportSpec?.nodes.map((node) => [node.id, node]))
    const nodes: TaskResultNodeDto[] = [...byId.values()].map((e) => {
      const out = readNodeOutput(root, slug, chosen, e.id)
      const replay = replayById.get(e.id)
      return {
        id: e.id,
        title: titleById.get(e.id) ?? e.id,
        state: e.state,
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(out?.text ? { output: out.text } : {}),
        dependsOn: [...(specNodeById.get(e.id)?.depends_on ?? [])],
        attempt: attemptsById.get(e.id) ?? 0,
        ...(proofById.get(e.id) ? { proofHash: proofById.get(e.id) } : {}),
        evidenceRefs: [
          `tasks/${slug}/runs/${chosen}/run-log.jsonl#node=${e.id}`,
          ...(out ? [`tasks/${slug}/runs/${chosen}/nodes/${e.id}.json`] : []),
        ],
        repair: {
          allowed: replay ? replay.action !== 'block' : false,
          reason: replay?.reason ?? 'No safe replay decision is available.',
        },
      }
    })
    const baseReport = controlRoom ? exportMissionReportMarkdown(controlRoom) : undefined
    const evidenceReport = baseReport && durableTask
      ? `${baseReport}\n## User-visible proof\n\n- Action requested: ${durableTask.userEvidence.actionRequested}\n- Action attempted: ${durableTask.userEvidence.actionAttempted.join('; ') || 'None recorded'}\n- Mutation applied: ${durableTask.userEvidence.mutationsApplied.join('; ') || 'None recorded'}\n- Real verification: ${durableTask.userEvidence.userVerification}\n- Remaining limitation: ${durableTask.userEvidence.remainingLimitations.join('; ') || 'None'}\n`
      : baseReport

    return {
      slug,
      runId: chosen,
      runIds,
      verdict: verdicts.at(-1),
      verdicts,
      repair: { used: repairUsed, max: repairMax },
      ...(runStatus ? { runStatus } : {}),
      ...(snapshot?.acceptance_criteria ? { acceptanceCriteria: snapshot.acceptance_criteria } : {}),
      ...(controlRoom ? { controlRoom, ...(evidenceReport ? { reportMarkdown: evidenceReport } : {}) } : {}),
      ...(replayPlan ? { replayPlan } : {}),
      ...(durableTask ? { task: durableTask } : {}),
      ...(durableTask ? { userEvidence: durableTask.userEvidence } : {}),
      nodes,
    }
  })
}
