import { RPC_CHANNELS } from '@craft-agent/shared/protocol';

import { getCredentialManager } from '@craft-agent/shared/credentials';






import { type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from "../../handler-deps";
import { randomUUID } from 'node:crypto';


export function registerGeminiAuthHandlers(server: RpcServer, deps: HandlerDeps): void {

  // ============================================================
  // Google Gemini OAuth (Gemini Code Assist / Google account)
  // ============================================================

  interface PendingGeminiFlow {
    flowId: string
    state: string
    codeVerifier: string
    redirectUri: string
    connectionSlug: string
    ownerClientId: string
    createdAt: number
  }
  const pendingGeminiFlows = new Map<string, PendingGeminiFlow>()
  const GEMINI_FLOW_TTL_MS = 5 * 60 * 1000

  function cleanupExpiredGeminiFlows() {
    const now = Date.now()
    for (const [state, flow] of pendingGeminiFlows) {
      if (now - flow.createdAt > GEMINI_FLOW_TTL_MS) {
        pendingGeminiFlows.delete(state)
      }
    }
  }

  server.handle(RPC_CHANNELS.gemini.START_OAUTH, async (ctx, args: string | { connectionSlug: string; redirectUri?: string }): Promise<{
    authUrl: string
    state: string
    flowId: string
  }> => {
    cleanupExpiredGeminiFlows()
    const { prepareGoogleGeminiOAuth } = await import('@craft-agent/shared/auth')
    const connectionSlug = typeof args === 'string' ? args : args.connectionSlug
    const redirectUri = typeof args === 'string' ? undefined : args.redirectUri
    const prepared = prepareGoogleGeminiOAuth(redirectUri)
    const flowId = randomUUID()

    pendingGeminiFlows.set(prepared.state, {
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      redirectUri: prepared.redirectUri,
      connectionSlug,
      ownerClientId: ctx.clientId,
      createdAt: Date.now(),
    })

    deps.platform.logger?.info(`[Gemini OAuth] Flow started for ${connectionSlug} (flow=${flowId})`)
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  })

  server.handle(RPC_CHANNELS.gemini.COMPLETE_OAUTH, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }): Promise<{ success: boolean; error?: string }> => {
    const { flowId, code, state } = args
    const flow = pendingGeminiFlows.get(state)

    if (!flow) throw new Error('Unknown or expired Google Gemini OAuth flow')
    if (flow.flowId !== flowId) throw new Error('Flow ID mismatch')
    if (flow.ownerClientId !== ctx.clientId) throw new Error('OAuth flow owned by different client')
    if (Date.now() - flow.createdAt > GEMINI_FLOW_TTL_MS) {
      pendingGeminiFlows.delete(state)
      throw new Error('Google Gemini OAuth flow expired')
    }

    try {
      const { exchangeGoogleGeminiTokens } = await import('@craft-agent/shared/auth')
      const credentialManager = getCredentialManager()
      const tokens = await exchangeGoogleGeminiTokens(code, flow.codeVerifier, flow.redirectUri)

      await credentialManager.setLlmOAuth(flow.connectionSlug, {
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      })

      pendingGeminiFlows.delete(state)
      deps.platform.logger?.info(`[Gemini OAuth] Flow complete for ${flow.connectionSlug}`)
      return { success: true }
    } catch (error) {
      pendingGeminiFlows.delete(state)
      deps.platform.logger?.error('[Gemini OAuth] Token exchange failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed',
      }
    }
  })

  server.handle(RPC_CHANNELS.gemini.CANCEL_OAUTH, async (ctx, args?: { state?: string }): Promise<{ success: boolean }> => {
    if (args?.state) {
      const flow = pendingGeminiFlows.get(args.state)
      if (flow && flow.ownerClientId === ctx.clientId) {
        pendingGeminiFlows.delete(args.state)
        deps.platform.logger?.info(`[Gemini OAuth] Flow cancelled for ${flow.connectionSlug}`)
      }
    }
    return { success: true }
  })

  server.handle(RPC_CHANNELS.gemini.GET_AUTH_STATUS, async (_ctx, connectionSlug: string): Promise<{
    authenticated: boolean
    expiresAt?: number
    hasRefreshToken?: boolean
  }> => {
    try {
      const credentialManager = getCredentialManager()
      const creds = await credentialManager.getLlmOAuth(connectionSlug)
      if (!creds) return { authenticated: false }
      const isExpired = creds.expiresAt && Date.now() > creds.expiresAt - 5 * 60 * 1000
      return {
        authenticated: !isExpired || !!creds.refreshToken,
        expiresAt: creds.expiresAt,
        hasRefreshToken: !!creds.refreshToken,
      }
    } catch (error) {
      deps.platform.logger?.error('Failed to get Gemini auth status:', error)
      return { authenticated: false }
    }
  })

  server.handle(RPC_CHANNELS.gemini.LOGOUT, async (_ctx, connectionSlug: string): Promise<{ success: boolean }> => {
    try {
      const credentialManager = getCredentialManager()
      await credentialManager.deleteLlmCredentials(connectionSlug)
      deps.platform.logger?.info('Gemini credentials cleared')
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to clear Gemini credentials:', error)
      return { success: false }
    }
  })
}
