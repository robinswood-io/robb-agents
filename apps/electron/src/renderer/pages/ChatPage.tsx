import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import "jotai";
import { AlertCircle } from 'lucide-react';
import { ChatDisplay } from '@/components/app-shell/ChatDisplay';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import "@/components/app-shell/SessionMenu";
import "@/components/app-shell/CompactSessionMenu";
import { AgentLifecyclePin } from '@/components/app-shell/AgentLifecyclePin';
import "@/components/app-shell/SessionInfoPopover";
import { RenameDialog } from '@/components/ui/rename-dialog';
import "sonner";
import "@/components/ui/PanelHeaderCenterButton";
import "@/components/ui/dropdown-menu";
import "@/components/ui/styled-dropdown";
import { useAppShellContext,useSessionOptionsFor,useSession as useSessionData } from '@/context/AppShellContext';
import { rendererPerf } from '@/lib/perf';
import "@/lib/navigate";
import "@/lib/input-text";
import "@/lib/resolve-session-file-path";
import "@/lib/session-load";
import "@/atoms/sessions";
import "@/atoms/kanban";
import { getSessionTitle } from '@/utils/session';
import "@config/llm-connections";

import { useChatSessionHeader } from "./use-chat-session-header";






















import { useChatSessionState } from "./use-chat-session-state";

import { ChatPageContent } from "./chat-page-content";
/**
 * ChatPage
 *
 * Displays a single session's chat with a consistent PanelHeader.
 * Extracted from MainContentPanel for consistency with other pages.
 */

/**
 * ChatPage
 *
 * Displays a single session's chat with a consistent PanelHeader.
 * Extracted from MainContentPanel for consistency with other pages.
 */

// Model resolution: connection.defaultModel (no hardcoded defaults)
// Model resolution: connection.defaultModel (no hardcoded defaults)

export interface ChatPageProps {
  sessionId: string
}

