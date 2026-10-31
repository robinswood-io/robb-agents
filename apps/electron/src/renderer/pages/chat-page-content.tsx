import * as React from 'react';

import { ChatDisplay, type ChatDisplayHandle } from '@/components/app-shell/ChatDisplay';
import { PanelHeader } from '@/components/app-shell/PanelHeader';

import { AgentLifecyclePin } from '@/components/app-shell/AgentLifecyclePin';

import { RenameDialog } from '@/components/ui/rename-dialog';

interface ChatPageContentProps {
  displayTitle: string
  sessionMeta: import("@/atoms/sessions").SessionMeta | undefined
  titleMenu: React.JSX.Element | null
  compactTitleMenu: React.JSX.Element | null
  leadingAction: React.ReactNode
  headerActions: React.JSX.Element | undefined
  rightSidebarButton: React.ReactNode
  isAsyncOperationOngoing: boolean
  chatDisplayRef: React.RefObject<ChatDisplayHandle | null> | undefined
  session: import("@craft-agent/shared/protocol").Session | null
  onSendMessage: (sessionId: string, message: string, attachments?: import("@craft-agent/shared/protocol").FileAttachment[], skillSlugs?: string[], badges?: import("@craft-agent/core").ContentBadge[]) => void
  handleOpenFile: (path: string) => Promise<void>
  handleOpenUrl: (url: string) => void
  effectiveModel: string
  handleModelChange: (model: string | null, connection?: string) => void
  handleConnectionChange: (connectionSlug: string) => Promise<void>
  pendingPermission: import("@craft-agent/shared/protocol").PermissionRequest | undefined
  onRespondToPermission: ((sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: import("@craft-agent/shared/protocol").PermissionResponseOptions) => void) | undefined
  pendingCredential: import("@craft-agent/session-tools-core").CredentialAuthRequest | undefined
  onRespondToCredential: ((sessionId: string, requestId: string, response: import("@craft-agent/shared/protocol").CredentialResponse) => void | Promise<void>) | undefined
  sessionOpts: import("../hooks/useSessionOptions").SessionOptions
  setOption: <K extends keyof import("../hooks/useSessionOptions").SessionOptions>(key: K, value: import("../hooks/useSessionOptions").SessionOptions[K]) => void
  setPermissionMode: (mode: import("@craft-agent/shared/agent").PermissionMode) => void
  enabledModes: import("@craft-agent/shared/agent").PermissionMode[] | undefined
  inputValue: string
  handleInputChange: (value: string) => void
  attachmentsValue: import("@craft-agent/shared/protocol").FileAttachment[]
  handleAttachmentsChange: (attachments: import("../../shared/types").FileAttachment[]) => void
  skills: import("@craft-agent/shared/skills").LoadedSkill[] | undefined
  labels: import("@craft-agent/shared/labels").LabelConfig[] | undefined
  onSessionLabelsChange: ((sessionId: string, labels: string[]) => void) | undefined
  sessionId: string
  sessionStatuses: import("../config/session-status-config").SessionStatus[] | undefined
  handleSessionStatusChange: (state: string) => void
  activeWorkspaceId: string | null
  workingDirectory: string | undefined
  handleWorkingDirectoryChange: (path: string) => Promise<void>
  messageLoadState: import("@/lib/session-load").SessionMessagesLoadState
  messagesRetrying: boolean
  handleRetryMessagesLoad: () => Promise<void>
  sessionListSearchQuery: string | undefined
  isSearchModeActive: boolean | undefined
  onChatMatchInfoChange: ((info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean; }) => void) | undefined
  connectionUnavailable: boolean
  isCompactMode: boolean | undefined
  renameDialogOpen: boolean
  setRenameDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  t: import("i18next").TFunction<"translation", undefined>
  renameName: string
  setRenameName: React.Dispatch<React.SetStateAction<string>>
  handleRenameSubmit: () => void
}

