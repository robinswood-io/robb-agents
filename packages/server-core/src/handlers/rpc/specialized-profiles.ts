import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  WorkspaceGovernanceProfileSchema,
  assertSpaceAction,
  createDefaultWorkspaceGovernance,
  type SpaceAction,
} from '@craft-agent/shared/governance'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  SPECIALIZED_PROFILE_STATES,
  SpecializedProfileEvaluationSchema,
  type CreateSpecializedProfileDraftRequest,
  type RecordSpecializedProfileEvaluationRequest,
  type RollbackSpecializedProfileRequest,
  type SpecializedProfileAnalysisResult,
  type SpecializedProfileRegistryDocument,
  type SpecializedProfileRegistryMutationResult,
  type SpecializedProfileState,
  type TransitionSpecializedProfileRequest,
} from '@craft-agent/shared/specialized-profiles'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import {
  assertRequestWorkspace,
  pushTyped,
  type RequestContext,
  type RpcServer,
} from '@craft-agent/server-core/transport'
import type { SpecializedProfileService } from '../../specialized-profiles/index.ts'

export const SPECIALIZED_PROFILE_HANDLED_CHANNELS = [
  RPC_CHANNELS.specializedProfiles.ANALYZE,
  RPC_CHANNELS.specializedProfiles.GET_REGISTRY,
  RPC_CHANNELS.specializedProfiles.CREATE_DRAFT,
  RPC_CHANNELS.specializedProfiles.TRANSITION,
  RPC_CHANNELS.specializedProfiles.RECORD_EVALUATION,
  RPC_CHANNELS.specializedProfiles.ROLLBACK,
] as const

type SpecializedProfileRpcService = Pick<
  SpecializedProfileService,
  'analyze' | 'getRegistry' | 'createDraft' | 'transition' | 'recordEvaluation' | 'rollback'
>

type AuthorizeSpecializedProfileAction = (
  context: RequestContext,
  workspaceId: string,
  action: SpaceAction,
) => unknown

/**
 * Register the workspace-scoped profile foundry surface. Every mutation is
 * authorized before request data reaches the durable registry.
 */
export function registerSpecializedProfileHandlers(
  server: RpcServer,
  service: SpecializedProfileRpcService,
  authorize: AuthorizeSpecializedProfileAction = authorizeSpecializedProfileAction,
): void {
  const pushRevision = (workspaceId: string, revision: number) => {
    pushTyped(
      server,
      RPC_CHANNELS.specializedProfiles.CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
      revision,
    )
  }
  const pushRegistry = (workspaceId: string, result: SpecializedProfileRegistryMutationResult) => {
    pushRevision(workspaceId, result.registry.revision)
    return result
  }

  server.handle(
    RPC_CHANNELS.specializedProfiles.ANALYZE,
    async (ctx, workspaceId: string): Promise<SpecializedProfileAnalysisResult> => {
      authorize(ctx, workspaceId, 'mission.read')
      return service.analyze(workspaceId)
    },
  )

  server.handle(
    RPC_CHANNELS.specializedProfiles.GET_REGISTRY,
    async (ctx, workspaceId: string): Promise<SpecializedProfileRegistryDocument> => {
      authorize(ctx, workspaceId, 'playbook.read')
      return service.getRegistry(
        workspaceId,
        ctx.actorId,
        (registry) => pushRevision(workspaceId, registry.revision),
      )
    },
  )

  server.handle(
    RPC_CHANNELS.specializedProfiles.CREATE_DRAFT,
    async (
      ctx,
      workspaceId: string,
      value: CreateSpecializedProfileDraftRequest,
    ): Promise<SpecializedProfileRegistryMutationResult> => {
      authorize(ctx, workspaceId, 'playbook.update')
      const request = parseCreateDraftRequest(value)
      return pushRegistry(workspaceId, await service.createDraft(workspaceId, ctx.actorId, request))
    },
  )

  server.handle(
    RPC_CHANNELS.specializedProfiles.TRANSITION,
    async (
      ctx,
      workspaceId: string,
      value: TransitionSpecializedProfileRequest,
    ): Promise<SpecializedProfileRegistryMutationResult> => {
      authorize(ctx, workspaceId, 'playbook.update')
      const request = parseTransitionRequest(value)
      if (PROMOTION_STATES.has(request.to)) {
        throw new Error(
          'Promotion requires a distinct host-attested human approval flow; this RPC cannot synthesize human approval',
        )
      }
      return pushRegistry(workspaceId, await service.transition(workspaceId, ctx.actorId, request))
    },
  )

  server.handle(
    RPC_CHANNELS.specializedProfiles.RECORD_EVALUATION,
    async (
      ctx,
      workspaceId: string,
      value: RecordSpecializedProfileEvaluationRequest,
    ): Promise<SpecializedProfileRegistryMutationResult> => {
      authorize(ctx, workspaceId, 'mission.approve')
      const request = parseRecordEvaluationRequest(value)
      if (request.evaluation.evaluator.actorId !== ctx.actorId) {
        throw new Error('The evaluation actor must match the authenticated RPC actor')
      }
      return pushRegistry(workspaceId, await service.recordEvaluation(workspaceId, ctx.actorId, request))
    },
  )

  server.handle(
    RPC_CHANNELS.specializedProfiles.ROLLBACK,
    async (
      ctx,
      workspaceId: string,
      value: RollbackSpecializedProfileRequest,
    ): Promise<SpecializedProfileRegistryMutationResult> => {
      authorize(ctx, workspaceId, 'playbook.update')
      const request = parseRollbackRequest(value)
      return pushRegistry(workspaceId, await service.rollback(workspaceId, ctx.actorId, request))
    },
  )
}

