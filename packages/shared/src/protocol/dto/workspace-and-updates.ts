import type { AgentCostControlPolicy } from "../../config/agent-cost-control";
import type { PermissionMode } from "../../agent/mode-types";
import type { ThinkingLevel } from "../../agent/thinking-levels";
import type { WorkspaceGovernanceProfile } from "../../governance/workspace-governance";
import type { RemoteAction, RemoteSupervisionProfile, RemoteSyncField } from "../../remote-supervision/remote-supervision";
import type { ClaudeOAuthIdentityDto } from './connections.ts';

// ---------------------------------------------------------------------------
// System types
// ---------------------------------------------------------------------------

export interface GitBashStatus {
  found: boolean
  path: string | null
  platform: 'win32' | 'darwin' | 'linux' | 'web'
}

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string | null
  downloadState: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
  downloadProgress: number
  error?: string
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export interface WorkspaceSettings {
  costControl?: AgentCostControlPolicy
  name?: string
  model?: string
  permissionMode?: PermissionMode
  externalActionPolicy?: 'confirm' | 'allow-in-execute'
  cyclablePermissionModes?: PermissionMode[]
  thinkingLevel?: ThinkingLevel
  workingDirectory?: string
  localMcpEnabled?: boolean

  defaultLlmConnection?: string
  enabledSourceSlugs?: string[]
  governance?: WorkspaceGovernanceProfile
  governanceRevision?: number
  governanceUpdatedAt?: string
  governanceUpdatedBy?: string
  remoteSupervision?: RemoteSupervisionProfile
}

export interface WorkspaceGovernanceUpdateRequest {
  expectedRevision: number
  actorId: string
  profile: WorkspaceGovernanceProfile
}

export interface WorkspaceGovernanceUpdateResult {
  governance: WorkspaceGovernanceProfile
  governanceRevision: number
  governanceUpdatedAt: string
  governanceUpdatedBy: string
}

export interface RemoteSupervisionGrantRequest {
  fields: RemoteSyncField[]
  actions: RemoteAction[]
  purpose: string
  expiresAt: string
}

export interface RemoteSupervisionRevokeRequest {
  reason: string
}

// ---------------------------------------------------------------------------
// Auth result types
// ---------------------------------------------------------------------------

export interface ClaudeOAuthResult {
  success: boolean
  token?: string
  error?: string
  /**
   * Resolved Anthropic identity (issue #838), forwarded to the renderer so it
   * can thread it into the SETUP payload (which is what persists it). Present
   * only when the token-exchange response carried identity.
   */
  identity?: ClaudeOAuthIdentityDto
}
