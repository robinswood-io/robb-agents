import { CliRpcClient } from './client.ts';

// ---------------------------------------------------------------------------
// Validate server
// ---------------------------------------------------------------------------

export interface ValidateStep {
  name: string
  fn: (client: CliRpcClient, ctx: ValidateContext) => Promise<string>
}

export interface ValidateContext {
  /** Pre-existing workspace directory (from --workspace-dir) */
  workspaceDir?: string
  /** Custom endpoint URL (from --base-url) */
  baseUrl?: string
  /** API key override (from --api-key) */
  apiKey?: string
  /** Provider hint (from --provider, default 'anthropic') */
  provider?: string
  workspaceId?: string
  workspaceRootPath?: string
  createdWorkspace?: boolean
  createdSessionId?: string
  createdSourceSlug?: string
  createdSkillSlug?: string
  createdAutomation?: boolean
  automationTestSessionId?: string
  /** Session created by automation that should be blocked by failing condition (if bug occurs) */
  automationBlockedSessionId?: string
  automationName?: string
  automationBlockedName?: string
  createdLabelId?: string
  /** Backup of existing automations.json before overwrite (undefined = didn't exist) */
  automationsJsonBackup?: string | null
  /** Backup of existing automations-history.jsonl before overwrite (undefined = didn't exist) */
  automationsHistoryBackup?: string | null
  branchedSessionId?: string
  /** Label ID for e2e-test label created for session tool validation */
  e2eTestLabelId?: string
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void
}

/** Minimal shapes for RPC responses used in validation steps. */
export interface ValidateStatus {
  id?: string
  label?: string
}

export interface ValidateSession {
  id: string
  labelIds?: string[]
  preview?: string
  isProcessing?: boolean
  name?: string
  labels?: string[]
}

export interface ValidateLabel {
  id?: string
  name?: string
}

interface ValidateMessageBlock {
  type: string
  text?: string
}

interface ValidateMessage {
  id: string
  role: string
  content: string | ValidateMessageBlock[]
}

export interface ValidateMessagesResponse {
  messages?: ValidateMessage[]
  conversation?: ValidateMessage[]
}
