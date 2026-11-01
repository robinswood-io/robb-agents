/** Configuration persistence and typed settings. */
export { CONFIG_DIR } from './paths.ts';
export type {
  WorkspaceInfo,
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@craft-agent/core/types';
export type { StoredAttachment, StoredMessage } from '@craft-agent/core/types';
export type {
  LlmConnection,
  LlmProviderType,
  LlmAuthType,
  LlmConnectionWithStatus,
} from './llm-connections.ts';
export type { StoredConfig } from './storage/config-types.ts';
export { STORED_CONFIG_SCHEMA_VERSION } from './storage/config-types.ts';
export { loadConfigDefaults, ensureConfigDefaults } from './storage/config-defaults.ts';
export { backupConfigFile, ensureConfigDir, loadStoredConfig, saveConfig } from './storage/config-file.ts';
export { getNotificationsEnabled, setNotificationsEnabled, getAutoCapitalisation, setAutoCapitalisation, getSendMessageKey, setSendMessageKey, getSpellCheck, setSpellCheck, getKeepAwakeWhileRunning, setKeepAwakeWhileRunning, getRichToolDescriptions, setRichToolDescriptions, getExtendedPromptCache, setExtendedPromptCache, getBrowserToolEnabled, setBrowserToolEnabled, getAllowRemoteEvaluate, setAllowRemoteEvaluate, getEnable1MContext, setEnable1MContext, getRtkEnabled, setRtkEnabled, getGitBashPath, setGitBashPath, clearGitBashPath } from './storage/preferences.ts';
export { getConfigPath, clearAllConfig } from './storage/config-lifecycle.ts';
export { generateWorkspaceId, findWorkspaceIcon, getWorkspaces, getActiveWorkspace, getWorkspaceByNameOrId, updateWorkspaceRemoteServer, setActiveWorkspace, switchWorkspaceAtomic, addWorkspace, syncWorkspaces, removeWorkspace } from './storage/workspaces.ts';
export type { WorkspaceConversation } from './storage/workspace-history.ts';
export { saveWorkspaceConversation, loadWorkspaceConversation, getWorkspaceDataPath, clearWorkspaceConversation, saveWorkspacePlan, loadWorkspacePlan, clearWorkspacePlan } from './storage/workspace-history.ts';
export type { DraftAttachmentContent, DraftAttachmentRef, SessionDraft } from './storage/session-drafts.ts';
export { getSessionDraft, setSessionDraft, deleteSessionDraft, getAllSessionDrafts } from './storage/session-drafts.ts';
export { getAppThemePath, getAppThemesDir, loadAppTheme, saveAppTheme, clearAppTheme, ensurePresetThemes, loadPresetThemes, loadPresetTheme, getPresetThemesDir, resetPresetTheme, getColorTheme, setColorTheme } from './storage/themes.ts';
export { getDismissedUpdateVersion, setDismissedUpdateVersion, clearDismissedUpdateVersion } from './storage/update-preferences.ts';
export { shouldMigratePiOpenAiProvider, shouldRepairPiApiKeyCodexProvider, inferModelSelectionMode } from './storage/provider-migrations.ts';
export { migrateLegacyLlmConnectionsConfig, migrateOrphanedDefaultConnections } from './storage/connection-migrations.ts';
export { migrateLegacyCredentials } from './storage/credential-migration.ts';
export { getLlmConnections, getLlmConnection, addLlmConnection, updateLlmConnection, deleteLlmConnection, getDefaultLlmConnection, setDefaultLlmConnection } from './storage/connections.ts';
export { getDefaultThinkingLevel, setDefaultThinkingLevel, touchLlmConnection } from './storage/connection-preferences.ts';
export { getNetworkProxySettings, setNetworkProxySettings, isSetupDeferred, setSetupDeferred } from './storage/network-settings.ts';
export { getToolIconsDir, ensureToolIcons } from './storage/tool-icons.ts';
export { getServerConfig, setServerConfig } from './storage/server-settings.ts';
