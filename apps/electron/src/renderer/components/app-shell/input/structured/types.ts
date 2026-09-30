import type { PermissionRequest, CredentialRequest, CredentialResponse } from '../../../../../shared/types'
import type { AdminApprovalRequestData } from './AdminApprovalRequest'

/**
 * Input mode determines which component is rendered in InputContainer
 */
export type InputMode = 'freeform' | 'structured'

/**
 * Types of structured input UIs
 */
export type StructuredInputType = 'permission' | 'credential' | 'admin_approval'

/**
 * Union type for structured input data
 */
export type StructuredInputData =
  | { type: 'permission'; data: PermissionRequest }
  | { type: 'credential'; data: CredentialRequest }
  | { type: 'admin_approval'; data: AdminApprovalRequestData; request: PermissionRequest }

/**
 * State for structured input
 */
export type StructuredInputState = StructuredInputData

export interface PermissionResponseIdentity {
  sessionId: string
  /** Unique broker capability sent over IPC. The server binds it to the exact
   * runtime, generation, objective and tool metadata before accepting it. */
  requestId: string
  /** Renderer remount/diagnostic binding; authority remains the broker requestId. */
  toolUseId?: string
}

export interface CredentialResponseIdentity {
  sessionId: string
  requestId: string
}

export function permissionResponseIdentity(
  request: Pick<PermissionRequest, 'sessionId' | 'requestId' | 'toolUseId'>,
): PermissionResponseIdentity {
  return {
    sessionId: request.sessionId,
    requestId: request.requestId,
    ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
  }
}

export type StructuredCredentialResponse = CredentialResponse & {
  request: CredentialResponseIdentity
}

/** Bind form values to the exact credential card that collected them. */
export function bindCredentialResponse(
  request: Pick<CredentialRequest, 'sessionId' | 'requestId'>,
  response: CredentialResponse,
): StructuredCredentialResponse {
  return {
    ...response,
    request: {
      sessionId: request.sessionId,
      requestId: request.requestId,
    },
  }
}

/** A different broker capability must mount a fresh card, even at the same type. */
export function structuredInputIdentity(state: StructuredInputState): string {
  if (state.type === 'admin_approval') {
    const request = state.request
    return `${request.sessionId}:${request.requestId}:${request.toolUseId ?? ''}`
  }
  const request = state.data
  return `${request.sessionId}:${request.requestId}:${'toolUseId' in request ? request.toolUseId ?? '' : ''}`
}

/**
 * Response from permission request
 */
export interface PermissionResponse {
  type: 'permission'
  request: PermissionResponseIdentity
  allowed: boolean
  alwaysAllow: boolean
}

/**
 * Response from admin approval request
 */
export interface AdminApprovalResponse {
  type: 'admin_approval'
  request: PermissionResponseIdentity
  approved: boolean
  rememberForMinutes?: number
}

/**
 * Union type for all structured responses
 */
export type StructuredResponse = PermissionResponse | StructuredCredentialResponse | AdminApprovalResponse

// Re-export CredentialResponse for convenience
export type { CredentialResponse }
