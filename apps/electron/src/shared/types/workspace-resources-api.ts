// Source types for session source selection
import type { LoadedSource, FolderSourceConfig } from "@craft-agent/shared/sources/types";
// Skill types
import type { LoadedSkill } from "@craft-agent/shared/skills/types";
// Resource bundle types (cross-workspace export/import)
import type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult } from "@craft-agent/shared/resources";
// Import protocol types used by ElectronAPI (they come through the `export *` above,
// but we need them in scope for the interface definition)
import type { SessionSearchResult, SkillFile, SessionFile, McpToolsResult, TestAutomationPayload, TestAutomationResult } from "@craft-agent/shared/protocol";
import type { ToolIconMapping } from './browser.ts';
import type { MessagingBindingAccessMode, MessagingPendingRejectReason, MessagingPendingSenderInfo, MessagingPlatformAccessMode, MessagingPlatformOwnerInfo, MessagingPlatformRuntimeInfo, WhatsAppUiEvent } from './messaging.ts';

export interface WorkspaceResourcesApi {

  setDraft(sessionId: string, draft: import('@craft-agent/shared/config').SessionDraft): Promise<void>
  deleteDraft(sessionId: string): Promise<void>
  getAllDrafts(): Promise<Record<string, import('@craft-agent/shared/config').SessionDraft>>

  // Session Info Panel
  getSessionFiles(sessionId: string): Promise<SessionFile[]>
  getSessionNotes(sessionId: string): Promise<string>
  setSessionNotes(sessionId: string, content: string): Promise<void>
  watchSessionFiles(sessionId: string): Promise<void>
  unwatchSessionFiles(): Promise<void>
  onSessionFilesChanged(callback: (sessionId: string) => void): () => void

  // Sources
  getSources(workspaceId: string): Promise<LoadedSource[]>
  createSource(workspaceId: string, config: Partial<FolderSourceConfig>): Promise<FolderSourceConfig>
  updateSourceConfig(workspaceId: string, sourceSlug: string, updates: Omit<Partial<FolderSourceConfig>, 'routingSensitivity'> & { routingSensitivity?: FolderSourceConfig['routingSensitivity'] | null }): Promise<FolderSourceConfig>
  deleteSource(workspaceId: string, sourceSlug: string): Promise<void>
  startSourceOAuth(workspaceId: string, sourceSlug: string): Promise<{ success: boolean; error?: string }>
  saveSourceCredentials(workspaceId: string, sourceSlug: string, credential: string): Promise<void>
  getSourcePermissionsConfig(workspaceId: string, sourceSlug: string): Promise<import('@craft-agent/shared/agent').PermissionsConfigFile | null>
  getWorkspacePermissionsConfig(workspaceId: string): Promise<import('@craft-agent/shared/agent').PermissionsConfigFile | null>
  getDefaultPermissionsConfig(): Promise<{ config: import('@craft-agent/shared/agent').PermissionsConfigFile | null; path: string }>
  getMcpTools(workspaceId: string, sourceSlug: string): Promise<McpToolsResult>

  // OAuth (server-owned credentials, client-orchestrated flow)
  performOAuth(args: { sourceSlug: string; sessionId?: string; authRequestId?: string }): Promise<{ success: boolean; error?: string; email?: string }>
  oauthRevoke(sourceSlug: string): Promise<{ success: boolean }>

  // Session content search (full-text search via ripgrep)
  searchSessionContent(workspaceId: string, query: string, searchId?: string): Promise<SessionSearchResult[]>

  // Sources change listener (live updates when sources are added/removed)
  onSourcesChanged(callback: (workspaceId: string, sources: LoadedSource[]) => void): () => void

  // Default permissions change listener (live updates when default.json changes)
  onDefaultPermissionsChanged(callback: () => void): () => void

  // Skills
  getSkills(workspaceId: string, workingDirectory?: string): Promise<LoadedSkill[]>
  getSkillFiles?(workspaceId: string, skillSlug: string): Promise<SkillFile[]>
  deleteSkill(workspaceId: string, skillSlug: string): Promise<void>
  openSkillInEditor(workspaceId: string, skillSlug: string): Promise<void>
  openSkillInFinder(workspaceId: string, skillSlug: string): Promise<void>

  // Skills change listener (live updates when skills are added/removed/modified)
  onSkillsChanged(callback: (workspaceId: string, skills: LoadedSkill[]) => void): () => void

