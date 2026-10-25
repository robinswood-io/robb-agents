/**
 * Transport-layer interfaces for the WS-based RPC.
 */

import type { PushTarget } from '@craft-agent/shared/protocol'

export interface AuthenticatedPrincipal {
  actorId: string
  allowedWorkspaceIds: readonly string[] | '*'
  capabilities: readonly string[] | '*'
  roles: readonly string[]
  authorizationGeneration: number
}

export type AuthenticationResult = boolean | AuthenticatedPrincipal

export interface ConnectedClientInfo {
  clientId: string
  webContentsId: number | null
  workspaceId: string | null
  capabilities: string[]
  actorId: string
  roles: string[]
  authorizationGeneration: number
  allowedWorkspaceIds: readonly string[] | '*'
}

export interface RequestContext {
  clientId: string
  workspaceId: string | null
  webContentsId: number | null
  actorId: string
  roles: readonly string[]
  authorizationGeneration: number
  allowedWorkspaceIds: readonly string[] | '*'
}

export function assertRequestWorkspace(context: RequestContext, requestedWorkspaceId: string): void {
  if (context.workspaceId !== requestedWorkspaceId) {
    throw new Error(`Workspace access denied for \"${requestedWorkspaceId}\"`)
  }
}

/** Authorize an explicitly targeted workspace without trusting the request payload. */
export function assertRequestWorkspaceAccess(
  context: RequestContext,
  requestedWorkspaceId: string,
  resolvedWorkspaceId?: string,
): void {
  if (!context || context.allowedWorkspaceIds === undefined) {
    if (
      context?.workspaceId
      && context.workspaceId !== requestedWorkspaceId
      && context.workspaceId !== resolvedWorkspaceId
    ) {
      throw new Error(`Workspace access denied for "${requestedWorkspaceId}"`)
    }
    return
  }
  if (context.allowedWorkspaceIds === '*') return
  if (context.allowedWorkspaceIds.includes(requestedWorkspaceId)) return
  if (resolvedWorkspaceId && context.allowedWorkspaceIds.includes(resolvedWorkspaceId)) return
  throw new Error(`Workspace access denied for "${requestedWorkspaceId}"`)
}

// Registrations infer their concrete argument tuple. Collections retain an
// opaque callable, invoked only at the dynamic wire-dispatch boundary.
export type HandlerFn<Arguments extends unknown[] = never> = (ctx: RequestContext, ...args: Arguments) => unknown
export type RpcListener<Arguments extends unknown[] = never> = (...args: Arguments) => void
export type CapabilityHandler<Arguments extends unknown[] = never> = (...args: Arguments) => unknown
export type AnyEventListener<Arguments extends unknown[] = never> = (channel: string, ...args: Arguments) => void

export interface RpcServer {
  handle<Arguments extends unknown[]>(channel: string, handler: HandlerFn<Arguments>): void
  push(channel: string, target: PushTarget, ...args: unknown[]): void
  invokeClient(clientId: string, channel: string, ...args: unknown[]): Promise<unknown>
  updateClientWorkspace?(clientId: string, workspaceId: string): void
  disconnectClientsByActor?(actorId: string): number

  /** Whether a connected client advertised the given capability on handshake. */
  hasClientCapability(clientId: string, capability: string): boolean

  /** Connected clients (optionally narrowed by workspaceId) that advertised the capability. */
  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[]
}

export interface RpcClient {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on<Arguments extends unknown[]>(channel: string, callback: RpcListener<Arguments>): () => void
  handleCapability<Arguments extends unknown[]>(channel: string, handler: CapabilityHandler<Arguments>): void
}

export type EventSink = (channel: string, target: PushTarget, ...args: unknown[]) => void