export function ChatPageContent({
  displayTitle,
  sessionMeta,
  titleMenu,
  compactTitleMenu,
  leadingAction,
  headerActions,
  rightSidebarButton,
  isAsyncOperationOngoing,
  chatDisplayRef,
  session,
  onSendMessage,
  handleOpenFile,
  handleOpenUrl,
  effectiveModel,
  handleModelChange,
  handleConnectionChange,
  pendingPermission,
  onRespondToPermission,
  pendingCredential,
  onRespondToCredential,
  sessionOpts,
  setOption,
  setPermissionMode,
  enabledModes,
  inputValue,
  handleInputChange,
  attachmentsValue,
  handleAttachmentsChange,
  skills,
  labels,
  onSessionLabelsChange,
  sessionId,
  sessionStatuses,
  handleSessionStatusChange,
  activeWorkspaceId,
  workingDirectory,
  handleWorkingDirectoryChange,
  messageLoadState,
  messagesRetrying,
  handleRetryMessagesLoad,
  sessionListSearchQuery,
  isSearchModeActive,
  onChatMatchInfoChange,
  connectionUnavailable,
  isCompactMode,
  renameDialogOpen,
  setRenameDialogOpen,
  t,
  renameName,
  setRenameName,
  handleRenameSubmit,
}: ChatPageContentProps) {

  return (
    <>
      <div className="h-full flex flex-col">
        <PanelHeader
          title={displayTitle}
          badge={sessionMeta ? <AgentLifecyclePin item={sessionMeta} size="sm" /> : undefined}
          titleMenu={titleMenu}
          compactTitleMenu={compactTitleMenu}
          leadingAction={leadingAction}
          actions={headerActions}
          rightSidebarButton={rightSidebarButton}
          isRegeneratingTitle={isAsyncOperationOngoing}
        />
        <div className="flex-1 flex flex-col min-h-0">
          <ChatDisplay
            ref={chatDisplayRef}
            session={session}
            onSendMessage={(message, attachments, skillSlugs) => {
              if (session) {
                onSendMessage(session.id, message, attachments, skillSlugs)
              }
            }}
            onOpenFile={handleOpenFile}
            onOpenUrl={handleOpenUrl}
            currentModel={effectiveModel}
            onModelChange={handleModelChange}
            onConnectionChange={handleConnectionChange}
            pendingPermission={pendingPermission}
            onRespondToPermission={onRespondToPermission}
            pendingCredential={pendingCredential}
            onRespondToCredential={onRespondToCredential}
            thinkingLevel={sessionOpts.thinkingLevel}
            onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
            permissionMode={sessionOpts.permissionMode}
            onPermissionModeChange={setPermissionMode}
            enabledModes={enabledModes}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            attachmentsValue={attachmentsValue}
            onAttachmentsChange={handleAttachmentsChange}
            skills={skills}
            labels={labels}
            onLabelsChange={(newLabels) => onSessionLabelsChange?.(sessionId, newLabels)}
            sessionStatuses={sessionStatuses}
            onSessionStatusChange={handleSessionStatusChange}
            workspaceId={activeWorkspaceId || undefined}
            workingDirectory={workingDirectory}
            onWorkingDirectoryChange={handleWorkingDirectoryChange}
            sessionFolderPath={session?.sessionFolderPath}
            messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
            messagesLoadError={messageLoadState.error}
            messagesRetrying={messagesRetrying}
            onRetryMessagesLoad={handleRetryMessagesLoad}
            searchQuery={sessionListSearchQuery}
            isSearchModeActive={isSearchModeActive}
            onMatchInfoChange={onChatMatchInfoChange}
            connectionUnavailable={connectionUnavailable}
            compactMode={!!isCompactMode}
            enableCompactModelPicker={!!isCompactMode}
          />
        </div>
      </div>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t('chat.renameSession')}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t('chat.enterSessionName')}
      />
    </>
  )
}
