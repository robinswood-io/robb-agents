import type { ConnectionApi } from './types/connection-api.ts';
import type { DesktopApi } from './types/desktop-api.ts';
import type { SessionTaskApi } from './types/session-task-api.ts';
import type { WorkspaceFilesApi } from './types/workspace-files-api.ts';
import type { WorkspaceResourcesApi } from './types/workspace-resources-api.ts';

export interface ElectronAPI extends SessionTaskApi, WorkspaceFilesApi, DesktopApi, ConnectionApi, WorkspaceResourcesApi {}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

/** Public Electron API with typed session, workspace, desktop, connection and resource contracts. */
export * from '@craft-agent/shared/protocol'
export { PERMISSION_MODE_CONFIG } from '@craft-agent/shared/agent/modes';
export { THINKING_LEVELS, DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels';
export type { SettingsSubpage } from './settings-registry'
export type { PermissionMode } from "@craft-agent/shared/agent/modes";
export type { ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";
export type { Message } from "@craft-agent/core/types";
export type { MessageRole } from "@craft-agent/core/types";
export type { TypedError } from "@craft-agent/core/types";
export type { TokenUsage } from "@craft-agent/core/types";
export type { WorkspaceInfo } from "@craft-agent/core/types";
export type { Workspace } from "@craft-agent/core/types";
export type { SessionMetadata } from "@craft-agent/core/types";
export type { StoredAttachment } from "@craft-agent/core/types";
export type { ContentBadge } from "@craft-agent/core/types";
export type { ToolDisplayMeta } from "@craft-agent/core/types";
export type { AnnotationV1 } from "@craft-agent/core/types";
export type { RoutingMeta } from "@craft-agent/core/types";
export type { AutonomyEvent } from "@craft-agent/core/types";
export type { AuthState } from "@craft-agent/shared/auth/types";
export type { SetupNeeds } from "@craft-agent/shared/auth/types";
export type { AuthType } from "@craft-agent/shared/config/types";
export type { CredentialHealthStatus } from "@craft-agent/shared/credentials/types";
export type { CredentialHealthIssue } from "@craft-agent/shared/credentials/types";
export type { CredentialHealthIssueType } from "@craft-agent/shared/credentials/types";
export type { LoadedSource } from "@craft-agent/shared/sources/types";
export type { FolderSourceConfig } from "@craft-agent/shared/sources/types";
export type { SourceConnectionStatus } from "@craft-agent/shared/sources/types";
export type { LoadedSkill } from "@craft-agent/shared/skills/types";
export type { SkillMetadata } from "@craft-agent/shared/skills/types";
export type { ExportResourcesOptions } from "@craft-agent/shared/resources";
export type { ExportResult } from "@craft-agent/shared/resources";
export type { ResourceImportMode } from "@craft-agent/shared/resources";
export type { ResourceBundle } from "@craft-agent/shared/resources";
export type { ResourceImportResult } from "@craft-agent/shared/resources";
export type { LlmConnection } from "@craft-agent/shared/config";
export type { LlmConnectionWithStatus } from "@craft-agent/shared/config";
export type { LlmAuthType } from "@craft-agent/shared/config";
export type { LlmProviderType } from "@craft-agent/shared/config";
export type { NetworkProxySettings } from "@craft-agent/shared/config";
export type { ToolIconMapping, BrowserPaneCreateOptions, BrowserEmptyStateLaunchPayload, BrowserEmptyStateLaunchResult } from './types/browser.ts';
export { BROWSER_TOOLBAR_CHANNELS } from './types/browser.ts';
export type { TransportMode, TransportConnectionStatus, TransportConnectionErrorKind, TransportConnectionError, TransportCloseInfo, TransportConnectionState } from './types/transport.ts';
export type { MessagingPlatformRuntimeInfo, MessagingPlatformAccessMode, MessagingBindingAccessMode, MessagingPlatformOwnerInfo, MessagingPendingRejectReason, MessagingPendingSenderInfo, WhatsAppUiEvent, RightSidebarPanel } from './types/messaging.ts';
export type { SessionFilter, SessionsNavigationState, SourceFilter, AutomationFilter, SourcesNavigationState, SettingsNavigationState, SkillsNavigationState, AutomationsNavigationState, ProjectsNavigationState, MissionsNavigationState, NavigationState } from './types/navigation.ts';
export { isSessionsNavigation, isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation, isProjectsNavigation, isMissionsNavigation, DEFAULT_NAVIGATION_STATE, getNavigationStateKey, parseNavigationStateKey } from './types/navigation.ts';
