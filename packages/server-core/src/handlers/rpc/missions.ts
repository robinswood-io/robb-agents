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
  type MissionConnectorApprovalDecisionRequest,
  type MissionConnectorApprovalRefreshRequest,
  type MissionConnectorApprovalRequestDto,
  type MissionCreateAndStartRequest,
  type MissionPlanAck,
  type MissionPlanRequest,
  type MissionPlanResult,
  type MissionPreflightRequest,
  type MissionPreflightResult,
  type MissionProofPassportDto,
  type MissionProofPassportTrustAnchorDto,
  type MissionProofPassportVerificationDto,
  type MissionReplanPreviewDto,
  type MissionReplanPreviewRequest,
  type MissionReplanRequest,
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
  RPC_CHANNELS.missions.PREFLIGHT,
  RPC_CHANNELS.missions.PREVIEW_REPLAN,
  RPC_CHANNELS.missions.REPLAN,
  RPC_CHANNELS.missions.GET,
  RPC_CHANNELS.missions.LIST,
  RPC_CHANNELS.missions.LIST_CONNECTOR_APPROVALS,
  RPC_CHANNELS.missions.RESOLVE_CONNECTOR_APPROVAL,
  RPC_CHANNELS.missions.REFRESH_CONNECTOR_APPROVAL,
  RPC_CHANNELS.missions.GET_PASSPORT,
  RPC_CHANNELS.missions.GET_PASSPORT_TRUST_ANCHOR,
  RPC_CHANNELS.missions.VERIFY_PASSPORT,
  RPC_CHANNELS.missions.PAUSE,
  RPC_CHANNELS.missions.RESUME,
  RPC_CHANNELS.missions.CANCEL,
] as const

type MissionProofPassportRpcService = Pick<
  MissionRuntimeService,
  'getProofPassport' | 'getProofPassportTrustAnchor' | 'verifyProofPassport'
>

/** Register the read-only Passport surface behind one explicit Mission RBAC gate. */
export function registerMissionProofPassportHandlers(
  server: RpcServer,
  service: MissionProofPassportRpcService,
  authorize: (context: RequestContext, workspaceId: string, action: SpaceAction) => unknown,
): void {
  server.handle(
    RPC_CHANNELS.missions.GET_PASSPORT,
    async (ctx, workspaceId: string, missionId: string): Promise<MissionProofPassportDto | null> => {
      authorize(ctx, workspaceId, 'mission.read')
      return service.getProofPassport(workspaceId, missionId)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.GET_PASSPORT_TRUST_ANCHOR,
    async (ctx, workspaceId: string): Promise<MissionProofPassportTrustAnchorDto> => {
      authorize(ctx, workspaceId, 'mission.read')
      return service.getProofPassportTrustAnchor(workspaceId)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.VERIFY_PASSPORT,
    async (ctx, workspaceId: string, missionId: string): Promise<MissionProofPassportVerificationDto> => {
      authorize(ctx, workspaceId, 'mission.read')
      return service.verifyProofPassport(workspaceId, missionId)
    },
  )
}

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
    connectorExecutorFactory: deps.missionConnectorExecutorFactory,
    connectorReadiness: deps.missionConnectorReadiness,
    preflightCostEstimator: deps.missionPreflightCostEstimator,
    preflightConnections: deps.missionPreflightConnections,
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
    RPC_CHANNELS.missions.PREFLIGHT,
    async (
      ctx,
      workspaceId: string,
      request: MissionPreflightRequest,
    ): Promise<MissionPreflightResult> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.read')
      assertMissionPreflightRequest(request)
      return service.preflightMission(workspaceId, request)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.PREVIEW_REPLAN,
    async (
      ctx,
      workspaceId: string,
      request: MissionReplanPreviewRequest,
    ): Promise<MissionReplanPreviewDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.read')
      assertMissionReplanPreviewRequest(request)
      return service.previewReplan(
        workspaceId,
        request.missionId,
        request.expectedRevision,
        request.proposedWorkItems,
      )
    },
  )

  server.handle(
    RPC_CHANNELS.missions.REPLAN,
    async (
      ctx,
      workspaceId: string,
      request: MissionReplanRequest,
    ): Promise<MissionSnapshotDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.run')
      assertMissionReplanRequest(request)
      return service.replanMission({
        workspaceId,
        missionId: request.missionId,
        expectedRevision: request.expectedRevision,
        proposedWorkItems: request.proposedWorkItems,
        actorId: ctx.actorId,
        reason: request.reason,
      })
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
    RPC_CHANNELS.missions.LIST_CONNECTOR_APPROVALS,
    async (ctx, workspaceId: string): Promise<MissionConnectorApprovalRequestDto[]> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.read')
      return service.listPendingConnectorApprovals(workspaceId)
    },
  )

  server.handle(
    RPC_CHANNELS.missions.RESOLVE_CONNECTOR_APPROVAL,
    async (
      ctx,
      workspaceId: string,
      request: MissionConnectorApprovalDecisionRequest,
    ): Promise<MissionSnapshotDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.approve')
      assertConnectorApprovalDecision(request)
      return service.resolveConnectorApproval({
        workspaceId,
        missionId: request.missionId,
        workItemId: request.workItemId,
        approvalId: request.approvalId,
        requestHash: request.requestHash,
        decision: request.decision,
        // Identity is transport-authenticated and never trusted from renderer input.
        resolvedBy: ctx.actorId,
      })
    },
  )

  server.handle(
    RPC_CHANNELS.missions.REFRESH_CONNECTOR_APPROVAL,
    async (
      ctx,
      workspaceId: string,
      request: MissionConnectorApprovalRefreshRequest,
    ): Promise<MissionSnapshotDto> => {
      authorizeMissionAction(ctx, workspaceId, 'mission.approve')
      assertRequestKeys(
        request,
        ['missionId', 'workItemId'],
        'Connector approval refresh request',
      )
      assertMissionSlug(request.missionId, 'missionId')
      assertMissionSlug(request.workItemId, 'workItemId')
      return service.refreshExpiredConnectorApproval(
        workspaceId,
        request.missionId,
        request.workItemId,
      )
    },
  )

  registerMissionProofPassportHandlers(server, service, authorizeMissionAction)

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

function assertRequestKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new Error(`Unexpected ${label} fields: ${unexpected.sort().join(', ')}`)
  }
}

export function assertMissionPreflightRequest(
  request: MissionPreflightRequest,
): asserts request is MissionPreflightRequest {
  assertRequestKeys(request, ['missionId', 'spec'], 'Mission preflight request')
  const hasMissionId = typeof request.missionId === 'string'
  const hasSpec = !!request.spec && typeof request.spec === 'object'
  if (hasMissionId === hasSpec) {
    throw new Error('Mission preflight requires exactly one of missionId or spec')
  }
  if (hasMissionId) assertMissionSlug(request.missionId, 'missionId')
}

function assertMissionReplanPreviewRequest(
  request: MissionReplanPreviewRequest,
): asserts request is MissionReplanPreviewRequest {
  assertRequestKeys(
    request,
    ['missionId', 'expectedRevision', 'proposedWorkItems'],
    'Mission replan preview request',
  )
  assertMissionSlug(request.missionId, 'missionId')
  if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 1) {
    throw new Error('Invalid Mission replan expectedRevision')
  }
  if (!Array.isArray(request.proposedWorkItems)) {
    throw new Error('Invalid Mission replan proposedWorkItems')
  }
}

function assertMissionReplanRequest(
  request: MissionReplanRequest,
): asserts request is MissionReplanRequest {
  assertRequestKeys(
    request,
    ['missionId', 'expectedRevision', 'proposedWorkItems', 'reason'],
    'Mission replan request',
  )
  assertMissionSlug(request.missionId, 'missionId')
  if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 1) {
    throw new Error('Invalid Mission replan expectedRevision')
  }
  if (!Array.isArray(request.proposedWorkItems)) {
    throw new Error('Invalid Mission replan proposedWorkItems')
  }
  requireReason(request.reason)
}

function assertMissionSlug(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertConnectorApprovalDecision(
  request: MissionConnectorApprovalDecisionRequest,
): void {
  assertRequestKeys(
    request,
    ['missionId', 'workItemId', 'approvalId', 'requestHash', 'decision'],
    'Connector approval decision request',
  )
  assertMissionSlug(request.missionId, 'missionId')
  assertMissionSlug(request.workItemId, 'workItemId')
  if (typeof request.approvalId !== 'string' || request.approvalId.length < 1 || request.approvalId.length > 256) {
    throw new Error('Invalid connector approvalId')
  }
  if (typeof request.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.requestHash)) {
    throw new Error('Invalid connector requestHash')
  }
  if (request.decision !== 'approved' && request.decision !== 'denied') {
    throw new Error('Invalid connector approval decision')
  }
}
