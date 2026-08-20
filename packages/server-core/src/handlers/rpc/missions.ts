import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  WorkspaceGovernanceProfileSchema,
  assertSpaceAction,
  createDefaultWorkspaceGovernance,
  type SpaceAction,
} from '@craft-agent/shared/governance'
import {
  RPC_CHANNELS,
  type MissionControlRequest,
  type MissionCreateAndStartRequest,
  type MissionPlanAck,
  type MissionPlanRequest,
  type MissionPlanResult,
  type MissionResumeRequest,
  type MissionSnapshotDto,
} from '@craft-agent/shared/protocol'
import { createLogger } from '@craft-agent/shared/utils'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import {
  assertRequestWorkspace,
  pushTyped,
  type RequestContext,
  type RpcServer,
} from '@craft-agent/server-core/transport'
import { MissionPlanner, MissionRuntimeService } from '../../missions/index.ts'
import type { HandlerDeps } from '../handler-deps.ts'

const missionsLog = createLogger('missions-v2')

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.missions.PLAN,
  RPC_CHANNELS.missions.GET_PLAN,
  RPC_CHANNELS.missions.CREATE_AND_START,
  RPC_CHANNELS.missions.GET,
  RPC_CHANNELS.missions.LIST,
  RPC_CHANNELS.missions.PAUSE,
  RPC_CHANNELS.missions.RESUME,
  RPC_CHANNELS.missions.CANCEL,
] as const

export function registerMissionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const planners = new Map<string, MissionPlanner>()
  const resolveSubagentAutonomyContext = (
    workspace: { id: string; rootPath: string },
    parentSessionId?: string,
  ) => {
    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath)
    const parent = parentSessionId
      ? deps.sessionManager.getSessions(workspace.id).find((session) => session.id === parentSessionId)
      : undefined
    return {
      workspacePermissionMode: workspaceConfig?.defaults?.permissionMode,
      // Missing/stale parent references fail closed instead of inheriting a
      // potentially more permissive workspace default.
      parentPermissionMode: parentSessionId ? (parent?.permissionMode ?? 'safe') : undefined,
      externalActionPolicy: workspaceConfig?.defaults?.externalActionPolicy,
    }
  }
  const service = new MissionRuntimeService({
    sessionManager: deps.sessionManager,
    resolveSubagentAutonomyContext,
    onSnapshot: (workspaceId, snapshot) => {
      pushTyped(
        server,
        RPC_CHANNELS.missions.CHANGED,
        { to: 'workspace', workspaceId },
        workspaceId,
        snapshot,
      )
    },
    onError: ({ workspaceId, missionId, workItemId, error }) => {
      missionsLog.error('mission runtime failure', {
        workspaceId,
        missionId,
        workItemId,
        error: error.message,
      })
    },
  })

  // Core registration precedes SessionManager hydration. The service waits on
  // that barrier, then reconstructs every active workspace mission.
  if (typeof deps.sessionManager.waitForInit === 'function') {
    void service.start().then((recovered) => {
      if (recovered.length > 0) missionsLog.info('recovered durable missions', { missions: recovered })
    }).catch((error: unknown) => {
      missionsLog.error('mission startup recovery failed closed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  function authorizeMissionAction(
    context: RequestContext,
    workspaceId: string,
    action: SpaceAction,
  ) {
    assertRequestWorkspace(context, workspaceId)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
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

  function plannerFor(workspace: { id: string; rootPath: string }): MissionPlanner {
    const existing = planners.get(workspace.id)
    if (existing) return existing
    const planner = new MissionPlanner({
      host: deps.sessionManager,
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      resolveSubagentAutonomyContext: (parentSessionId) =>
        resolveSubagentAutonomyContext(workspace, parentSessionId),
    })
    planners.set(workspace.id, planner)
    return planner
  }

  server.handle(
    RPC_CHANNELS.missions.PLAN,
    async (ctx, workspaceId: string, request: MissionPlanRequest): Promise<MissionPlanAck> => {
      const workspace = authorizeMissionAction(ctx, workspaceId, 'mission.run')
      const started = await plannerFor(workspace).start(request)
      void started.result.then((result) => {
        pushTyped(
          server,
          RPC_CHANNELS.missions.PLANNED,
          { to: 'workspace', workspaceId },
          workspaceId,
          result,
        )
      }).catch((error: unknown) => {
        missionsLog.error('mission planning failed after acceptance', {
          workspaceId,
          plannerSessionId: started.ack.plannerSessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return started.ack
    },
  )

  server.handle(
    RPC_CHANNELS.missions.GET_PLAN,
    async (ctx, workspaceId: string, plannerSessionId: string): Promise<MissionPlanResult> => {
      const workspace = authorizeMissionAction(ctx, workspaceId, 'mission.read')
      return plannerFor(workspace).getPlan(plannerSessionId)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.CREATE_AND_START,
    async (ctx, workspaceId: string, request: MissionCreateAndStartRequest): Promise<MissionSnapshotDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.run')
      return service.createAndStart(workspaceId, request.spec)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.GET,
    async (ctx, workspaceId: string, missionId: string): Promise<MissionSnapshotDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.read')
      return service.getMission(workspaceId, missionId)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.LIST,
    async (ctx, workspaceId: string): Promise<MissionSnapshotDto[]> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.read')
      return service.listMissions(workspaceId)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.PAUSE,
    async (ctx, workspaceId: string, request: MissionControlRequest): Promise<MissionSnapshotDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.cancel')
      return service.pauseMission(workspaceId, request.missionId, requireReason(request.reason))
    },
  )

  server.handle(
    RPC_CHANNELS.missions.RESUME,
    async (ctx, workspaceId: string, request: MissionResumeRequest): Promise<MissionSnapshotDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.run')
      return service.resumeMission(workspaceId, request.missionId)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.CANCEL,
    async (ctx, workspaceId: string, request: MissionControlRequest): Promise<MissionSnapshotDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.cancel')
      return service.cancelMission(workspaceId, request.missionId, requireReason(request.reason))
    },
  )
}

function requireReason(reason: string): string {
  const normalized = reason?.trim()
  if (!normalized) throw new Error('A non-empty mission control reason is required')
  return normalized
}