  // Statuses (workspace-scoped)
  listStatuses(workspaceId: string): Promise<import('@craft-agent/shared/statuses').StatusConfig[]>
  reorderStatuses(workspaceId: string, orderedIds: string[]): Promise<void>
  onStatusesChanged(callback: (workspaceId: string) => void): () => void

  // Labels (workspace-scoped)
  listLabels(workspaceId: string): Promise<import('@craft-agent/shared/labels').LabelConfig[]>
  createLabel(workspaceId: string, input: import('@craft-agent/shared/labels').CreateLabelInput): Promise<import('@craft-agent/shared/labels').LabelConfig>
  deleteLabel(workspaceId: string, labelId: string): Promise<{ stripped: number }>
  onLabelsChanged(callback: (workspaceId: string) => void): () => void

  // LLM connections change listener
  onLlmConnectionsChanged(callback: () => void): () => void

  // Views (workspace-scoped, stored in views.json)
  listViews(workspaceId: string): Promise<import('@craft-agent/shared/views').ViewConfig[]>
  saveViews(workspaceId: string, views: import('@craft-agent/shared/views').ViewConfig[]): Promise<void>

  // Generic workspace image loading/saving
  readWorkspaceImage(workspaceId: string, relativePath: string): Promise<string>
  writeWorkspaceImage(workspaceId: string, relativePath: string, base64: string, mimeType: string): Promise<void>

  // Tool icon mappings
  getToolIconMappings(): Promise<ToolIconMapping[]>

  // Theme (app-level default)
  getAppTheme(): Promise<import('@config/theme').ThemeOverrides | null>
  setAppTheme(theme: import('@config/theme').ThemeOverrides): Promise<void>
  clearAppTheme(): Promise<void>
  loadPresetThemes(): Promise<import('@config/theme').PresetTheme[]>
  loadPresetTheme(themeId: string): Promise<import('@config/theme').PresetTheme | null>
  getColorTheme(): Promise<string>
  setColorTheme(themeId: string): Promise<void>
  getWorkspaceColorTheme(workspaceId: string): Promise<string | null>
  setWorkspaceColorTheme(workspaceId: string, themeId: string | null): Promise<void>
  getAllWorkspaceThemes(): Promise<Record<string, string | undefined>>

  // Projects (workspace-scoped)
  getProjects(workspaceId: string): Promise<unknown>
  getProject(workspaceId: string, projectIdOrSlug: string): Promise<unknown | null>
  createProject(workspaceId: string, input: import('@craft-agent/shared/projects/types').CreateProjectInput): Promise<import('@craft-agent/shared/projects/types').ProjectConfig>
  updateProject(workspaceId: string, projectSlug: string, patch: Partial<Omit<import('@craft-agent/shared/projects/types').ProjectConfig, 'id' | 'slug' | 'createdAt'>>): Promise<import('@craft-agent/shared/projects/types').ProjectConfig>
  deleteProject(workspaceId: string, projectSlug: string): Promise<void>
  listProjectAssets(workspaceId: string, projectSlug: string): Promise<unknown>
  uploadProjectAsset(workspaceId: string, projectSlug: string, input: { filename: string; base64?: string; text?: string; sourcePath?: string }): Promise<import('@craft-agent/shared/projects/types').ProjectAsset>
  deleteProjectAsset(workspaceId: string, projectSlug: string, filename: string): Promise<void>
  onProjectsChanged(callback: (workspaceId: string, projects: unknown) => void): () => void

  // Automations
  getAutomations(workspaceId: string): Promise<unknown>

  // Automation testing (manual trigger)
  testAutomation(payload: TestAutomationPayload): Promise<TestAutomationResult>

  // Automation state management
  setAutomationEnabled(workspaceId: string, eventName: string, matcherIndex: number, enabled: boolean): Promise<void>
  duplicateAutomation(workspaceId: string, eventName: string, matcherIndex: number): Promise<void>
  deleteAutomation(workspaceId: string, eventName: string, matcherIndex: number): Promise<void>
  getAutomationHistory(workspaceId: string, automationId: string, limit?: number): Promise<Array<{ id: string; ts: number; ok: boolean; sessionId?: string; prompt?: string; error?: string; webhook?: { method: string; url: string; statusCode: number; durationMs: number; attempts?: number; error?: string; responseBody?: string } }>>
  getAutomationLastExecuted(workspaceId: string): Promise<Record<string, number>>
  replayAutomation(workspaceId: string, automationId: string, eventName: string): Promise<{ results: Array<{ type: string; url: string; statusCode: number; success: boolean; error?: string; duration: number }> }>

