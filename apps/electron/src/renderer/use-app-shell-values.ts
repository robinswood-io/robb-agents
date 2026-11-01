import { useMemo } from 'react';

import type { Session, Workspace, FileAttachment, PermissionRequest, CredentialResponse, SessionStatus, NewChatActionParams, ContentBadge, LlmConnectionWithStatus } from '../shared/types';
import type { DraftAttachmentRef } from '@craft-agent/shared/config';
import type { SessionOptions, SessionOptionUpdates } from './hooks/useSessionOptions';

import type { AppShellContextType } from '@/context/AppShellContext';

import { useLinkInterceptor } from '@/hooks/useLinkInterceptor';

import { getFileManagerName } from '@/lib/platform';

interface useAppShellValuesInput {
  workspaces: Workspace[]
  windowWorkspaceId: string | null
  windowWorkspaceSlug: string | null
  llmConnections: LlmConnectionWithStatus[]
  workspaceDefaultLlmConnection: string | undefined
  refreshLlmConnections: () => Promise<void>
  pendingPermissions: Map<string, PermissionRequest[]>
  pendingCredentials: Map<string, import("@craft-agent/session-tools-core").CredentialAuthRequest[]>
  getDraft: (sessionId: string) => string
  getDraftAttachmentRefs: (sessionId: string) => DraftAttachmentRef[]
  hydrateDraftAttachments: (sessionId: string) => Promise<FileAttachment[]>
  sessionOptions: Map<string, SessionOptions>
  handleCreateSession: (workspaceId: string, options?: import("../shared/types").CreateSessionOptions) => Promise<Session>
  handleSendMessage: (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], externalBadges?: ContentBadge[]) => Promise<void>
  handleRenameSession: (sessionId: string, name: string) => void
  handleFlagSession: (sessionId: string) => void
  handleUnflagSession: (sessionId: string) => void
  handleArchiveSession: (sessionId: string) => void
  handleUnarchiveSession: (sessionId: string) => void
  handleMarkSessionRead: (sessionId: string) => void
  handleMarkSessionUnread: (sessionId: string) => void
  handleSetActiveViewingSession: (sessionId: string) => void
  handleSessionStatusChange: (sessionId: string, state: SessionStatus) => void
  handleDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  handleRespondToPermission: (sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: import("../shared/types").PermissionResponseOptions) => Promise<void>
  handleRespondToCredential: (sessionId: string, requestId: string, response: CredentialResponse) => Promise<void>
  handleOpenFile: (path: string) => void
  handleOpenUrl: (url: string) => void
  handleSelectWorkspace: (workspaceId: string, openInNewWindow?: boolean) => Promise<void>
  handleRefreshWorkspaces: () => void
  handleOpenSettings: () => void
  handleOpenKeyboardShortcuts: () => void
  handleOpenStoredUserPreferences: () => void
  handleReset: () => void
  handleSessionOptionsChange: (sessionId: string, updates: SessionOptionUpdates) => void
  handleInputChange: (sessionId: string, value: string) => void
  handleAttachmentsChange: (sessionId: string, attachments: FileAttachment[]) => void
  openNewChat: (params?: NewChatActionParams) => Promise<void>
  linkInterceptor: ReturnType<typeof useLinkInterceptor>
}

