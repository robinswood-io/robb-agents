import { randomUUID } from 'node:crypto'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadSource, loadWorkspaceSources, getSourceCredentialManager } from '@craft-agent/shared/sources'
import { createPendingFlow } from '@craft-agent/shared/auth'
import { assertRequestWorkspace, pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.oauth.START,
  RPC_CHANNELS.oauth.COMPLETE,
  RPC_CHANNELS.oauth.CANCEL,
  RPC_CHANNELS.oauth.REVOKE,
] as const

/**
 * Complete an OAuth flow: validate state, exchange code for tokens, store credentials.
 *
 * Shared between the `oauth:complete` RPC handler (called by Electron) and the
 * `/api/oauth/callback` HTTP route (called by the relay for WebUI).
 *
 * @param opts.clientId - RPC client ID (for ownership validation). Omit for HTTP callback.
 * @param opts.workspaceId - Workspace ID (for ownership validation). Omit for HTTP callback.
 */
export async function completeOAuthFlow(opts: {
  code: string
  state: string
  flowStore: { getByState(state: string): any; remove(state: string): void }
  credManager: { exchangeAndStore(...args: any[]): Promise<any> }
  sessionManager: {
    completeAuthRequest(...args: any[]): Promise<void>
    isPendingOAuthRequest?(sessionId: string, requestId: string, sourceSlug: string, workspaceId: string): boolean
    claimPendingOAuthRequest?(sessionId: string, requestId: string, sourceSlug: string, workspaceId: string, flowId: string, expiresAt?: number): boolean
    releasePendingOAuthRequest?(sessionId: string, requestId: string, flowId: string): void
  }
  pushSourcesChanged: (workspaceId: string) => void
  logger: { info(msg: string): void; }
  clientId?: string
  workspaceId?: string | null
}): Promise<{ success: boolean; error?: string; email?: string }> {
  const { code, state, flowStore, credManager, sessionManager, pushSourcesChanged, logger } = opts

  const flow = flowStore.getByState(state)
  if (!flow) throw new Error('Unknown or expired OAuth flow')

  // When called via RPC, enforce ownership. HTTP callbacks skip this (state is sufficient auth).
  if (opts.clientId !== undefined) {
    if (flow.ownerClientId !== opts.clientId) throw new Error('OAuth flow owned by different client')
  }
  if (opts.workspaceId != null) {
    if (flow.workspaceId !== opts.workspaceId) throw new Error('Workspace mismatch')
  }

  const hasSessionBinding = flow.sessionId !== undefined || flow.authRequestId !== undefined
  const boundRequestIsCurrent = (): boolean => !hasSessionBinding || (
    !!flow.sessionId && !!flow.authRequestId
    && sessionManager.isPendingOAuthRequest?.(
      flow.sessionId,
      flow.authRequestId,
      flow.sourceSlug,
      flow.workspaceId,
    ) === true
  )
  if (!boundRequestIsCurrent()) {
    flowStore.remove(state)
    throw new Error('OAuth authentication request is no longer pending')
  }

  const claimed = !hasSessionBinding || (
    sessionManager.claimPendingOAuthRequest?.(
      flow.sessionId,
      flow.authRequestId,
      flow.sourceSlug,
      flow.workspaceId,
      flow.flowId,
    ) === true
  )
  if (!claimed) {
    flowStore.remove(state)
    throw new Error('OAuth authentication request is already being completed')
  }
  // Consume provider state before the first external await. A replayed callback
  // or a second caller can never exchange/store the same flow twice.
  flowStore.remove(state)
  try {
    const result = await credManager.exchangeAndStore(flow.source, flow.provider, {
      code,
      codeVerifier: flow.codeVerifier,
      tokenEndpoint: flow.tokenEndpoint,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      redirectUri: flow.redirectUri,
    })

    // A human continuation or replacement auth request may win while the token
    // exchange is in flight. The provider write cannot be cancelled, but the old
    // card must never be completed or activated afterward.
    if (!boundRequestIsCurrent()) {
      pushSourcesChanged(flow.workspaceId)
      return { success: false, error: 'OAuth authentication request is no longer pending' }
    }

    // If this was triggered from a session auth card, complete it
    if (flow.sessionId && flow.authRequestId) {
      await sessionManager.completeAuthRequest(flow.sessionId, {
        requestId: flow.authRequestId,
        sourceSlug: flow.sourceSlug,
        success: result.success,
        email: result.email,
        error: result.error,
      })
    }

    // Push source status update to all clients in this workspace
    pushSourcesChanged(flow.workspaceId)

    logger.info(`[OAuth] Flow complete for ${flow.sourceSlug} (success=${result.success})`)
    return result
  } finally {
    if (hasSessionBinding) {
      sessionManager.releasePendingOAuthRequest?.(flow.sessionId, flow.authRequestId, flow.flowId)
    }
  }
}

