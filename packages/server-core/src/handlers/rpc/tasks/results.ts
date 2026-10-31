import { omitUndefined } from '@craft-agent/shared/utils/json';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';

import type { TaskValidationResultDto, TaskGetResult, TaskResultsDto, TaskResultNodeDto, DurableTaskSnapshotDto, DurableTaskMetadataUpdateRequest, DurableTaskCockpitProjectionsDto } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';

import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { WorkspaceGovernanceProfileSchema, type SpaceAction } from '@craft-agent/shared/governance';
import { parseTaskYaml, loadTaskSpec, listTaskSlugs, listRunIds, readRunLog, readNodeOutput, readRunSpecSnapshot, nodeTitle, DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP, buildMissionControlSnapshot, planMissionReplay, exportMissionReportMarkdown, updateDurableTaskMetadata, projectDurableTaskToCockpits } from '@craft-agent/shared/tasks';

import { type RequestContext, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from "../../handler-deps";
import { TaskRunner } from "../../../tasks";

export function registerTaskResultHandlers(server: RpcServer, deps: HandlerDeps, authorizeTaskAction: (context: RequestContext, workspaceId: string, action: SpaceAction) => NonNullable<ReturnType<typeof getWorkspaceByNameOrId>>, runnerFor: (workspaceId: string) => Promise<TaskRunner>, durableTaskFor: (workspaceId: string, slug: string, runId?: string) => Promise<DurableTaskSnapshotDto>, toValidationDto: (result: ReturnType<typeof parseTaskYaml>) => TaskValidationResultDto): void {

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
    return { slug, validation: toValidationDto(loaded), ...(loaded.spec !== undefined ? { spec: loaded.spec } : {}), run, ...(task !== undefined ? { task: task } : {}) }
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
          ...(request.expectedRevision !== undefined ? { expectedRevision: request.expectedRevision } : {}),
          ...(request.archived !== undefined ? { archived: request.archived } : {}),
          ...(request.nextAction !== undefined ? { nextAction: request.nextAction } : {}),
          ...(request.externalRefs !== undefined ? { externalRefs: request.externalRefs } : {}),
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
    const byId = new Map<string, { id: string; state: TaskResultNodeDto['state']; sessionId?: string }>()
    const attemptsById = new Map<string, number>()
    const proofById = new Map<string, string>()
    const ensure = (id: string) => {
      let e = byId.get(id)
      if (!e) { e = { id, state: 'pending' }; byId.set(id, e) }
      return e
    }
    const verdicts: NonNullable<TaskResultsDto['verdicts']> = []
    // Recover the terminal run status from the run-log's lifecycle markers (last one wins).
    let runStatus: TaskResultsDto['runStatus']
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
      const proofHash = proofById.get(e.id)
      return {
        id: e.id,
        title: titleById.get(e.id) ?? e.id,
        state: e.state,
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(out?.text ? { output: out.text } : {}),
        dependsOn: [...(specNodeById.get(e.id)?.depends_on ?? [])],
        attempt: attemptsById.get(e.id) ?? 0,
        ...(proofHash ? { proofHash } : {}),
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

    return omitUndefined({
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
    })
  })
}