  // Automations change listener
  onAutomationsChanged(callback: (workspaceId: string) => void): () => void

  // Language
  changeLanguage(lang: string): Promise<void>

  // Resources (cross-workspace export/import)
  exportResources(workspaceId: string, options: ExportResourcesOptions): Promise<ExportResult>
  importResources(workspaceId: string, bundle: ResourceBundle, mode: ResourceImportMode): Promise<ResourceImportResult>

  // Messaging gateway — workspaceId is taken from the client handshake (ctx.workspaceId)
  getMessagingConfig(): Promise<{
    enabled: boolean
    platforms: Record<string, { enabled: boolean; accessMode?: MessagingPlatformAccessMode; owners?: MessagingPlatformOwnerInfo[] } | undefined>
    runtime: Record<string, MessagingPlatformRuntimeInfo | undefined>
  } | null>
  updateMessagingConfig(config: Record<string, unknown>): Promise<void>
  testTelegramToken(token: string): Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }>
  saveTelegramToken(token: string): Promise<void>
  testLarkCredentials(creds: { appId: string; appSecret: string; domain: 'lark' | 'feishu' }): Promise<{ success: boolean; botName?: string; error?: string }>
  saveLarkCredentials(creds: { appId: string; appSecret: string; domain: 'lark' | 'feishu' }): Promise<void>
  disconnectMessagingPlatform(platform: string): Promise<void>
  forgetMessagingPlatform(platform: string): Promise<void>
  getMessagingBindings(): Promise<Array<{ id: string; workspaceId: string; sessionId: string; platform: string; channelId: string; threadId?: number; channelName?: string; enabled: boolean; createdAt: number; accessMode?: MessagingBindingAccessMode; allowedSenderIds?: string[] }>>
  generateMessagingPairingCode(sessionId: string, platform: string): Promise<{ code: string; expiresAt: number; botUsername?: string }>
  /** Telegram supergroup pairing — returns a code typed in the supergroup to capture its chatId. */
  generateMessagingSupergroupCode(platform: string): Promise<{ code: string; expiresAt: number; botUsername?: string }>
  /** Read the workspace's currently paired Telegram supergroup, if any. */
  getMessagingSupergroup(): Promise<{ chatId: string; title: string; capturedAt: number } | null>
  /** Forget the paired Telegram supergroup (existing topic bindings stay on disk but stop matching). */
  unbindMessagingSupergroup(): Promise<{ success: boolean }>
  unbindMessagingSession(sessionId: string, platform?: string): Promise<void>
  unbindMessagingBinding(bindingId: string): Promise<{ success: boolean }>
  onMessagingBindingChanged(callback: (workspaceId: string) => void): () => void
  onMessagingPlatformStatus(callback: (workspaceId: string, platform: string, status: MessagingPlatformRuntimeInfo) => void): () => void
  // WhatsApp (subprocess-based Baileys adapter)
  startWhatsAppConnect(): Promise<{ success: boolean }>
  submitWhatsAppPhone(phoneNumber: string): Promise<{ success: boolean }>
  onWhatsAppEvent(callback: (payload: { workspaceId: string; event: WhatsAppUiEvent }) => void): () => void
  // Messaging access control (Phase 3)
  getMessagingPlatformOwners(platform: string): Promise<MessagingPlatformOwnerInfo[]>
  setMessagingPlatformOwners(platform: string, owners: MessagingPlatformOwnerInfo[]): Promise<MessagingPlatformOwnerInfo[]>
  getMessagingPlatformAccessMode(platform: string): Promise<MessagingPlatformAccessMode>
  setMessagingPlatformAccessMode(platform: string, mode: MessagingPlatformAccessMode): Promise<{ success: boolean }>
  getMessagingPendingSenders(platform?: string): Promise<MessagingPendingSenderInfo[]>
  dismissMessagingPendingSender(platform: string, userId: string, opts?: { reason?: MessagingPendingRejectReason; bindingId?: string }): Promise<{ success: boolean }>
  allowMessagingPendingSender(
    platform: string,
    userId: string,
    entryKey?: { reason?: MessagingPendingRejectReason; bindingId?: string },
  ): Promise<{ owners: MessagingPlatformOwnerInfo[]; bindingId?: string }>
  setMessagingBindingAccess(bindingId: string, access: { mode: MessagingBindingAccessMode; allowedSenderIds?: string[] }): Promise<{ success: boolean }>
  onMessagingPendingChanged(callback: (workspaceId: string) => void): () => void
}