function authorizeSpecializedProfileAction(
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

const PROMOTION_STATES = new Set<SpecializedProfileState>(['opt-in', 'canary', 'default'])
const PROFILE_STATES = new Set<string>(SPECIALIZED_PROFILE_STATES)

function parseCreateDraftRequest(value: unknown): CreateSpecializedProfileDraftRequest {
  const request = requireRecord(value, ['proposalId', 'expectedRegistryRevision'], 'profile draft request')
  return {
    proposalId: requireString(request.proposalId, 'proposalId', 512),
    expectedRegistryRevision: requireNonNegativeInteger(
      request.expectedRegistryRevision,
      'expectedRegistryRevision',
    ),
  }
}

function parseTransitionRequest(value: unknown): TransitionSpecializedProfileRequest {
  const request = requireRecord(
    value,
    ['profileId', 'expectedRegistryRevision', 'expectedCurrentVersion', 'to', 'reason', 'evaluationIds'],
    'profile transition request',
  )
  if (typeof request.to !== 'string' || !PROFILE_STATES.has(request.to)) {
    throw new Error('Invalid specialized profile state')
  }
  if (request.evaluationIds !== undefined && !Array.isArray(request.evaluationIds)) {
    throw new Error('evaluationIds must be an array')
  }
  return {
    profileId: requireSlug(request.profileId, 'profileId'),
    expectedRegistryRevision: requireNonNegativeInteger(
      request.expectedRegistryRevision,
      'expectedRegistryRevision',
    ),
    expectedCurrentVersion: requirePositiveInteger(
      request.expectedCurrentVersion,
      'expectedCurrentVersion',
    ),
    to: request.to as SpecializedProfileState,
    reason: requireString(request.reason, 'reason', 4_000),
    ...(request.evaluationIds === undefined ? {} : {
      evaluationIds: request.evaluationIds.map((id, index) =>
        requireString(id, `evaluationIds[${index}]`, 256)),
    }),
  }
}

function parseRecordEvaluationRequest(value: unknown): RecordSpecializedProfileEvaluationRequest {
  const request = requireRecord(
    value,
    ['expectedRegistryRevision', 'evaluation'],
    'profile evaluation request',
  )
  return {
    expectedRegistryRevision: requireNonNegativeInteger(
      request.expectedRegistryRevision,
      'expectedRegistryRevision',
    ),
    evaluation: SpecializedProfileEvaluationSchema.parse(request.evaluation),
  }
}

function parseRollbackRequest(value: unknown): RollbackSpecializedProfileRequest {
  const request = requireRecord(
    value,
    ['profileId', 'expectedRegistryRevision', 'expectedCurrentVersion', 'rollbackOfVersion', 'reason'],
    'profile rollback request',
  )
  return {
    profileId: requireSlug(request.profileId, 'profileId'),
    expectedRegistryRevision: requireNonNegativeInteger(
      request.expectedRegistryRevision,
      'expectedRegistryRevision',
    ),
    expectedCurrentVersion: requirePositiveInteger(
      request.expectedCurrentVersion,
      'expectedCurrentVersion',
    ),
    rollbackOfVersion: requirePositiveInteger(request.rollbackOfVersion, 'rollbackOfVersion'),
    reason: requireString(request.reason, 'reason', 4_000),
  }
}

function requireRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.includes(key))
  if (unexpected.length > 0) throw new Error(`Unexpected ${label} fields: ${unexpected.sort().join(', ')}`)
  return record
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw new Error(`Invalid ${label}`)
  return normalized
}

function requireSlug(value: unknown, label: string): string {
  const normalized = requireString(value, label, 128)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) throw new Error(`Invalid ${label}`)
  return normalized
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeInteger(value, label)
  if (parsed < 1) throw new Error(`Invalid ${label}`)
  return parsed
}
