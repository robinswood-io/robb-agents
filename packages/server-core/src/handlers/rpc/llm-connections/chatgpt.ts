import { RPC_CHANNELS } from '@craft-agent/shared/protocol';

import { getCredentialManager } from '@craft-agent/shared/credentials';



import { getModelRefreshService } from '@craft-agent/server-core/model-fetchers';


import { type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from "../../handler-deps";
import { randomUUID } from 'node:crypto';


export function registerChatGptAuthHandlers(server: RpcServer, deps: HandlerDeps): void {

  // ============================================================
  // ChatGPT OAuth (for Codex chatgptAuthTokens mode)
  // Server-owned: prepare + exchange happen here, browser + callback on client.
  // ============================================================

  interface PendingChatGptFlow {
    flowId: string
    state: string
    codeVerifier: string
    connectionSlug: string
    ownerClientId: string
    createdAt: number
  }
  const pendingChatGptFlows = new Map<string, PendingChatGptFlow>()
  const CHATGPT_FLOW_TTL_MS = 5 * 60 * 1000

  function cleanupExpiredChatGptFlows() {
    const now = Date.now()
    for (const [state, flow] of pendingChatGptFlows) {
      if (now - flow.createdAt > CHATGPT_FLOW_TTL_MS) {
        pendingChatGptFlows.delete(state)
      }
    }
  }

  // chatgpt:startOAuth — prepare PKCE + auth URL, store flow, return to client
  server.handle(RPC_CHANNELS.chatgpt.START_OAUTH, async (ctx, connectionSlug: string): Promise<{
    authUrl: string
    state: string
    flowId: string
  }> => {
    cleanupExpiredChatGptFlows()
    const { prepareChatGptOAuth } = await import('@craft-agent/shared/auth')

    const prepared = prepareChatGptOAuth()
    const flowId = randomUUID()

    pendingChatGptFlows.set(prepared.state, {
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      connectionSlug,
      ownerClientId: ctx.clientId,
      createdAt: Date.now(),
    })

    deps.platform.logger?.info(`[ChatGPT OAuth] Flow started for ${connectionSlug} (flow=${flowId})`)
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  })

  // chatgpt:completeOAuth — exchange code for tokens and store credentials
  server.handle(RPC_CHANNELS.chatgpt.COMPLETE_OAUTH, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }): Promise<{ success: boolean; error?: string }> => {
    const { flowId, code, state } = args
    const flow = pendingChatGptFlows.get(state)

    if (!flow) throw new Error('Unknown or expired ChatGPT OAuth flow')
    if (flow.flowId !== flowId) throw new Error('Flow ID mismatch')
    if (flow.ownerClientId !== ctx.clientId) throw new Error('OAuth flow owned by different client')
    if (Date.now() - flow.createdAt > CHATGPT_FLOW_TTL_MS) {
      pendingChatGptFlows.delete(state)
      throw new Error('ChatGPT OAuth flow expired')
    }

    try {
      const { exchangeChatGptTokens } = await import('@craft-agent/shared/auth')
      const credentialManager = getCredentialManager()

      const tokens = await exchangeChatGptTokens(code, flow.codeVerifier)

      await credentialManager.setLlmOAuth(flow.connectionSlug, {
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
      })

      pendingChatGptFlows.delete(state)

      // Refresh the model list with the new credentials — the previously
      // cached models reflect the old account's entitlements and would be
      // stale (e.g. a new account may have access to newer GPT models).
      try {
        await getModelRefreshService().refreshNow(flow.connectionSlug)
      } catch (err) {
        deps.platform.logger?.warn(`Model refresh after ChatGPT OAuth failed for ${flow.connectionSlug}: ${err instanceof Error ? err.message : err}`)
      }

      deps.platform.logger?.info(`[ChatGPT OAuth] Flow complete for ${flow.connectionSlug}`)
      return { success: true }
    } catch (error) {
      pendingChatGptFlows.delete(state)
      deps.platform.logger?.error('[ChatGPT OAuth] Token exchange failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed',
      }
    }
  })

  // Cancel ongoing ChatGPT OAuth flow
  server.handle(RPC_CHANNELS.chatgpt.CANCEL_OAUTH, async (ctx, args?: { state?: string }): Promise<{ success: boolean }> => {
    if (args?.state) {
      const flow = pendingChatGptFlows.get(args.state)
      if (flow && flow.ownerClientId === ctx.clientId) {
        pendingChatGptFlows.delete(args.state)
        deps.platform.logger?.info(`[ChatGPT OAuth] Flow cancelled for ${flow.connectionSlug}`)
      }
    }
    return { success: true }
  })

  // Get ChatGPT authentication status
  server.handle(RPC_CHANNELS.chatgpt.GET_AUTH_STATUS, async (_ctx, connectionSlug: string): Promise<{
    authenticated: boolean
    expiresAt?: number
    hasRefreshToken?: boolean
  }> => {
    try {
      const credentialManager = getCredentialManager()
      const creds = await credentialManager.getLlmOAuth(connectionSlug)

      if (!creds) {
        return { authenticated: false }
      }

      // Check if expired (with 5-minute buffer)
      const isExpired = creds.expiresAt && Date.now() > creds.expiresAt - 5 * 60 * 1000

      return {
        authenticated: !isExpired || !!creds.refreshToken, // Can refresh if has refresh token
        ...(creds.expiresAt !== undefined ? { expiresAt: creds.expiresAt } : {}),
        hasRefreshToken: !!creds.refreshToken,
      }
    } catch (error) {
      deps.platform.logger?.error('Failed to get ChatGPT auth status:', error)
      return { authenticated: false }
    }
  })

  // Logout from ChatGPT (clear stored tokens)
  server.handle(RPC_CHANNELS.chatgpt.LOGOUT, async (_ctx, connectionSlug: string): Promise<{ success: boolean }> => {
    try {
      const credentialManager = getCredentialManager()
      await credentialManager.deleteLlmCredentials(connectionSlug)
      deps.platform.logger?.info('ChatGPT credentials cleared')
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to clear ChatGPT credentials:', error)
      return { success: false }
    }
  })
}
