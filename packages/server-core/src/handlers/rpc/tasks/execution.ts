import { RPC_CHANNELS } from '@craft-agent/shared/protocol';

import type { TaskRunRequest, TaskRepairRequest, TaskApprovalRequestDto, TaskApprovalDecisionRequest, TaskKillSwitchSnapshotDto } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';


import { DurableKillSwitchRegistry, type SpaceAction } from '@craft-agent/shared/governance';


import { type RequestContext, type RpcServer } from '@craft-agent/server-core/transport';

import { TaskRunner } from "../../../tasks";

export function registerTaskExecutionHandlers(server: RpcServer, authorizeTaskAction: (context: RequestContext, workspaceId: string, action: SpaceAction) => NonNullable<ReturnType<typeof getWorkspaceByNameOrId>>, runnerFor: (workspaceId: string) => Promise<TaskRunner>, killSwitchRegistry: DurableKillSwitchRegistry): void {

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
      ...(req.approveExternalMutations !== undefined ? { approveExternalMutations: req.approveExternalMutations } : {}),
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
}