export function registerOAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  const flowStore = deps.oauthFlowStore
  const credManager = getSourceCredentialManager()

  // ── oauth:start ──────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.START, async (ctx, args: {
    sourceSlug: string
    callbackPort?: number
    callbackUrl?: string
    sessionId?: string
    authRequestId?: string
  }) => {
    const { sourceSlug, callbackPort, callbackUrl, sessionId, authRequestId } = args

    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${ctx.workspaceId}`)
    }

    const hasSessionBinding = sessionId !== undefined || authRequestId !== undefined
    if (hasSessionBinding) {
      if (!sessionId || !authRequestId) {
        throw new Error('OAuth session binding requires both sessionId and authRequestId')
      }
      const sessionWorkspaceId = deps.sessionManager.getSessionWorkspaceId(sessionId)
      if (!sessionWorkspaceId) throw new Error(`Session not found: ${sessionId}`)
      assertRequestWorkspace(ctx, sessionWorkspaceId)
      if (!deps.sessionManager.isPendingOAuthRequest(sessionId, authRequestId, sourceSlug, ctx.workspaceId)) {
        throw new Error('OAuth authentication request is no longer pending')
      }
    }

    const source = loadSource(workspace.rootPath, sourceSlug)
    if (!source) {
      throw new Error(`Source not found: ${sourceSlug}`)
    }

    const prepared = await credManager.prepareOAuth(source, { callbackPort, callbackUrl })

    if (sessionId && authRequestId
      && !deps.sessionManager.isPendingOAuthRequest(sessionId, authRequestId, sourceSlug, ctx.workspaceId)) {
      throw new Error('OAuth authentication request is no longer pending')
    }

    const flowId = randomUUID()
    const flow = createPendingFlow({
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      redirectUri: prepared.redirectUri,
      source,
      clientId: prepared.clientId,
      clientSecret: prepared.clientSecret,
      tokenEndpoint: prepared.tokenEndpoint,
      provider: prepared.provider,
      ownerClientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      sourceSlug,
      sessionId,
      authRequestId,
    })
    if (sessionId && authRequestId
      && !deps.sessionManager.claimPendingOAuthRequest(
        sessionId, authRequestId, sourceSlug, ctx.workspaceId, flowId, flow.expiresAt,
      )) {
      throw new Error('OAuth authentication request is already being completed')
    }
    try {
      flowStore.store(flow)
    } catch (error) {
      if (sessionId && authRequestId) {
        deps.sessionManager.releasePendingOAuthRequest(sessionId, authRequestId, flowId)
      }
      throw error
    }

    log.info(`[OAuth] Flow started for ${sourceSlug} (flow=${flowId})`)
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  })

  // ── oauth:complete ───────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.COMPLETE, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }) => {
    const { flowId, code, state } = args

    // Validate flowId match before delegating
    const flow = flowStore.getByState(state)
    if (!flow) throw new Error('Unknown or expired OAuth flow')
    if (flow.flowId !== flowId) throw new Error('Flow ID mismatch')

    return completeOAuthFlow({
      code,
      state,
      flowStore,
      credManager,
      sessionManager: deps.sessionManager,
      pushSourcesChanged: (workspaceId) => {
        const ws = getWorkspaceByNameOrId(workspaceId)
        const sources = ws ? loadWorkspaceSources(ws.rootPath) : []
        pushTyped(server, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
      },
      logger: log,
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
    })
  })

  // ── oauth:cancel ─────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.CANCEL, async (ctx, args: {
    flowId: string
    state: string
  }) => {
    const { flowId, state } = args
    const flow = flowStore.getByState(state)
    if (flow && flow.flowId === flowId && flow.ownerClientId === ctx.clientId) {
      flowStore.remove(state)
      if (flow.sessionId && flow.authRequestId) {
        deps.sessionManager.releasePendingOAuthRequest(flow.sessionId, flow.authRequestId, flow.flowId)
      }
      log.info(`[OAuth] Flow cancelled for ${flow.sourceSlug}`)
    }
  })

  // ── oauth:revoke ─────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.REVOKE, async (ctx, args: {
    sourceSlug: string
  }) => {
    const { sourceSlug } = args

    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${ctx.workspaceId}`)
    }

    const source = loadSource(workspace.rootPath, sourceSlug)
    if (!source) {
      throw new Error(`Source not found: ${sourceSlug}`)
    }

    await credManager.delete(source)
    credManager.markSourceNeedsReauth(source, 'Signed out by user')

    // Push source status update
    const revokeSources = loadWorkspaceSources(workspace.rootPath)
    pushTyped(server, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId: ctx.workspaceId }, ctx.workspaceId, revokeSources)

    log.info(`[OAuth] Revoked credentials for ${sourceSlug}`)
    return { success: true }
  })
}