export function useAppShellValues({
  workspaces,
  windowWorkspaceId,
  windowWorkspaceSlug,
  llmConnections,
  workspaceDefaultLlmConnection,
  refreshLlmConnections,
  pendingPermissions,
  pendingCredentials,
  getDraft,
  getDraftAttachmentRefs,
  hydrateDraftAttachments,
  sessionOptions,
  handleCreateSession,
  handleSendMessage,
  handleRenameSession,
  handleFlagSession,
  handleUnflagSession,
  handleArchiveSession,
  handleUnarchiveSession,
  handleMarkSessionRead,
  handleMarkSessionUnread,
  handleSetActiveViewingSession,
  handleSessionStatusChange,
  handleDeleteSession,
  handleRespondToPermission,
  handleRespondToCredential,
  handleOpenFile,
  handleOpenUrl,
  handleSelectWorkspace,
  handleRefreshWorkspaces,
  handleOpenSettings,
  handleOpenKeyboardShortcuts,
  handleOpenStoredUserPreferences,
  handleReset,
  handleSessionOptionsChange,
  handleInputChange,
  handleAttachmentsChange,
  openNewChat,
  linkInterceptor,
}: useAppShellValuesInput) {
const appShellContextValue = useMemo<AppShellContextType>(() => ({
    // Data
    // NOTE: sessions is NOT included - use sessionMetaMapAtom for listing
    // and useSession(id) hook for individual sessions. This prevents memory leaks.
    workspaces,
    activeWorkspaceId: windowWorkspaceId,
    activeWorkspaceSlug: windowWorkspaceSlug,
    llmConnections,
    ...(workspaceDefaultLlmConnection !== undefined ? { workspaceDefaultLlmConnection: workspaceDefaultLlmConnection } : {}),
    refreshLlmConnections,
    pendingPermissions,
    pendingCredentials,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    sessionOptions,
    // Session callbacks
    onCreateSession: handleCreateSession,
    onSendMessage: handleSendMessage,
    onRenameSession: handleRenameSession,
    onFlagSession: handleFlagSession,
    onUnflagSession: handleUnflagSession,
    onArchiveSession: handleArchiveSession,
    onUnarchiveSession: handleUnarchiveSession,
    onMarkSessionRead: handleMarkSessionRead,
    onMarkSessionUnread: handleMarkSessionUnread,
    onSetActiveViewingSession: handleSetActiveViewingSession,
    onSessionStatusChange: handleSessionStatusChange,
    onDeleteSession: handleDeleteSession,
    onRespondToPermission: handleRespondToPermission,
    onRespondToCredential: handleRespondToCredential,
    // File/URL handlers
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Workspace
    onSelectWorkspace: handleSelectWorkspace,
    onRefreshWorkspaces: handleRefreshWorkspaces,
    // App actions
    onOpenSettings: handleOpenSettings,
    onOpenKeyboardShortcuts: handleOpenKeyboardShortcuts,
    onOpenStoredUserPreferences: handleOpenStoredUserPreferences,
    onReset: handleReset,
    // Session options
    onSessionOptionsChange: handleSessionOptionsChange,
    onInputChange: handleInputChange,
    onAttachmentsChange: handleAttachmentsChange,
    // New chat (via deep link navigation)
    openNewChat,
  }), [
    // NOTE: sessions removed to prevent memory leaks - components use atoms instead
    workspaces,
    windowWorkspaceId,
    windowWorkspaceSlug,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    pendingPermissions,
    pendingCredentials,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    sessionOptions,
    handleCreateSession,
    handleSendMessage,
    handleRenameSession,
    handleFlagSession,
    handleUnflagSession,
    handleArchiveSession,
    handleUnarchiveSession,
    handleMarkSessionRead,
    handleMarkSessionUnread,
    handleSetActiveViewingSession,
    handleSessionStatusChange,
    handleDeleteSession,
    handleRespondToPermission,
    handleRespondToCredential,
    handleOpenFile,
    handleOpenUrl,
    handleSelectWorkspace,
    handleRefreshWorkspaces,
    handleOpenSettings,
    handleOpenKeyboardShortcuts,
    handleOpenStoredUserPreferences,
    handleReset,
    handleSessionOptionsChange,
    handleInputChange,
    handleAttachmentsChange,
    openNewChat,
  ])

const platformActions = useMemo(() => ({
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Bypass link interceptor — opens file directly in system editor.
    // Used by overlay header badges (when already viewing a file, "Open" should launch editor).
    onOpenFileExternal: linkInterceptor.openFileExternal,
    // Read file contents as UTF-8 string (used by datatable/spreadsheet/html-preview src fields)
    onReadFile: (path: string) => window.electronAPI.readFile(path),
    // Read file as data URL (used by image-preview blocks)
    onReadFileDataUrl: (path: string) => window.electronAPI.readFileDataUrl(path),
    // Read file as binary Uint8Array (used by PDF preview blocks)
    onReadFileBinary: (path: string) => window.electronAPI.readFileBinary(path),
    // Reveal a file in the system file manager (Finder on macOS, Explorer on Windows, etc.)
    onRevealInFinder: (path: string) => {
      window.electronAPI.showInFolder(path).catch(() => {})
    },
    // Platform-specific file manager name for UI labels
    fileManagerName: getFileManagerName(),
    // Hide/show macOS traffic lights when fullscreen overlays are open
    onSetTrafficLightsVisible: (visible: boolean) => {
      window.electronAPI.setTrafficLightsVisible(visible)
    },
  }), [handleOpenFile, handleOpenUrl, linkInterceptor.openFileExternal])
return { platformActions, appShellContextValue }
}
