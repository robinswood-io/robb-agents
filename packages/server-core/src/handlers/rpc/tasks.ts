import { registerTaskAuthoringHandlers } from "./tasks/authoring";
import { registerTaskExecutionHandlers } from "./tasks/execution";
import { registerTaskResultHandlers } from "./tasks/results";
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
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { join } from 'node:path';
import type { TaskValidationResultDto, TaskKillSwitchSnapshotDto, TaskKillSwitchUpdateRequest, DurableTaskSnapshotDto } from '@craft-agent/shared/protocol';
import { getDefaultLlmConnection, getLlmConnections, getLlmConnection, getDefaultThinkingLevel, getWorkspaceByNameOrId, resolveConfigDir, maxSourceSensitivity } from '@craft-agent/shared/config';
import { getSourcesBySlugs } from '@craft-agent/shared/sources';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { WorkspaceGovernanceProfileSchema, assertSpaceAction, createDefaultWorkspaceGovernance, DurableKillSwitchRegistry, type SpaceAction } from '@craft-agent/shared/governance';
import { parseTaskYaml, loadTaskSpec, authorizeWorkspacePath, validateExecutionIsolationPolicy, type GuardDecision, buildDurableTaskSnapshot } from '@craft-agent/shared/tasks';
import { createLogger } from '@craft-agent/shared/utils';
import { assertRequestWorkspace, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { TaskRunner, DEFAULT_AUTONOMOUS_RETRY_POLICY, loadWorkspaceExecutionProofIssuer, resolveEffectiveTaskSourceSlugs, resolveTaskNodeExecutionRoute, type TaskExecutionGuardContext } from '../../tasks';

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
      context.reviewOnly
      && (context.effect !== 'read'
        || context.permissionMode !== 'safe'
        || context.fullAutonomyInherited
        || context.policy.allowedWritePaths.length > 0)
    ) {
      return {
        allowed: false,
        reason: 'Review-only task nodes must remain Safe and read-isolated',
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
        getModelDefaults: (parentSessionId, selectedConnectionSlug) => {
          const workspaceConfig = loadWorkspaceConfig(ws.rootPath)
          const parent = parentSessionId
            ? deps.sessionManager.getSessions(ws.id).find((session) => session.id === parentSessionId)
            : undefined
          const workspaceConnection = workspaceConfig?.defaults?.defaultLlmConnection
            ?? getDefaultLlmConnection() ?? undefined
          const inheritedConnection = parent?.llmConnection ?? workspaceConnection
          const llmConnection = selectedConnectionSlug ?? inheritedConnection
          const connection = llmConnection ? getLlmConnection(llmConnection) : undefined
          return {
            llmConnection,
            model: (llmConnection === inheritedConnection ? parent?.model : undefined)
              ?? (llmConnection === workspaceConnection ? workspaceConfig?.defaults?.model : undefined)
              ?? connection?.defaultModel,
            thinkingLevel: parent?.thinkingLevel ?? workspaceConfig?.defaults?.thinkingLevel ?? getDefaultThinkingLevel(),
            connectionRoutePinned: selectedConnectionSlug !== undefined
              || (llmConnection === parent?.llmConnection && parent?.connectionRoutePinned === true),
            modelRoutePinned: llmConnection === parent?.llmConnection
              && parent?.modelRoutePinned === true,
            thinkingLevelPinned: parent?.thinkingLevelPinned === true,
          }
        },
        resolveNodeRoute: (context) => {
          const workspaceConfig = loadWorkspaceConfig(ws.rootPath)
          const effectiveSourceSlugs = resolveEffectiveTaskSourceSlugs(
            context.spec.sources,
            workspaceConfig?.defaults?.enabledSourceSlugs,
          )
          const sourceSensitivity = maxSourceSensitivity(
            getSourcesBySlugs(ws.rootPath, effectiveSourceSlugs)
              .map(source => source.config.routingSensitivity),
          )
          return resolveTaskNodeExecutionRoute({
            ...context,
            routingSensitivity: sourceSensitivity,
            sourceSlugs: effectiveSourceSlugs,
            connections: getLlmConnections(),
            costControlPolicy: workspaceConfig?.costControl,
            defaultConnectionSlug: context.defaults?.llmConnection
              ?? workspaceConfig?.defaults?.defaultLlmConnection
              ?? getDefaultLlmConnection()
              ?? undefined,
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
  registerTaskAuthoringHandlers(server, deps, authorizeTaskAction, toValidationDto, tasksLog, GENERATE_TIMEOUT_MS, MAX_GENERATE_ATTEMPTS, extractYaml)
  registerTaskExecutionHandlers(server, authorizeTaskAction, runnerFor, killSwitchRegistry)

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
  registerTaskResultHandlers(server, deps, authorizeTaskAction, runnerFor, durableTaskFor, toValidationDto)
}
