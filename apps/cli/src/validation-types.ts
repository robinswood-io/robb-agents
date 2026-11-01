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
  workspaceDir?: string | undefined
  /** Custom endpoint URL (from --base-url) */
  baseUrl?: string | undefined
  /** API key override (from --api-key) */
  apiKey?: string | undefined
  /** Provider hint (from --provider, default 'anthropic') */
  provider?: string | undefined
  workspaceId?: string | undefined
  workspaceRootPath?: string | undefined
  createdWorkspace?: boolean | undefined
  createdSessionId?: string | undefined
  createdSourceSlug?: string | undefined
  createdSkillSlug?: string | undefined
  createdAutomation?: boolean | undefined
  automationTestSessionId?: string | undefined
  /** Session created by automation that should be blocked by failing condition (if bug occurs) */
  automationBlockedSessionId?: string | undefined
  automationName?: string | undefined
  automationBlockedName?: string | undefined
  createdLabelId?: string | undefined
  /** Backup of existing automations.json before overwrite (undefined = didn't exist) */
  automationsJsonBackup?: string | null | undefined
  /** Backup of existing automations-history.jsonl before overwrite (undefined = didn't exist) */
  automationsHistoryBackup?: string | null | undefined
  branchedSessionId?: string | undefined
  /** Label ID for e2e-test label created for session tool validation */
  e2eTestLabelId?: string | undefined
  onEvent?: ((ev: { type: string; [key: string]: unknown }) => void) | undefined
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
