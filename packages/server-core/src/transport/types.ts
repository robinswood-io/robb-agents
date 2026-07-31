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
export function assertRequestWorkspaceAccess(context: RequestContext, requestedWorkspaceId: string): void {
  if (context.allowedWorkspaceIds !== '*' && !context.allowedWorkspaceIds.includes(requestedWorkspaceId)) {
    throw new Error(`Workspace access denied for \"${requestedWorkspaceId}\"`)
  }
}

export type HandlerFn = (ctx: RequestContext, ...args: any[]) => Promise<any> | any

export interface RpcServer {
  handle(channel: string, handler: HandlerFn): void
  push(channel: string, target: PushTarget, ...args: any[]): void
  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any>
  updateClientWorkspace?(clientId: string, workspaceId: string): void
  disconnectClientsByActor?(actorId: string): number

  /** Whether a connected client advertised the given capability on handshake. */
  hasClientCapability(clientId: string, capability: string): boolean

  /** Connected clients (optionally narrowed by workspaceId) that advertised the capability. */
  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[]
}

export interface RpcClient {
  invoke(channel: string, ...args: any[]): Promise<any>
  on(channel: string, callback: (...args: any[]) => void): () => void
  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void
}

export type EventSink = (channel: string, target: PushTarget, ...args: any[]) => void
