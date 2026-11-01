// Thinking level types
import type { ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";
// Auth types for onboarding
import type { AuthState, SetupNeeds } from "@craft-agent/shared/auth/types";
// Credential health types
import type { CredentialHealthStatus } from "@craft-agent/shared/credentials/types";
// LLM connection types
import type { LlmConnection, LlmConnectionWithStatus } from "@craft-agent/shared/config";
// Import protocol types used by ElectronAPI (they come through the `export *` above,
// but we need them in scope for the interface definition)
import type { LlmConnectionSetup, TestLlmConnectionParams, TestLlmConnectionResult, OAuthResult, ClaudeOAuthResult, WorkspaceSettings, WorkspaceGovernanceUpdateRequest, WorkspaceGovernanceUpdateResult, RemoteSupervisionGrantRequest, RemoteSupervisionRevokeRequest } from "@craft-agent/shared/protocol";

export interface ConnectionApi {

  showDeleteSessionConfirmation(name: string): Promise<boolean>
  showDeleteWorkspaceConfirmation(name: string): Promise<boolean>
  logout(): Promise<void>

  // Credential health check (startup validation)
  getCredentialHealth(): Promise<CredentialHealthStatus>

  // Onboarding
  getAuthState(): Promise<AuthState>
  getSetupNeeds(): Promise<SetupNeeds>
  startWorkspaceMcpOAuth(mcpUrl: string): Promise<OAuthResult & { clientId?: string }>
  // Claude OAuth (two-step flow)
  startClaudeOAuth(): Promise<{ success: boolean; authUrl?: string; error?: string }>
  exchangeClaudeCode(code: string, connectionSlug: string): Promise<ClaudeOAuthResult>
  hasClaudeOAuthState(): Promise<boolean>
  clearClaudeOAuthState(): Promise<{ success: boolean }>
  /** Verifies or launches the official Antigravity CLI account sign-in. */
  startGoogleAntigravitySetup(): Promise<{ success: boolean; error?: string }>
  /** Runs Vibe's delegated ACP browser flow; Vibe retains the credential locally. */
  startMistralVibeSetup(): Promise<{ success: boolean; error?: string }>
  /** Defer onboarding setup — user chose "Setup later" */
  deferSetup(): Promise<{ success: boolean }>

  // ChatGPT OAuth (for Codex chatgptAuthTokens mode)
  startChatGptOAuth(connectionSlug: string): Promise<{ success: boolean; error?: string }>
  cancelChatGptOAuth(): Promise<{ success: boolean }>
  getChatGptAuthStatus(connectionSlug: string): Promise<{ authenticated: boolean; expiresAt?: number; hasRefreshToken?: boolean }>
  chatGptLogout(connectionSlug: string): Promise<{ success: boolean }>

  // GitHub Copilot OAuth
  startCopilotOAuth(connectionSlug: string): Promise<{ success: boolean; error?: string }>
  cancelCopilotOAuth(): Promise<{ success: boolean }>
  getCopilotAuthStatus(connectionSlug: string): Promise<{ authenticated: boolean }>
  copilotLogout(connectionSlug: string): Promise<{ success: boolean }>
  onCopilotDeviceCode(callback: (data: { userCode: string; verificationUri: string }) => void): () => void

  // Google Gemini OAuth / Code Assist subscription
  startGeminiOAuth(connectionSlug: string): Promise<{ success: boolean; error?: string }>
  cancelGeminiOAuth(): Promise<{ success: boolean }>
  getGeminiAuthStatus(connectionSlug: string): Promise<{ authenticated: boolean; expiresAt?: number; hasRefreshToken?: boolean }>
  geminiLogout(connectionSlug: string): Promise<{ success: boolean }>

  /** Unified LLM connection setup */
  setupLlmConnection(setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }>
  /** Unified connection test — spawns a lightweight agent subprocess to validate credentials */
  testLlmConnectionSetup(params: TestLlmConnectionParams): Promise<TestLlmConnectionResult>
  // Pi provider discovery (main process only — Pi SDK can't run in renderer)
  getPiApiKeyProviders(): Promise<Array<{ key: string; label: string; placeholder: string }>>
  getPiProviderBaseUrl(provider: string): Promise<string | undefined>
  getPiProviderModels(provider: string): Promise<{ models: Array<{ id: string; name: string; costInput: number; costOutput: number; contextWindow: number; reasoning: boolean }>; totalCount: number }>

  // Session-specific model (overrides global)
  getSessionModel(sessionId: string, workspaceId: string): Promise<string | null>
  setSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>

  // Workspace Settings (per-workspace configuration)
  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings | null>
  updateWorkspaceSetting<K extends keyof WorkspaceSettings>(workspaceId: string, key: K, value: WorkspaceSettings[K]): Promise<void>
  updateWorkspaceGovernance(
    workspaceId: string,
    request: WorkspaceGovernanceUpdateRequest,
  ): Promise<WorkspaceGovernanceUpdateResult>
  grantRemoteSupervision(
    workspaceId: string,
    request: RemoteSupervisionGrantRequest,
  ): Promise<NonNullable<WorkspaceSettings['remoteSupervision']>>
  revokeRemoteSupervision(
    workspaceId: string,
    request: RemoteSupervisionRevokeRequest,
  ): Promise<NonNullable<WorkspaceSettings['remoteSupervision']>>
  /** Read-only policy explanation. It never invokes a model or touches credentials. */

  /** Read-only outcome report; this method has no policy mutation capability. */


  // Folder dialog
  openFolderDialog(): Promise<string | null>

  // User Preferences
  readPreferences(): Promise<{ content: string; exists: boolean; path: string }>
  writePreferences(content: string): Promise<{ success: boolean; error?: string }>

  // Session Drafts (persisted composer state — text + attachment refs)
  getDraft(sessionId: string): Promise<import('@craft-agent/shared/config').SessionDraft | null>

  // LLM Connections (provider configurations)
  listLlmConnections(): Promise<LlmConnection[]>
  listLlmConnectionsWithStatus(): Promise<LlmConnectionWithStatus[]>
  getLlmConnection(slug: string): Promise<LlmConnection | null>
  getLlmConnectionApiKey(slug: string): Promise<string | null>
  saveLlmConnection(connection: LlmConnection): Promise<{ success: boolean; error?: string }>
  deleteLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  testLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  setDefaultLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  getDefaultThinkingLevel(): Promise<ThinkingLevel>
  setDefaultThinkingLevel(level: ThinkingLevel): Promise<{ success: boolean; error?: string }>
  setWorkspaceDefaultLlmConnection(workspaceId: string, slug: string | null): Promise<{ success: boolean; error?: string }>
}