const ChatPage = React.memo(function ChatPage({ sessionId }: ChatPageProps) {
  const { t } = useTranslation()
  // Diagnostic: mark when component runs
  React.useLayoutEffect(() => {
    rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')
  }, [sessionId])

  const {
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    workspaces,
    onRespondToPermission,
    onRespondToCredential,
    onMarkSessionUnread,
    onSetActiveViewingSession,
    getDraft,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
    skills,
    labels,
    onSessionLabelsChange,
    enabledModes,
    sessionStatuses,
    onRenameSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onSessionStatusChange,
    onDeleteSession,
    rightSidebarButton,
    leadingAction,
    isCompactMode,
    sessionListSearchQuery,
    isSearchModeActive,
    chatDisplayRef,
    onChatMatchInfoChange,
    isFocusedPanel,
  } = useAppShellContext()

  // Use the unified session options hook for clean access
  const {
    options: sessionOpts,
    setOption,
    setPermissionMode,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom for isolated updates
  const session = useSessionData(sessionId)

  // Track if messages are loaded for this session (for lazy loading)
  const {
    messageLoadState,
    sessionMeta,
    handleOpenFile,
    handleOpenUrl,
    effectiveModel,
    handleModelChange,
    handleConnectionChange,
    inputValue,
    handleInputChange,
    attachmentsValue,
    handleAttachmentsChange,
    handleWorkingDirectoryChange,
    messagesRetrying,
    handleRetryMessagesLoad,
    connectionUnavailable,
    pendingPermission,
    pendingCredential,
    workingDirectory,
  } = useChatSessionState({
    sessionId,
    session,
    isFocusedPanel,
    onSetActiveViewingSession,
    getDraft,
    onInputChange,
    hydrateDraftAttachments,
    onAttachmentsChange,
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    workspaces,
    onOpenFile,
    t,
    onOpenUrl,
  })

  // Perf: Mark when data is ready
  const dataReadyMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (messageLoadState.messagesReady && session && dataReadyMarkedRef.current !== sessionId) {
      dataReadyMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'data.ready')
    }
  }, [sessionId, messageLoadState.messagesReady, session])

  // Perf: Mark render complete after paint
  React.useEffect(() => {
    if (session) {
      const rafId = requestAnimationFrame(() => {
        rendererPerf.endSessionSwitch(sessionId)
      })
      return () => cancelAnimationFrame(rafId)
    }
  
    return undefined;
  }, [sessionId, session])

  // Get display title for header - use getSessionTitle for consistent fallback logic with SessionList
  // Priority: name > first user message > preview > "New chat"
  const displayTitle = session ? getSessionTitle(session) : (sessionMeta ? getSessionTitle(sessionMeta) : t('chat.session'))


  const sharedUrl = session?.sharedUrl || sessionMeta?.sharedUrl || null


  // Use isAsyncOperationOngoing for shimmer effect (sharing, updating share, revoking, title regeneration)
  const isAsyncOperationOngoing = session?.isAsyncOperationOngoing || sessionMeta?.isAsyncOperationOngoing || false

  // Rename dialog state
  const {
    titleMenu,
    compactTitleMenu,
    headerActions,
    handleSessionStatusChange,
    renameDialogOpen,
    setRenameDialogOpen,
    renameName,
    setRenameName,
    handleRenameSubmit,
  } = useChatSessionHeader({
    displayTitle,
    onRenameSession,
    sessionId,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onMarkSessionUnread,
    onSessionStatusChange,
    onSessionLabelsChange,
    sessionMeta,
    onDeleteSession,
    t,
    sharedUrl,
    isCompactMode,
    session,
    sessionStatuses,
    labels,
    isAsyncOperationOngoing,
  })

  // Handle missing session - loading or deleted
  if (!session) {
    if (sessionMeta) {
      // Session exists in metadata but not loaded yet - show loading state
      const skeletonSession = omitUndefined({
        id: sessionMeta.id,
        workspaceId: sessionMeta.workspaceId,
        workspaceName: '' as const,
        name: sessionMeta.name,
        preview: sessionMeta.preview,
        lastMessageAt: sessionMeta.lastMessageAt || 0,
        messages: [],
        isProcessing: sessionMeta.isProcessing || false,
        isFlagged: sessionMeta.isFlagged,
        workingDirectory: sessionMeta.workingDirectory,
        enabledSourceSlugs: sessionMeta.enabledSourceSlugs,
        model: sessionMeta.model,
        modelRoutePinned: sessionMeta.modelRoutePinned,
        llmConnection: sessionMeta.llmConnection,
      })

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
                session={skeletonSession}
                onSendMessage={() => {}}
                onOpenFile={handleOpenFile}
                onOpenUrl={handleOpenUrl}
                currentModel={effectiveModel}
                onModelChange={handleModelChange}
                onConnectionChange={handleConnectionChange}
                pendingPermission={undefined}
                onRespondToPermission={onRespondToPermission}
                pendingCredential={undefined}
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
                sessionStatuses={sessionStatuses}
                onSessionStatusChange={handleSessionStatusChange}
                workspaceId={activeWorkspaceId || undefined}
                workingDirectory={sessionMeta.workingDirectory}
                onWorkingDirectoryChange={handleWorkingDirectoryChange}
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

    // Session truly doesn't exist
    return (
      <div className="h-full flex flex-col">
        <PanelHeader  title={t('chat.session')} leadingAction={leadingAction} rightSidebarButton={rightSidebarButton} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertCircle className="h-10 w-10" />
          <p className="text-sm">{t('chat.sessionNoLongerExists')}</p>
        </div>
      </div>
    )
  }

  return (
    <ChatPageContent
      displayTitle={displayTitle}
      sessionMeta={sessionMeta}
      titleMenu={titleMenu}
      compactTitleMenu={compactTitleMenu}
      leadingAction={leadingAction}
      headerActions={headerActions}
      rightSidebarButton={rightSidebarButton}
      isAsyncOperationOngoing={isAsyncOperationOngoing}
      chatDisplayRef={chatDisplayRef}
      session={session}
      onSendMessage={onSendMessage}
      handleOpenFile={handleOpenFile}
      handleOpenUrl={handleOpenUrl}
      effectiveModel={effectiveModel}
      handleModelChange={handleModelChange}
      handleConnectionChange={handleConnectionChange}
      pendingPermission={pendingPermission}
      onRespondToPermission={onRespondToPermission}
      pendingCredential={pendingCredential}
      onRespondToCredential={onRespondToCredential}
      sessionOpts={sessionOpts}
      setOption={setOption}
      setPermissionMode={setPermissionMode}
      enabledModes={enabledModes}
      inputValue={inputValue}
      handleInputChange={handleInputChange}
      attachmentsValue={attachmentsValue}
      handleAttachmentsChange={handleAttachmentsChange}
      skills={skills}
      labels={labels}
      onSessionLabelsChange={onSessionLabelsChange}
      sessionId={sessionId}
      sessionStatuses={sessionStatuses}
      handleSessionStatusChange={handleSessionStatusChange}
      activeWorkspaceId={activeWorkspaceId}
      workingDirectory={workingDirectory}
      handleWorkingDirectoryChange={handleWorkingDirectoryChange}
      messageLoadState={messageLoadState}
      messagesRetrying={messagesRetrying}
      handleRetryMessagesLoad={handleRetryMessagesLoad}
      sessionListSearchQuery={sessionListSearchQuery}
      isSearchModeActive={isSearchModeActive}
      onChatMatchInfoChange={onChatMatchInfoChange}
      connectionUnavailable={connectionUnavailable}
      isCompactMode={isCompactMode}
      renameDialogOpen={renameDialogOpen}
      setRenameDialogOpen={setRenameDialogOpen}
      t={t}
      renameName={renameName}
      setRenameName={setRenameName}
      handleRenameSubmit={handleRenameSubmit}
    />
  )
})

export default ChatPage
