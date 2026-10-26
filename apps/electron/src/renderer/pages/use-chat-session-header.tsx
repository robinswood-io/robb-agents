import * as React from 'react';

import { useSetAtom } from 'jotai';
import { Globe, Copy, RefreshCw, Link2Off, Info, Pencil } from 'lucide-react';

import { SessionMenu } from '@/components/app-shell/SessionMenu';
import { CompactSessionMenu } from '@/components/app-shell/CompactSessionMenu';
import { AgentLifecyclePin } from '@/components/app-shell/AgentLifecyclePin';
import { SessionInfoPopover } from '@/components/app-shell/SessionInfoPopover';

import { toast } from 'sonner';
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown';

import { navigate, routes } from '@/lib/navigate';

import { kanbanEditorTargetAtom } from '@/atoms/kanban';
import { getSessionTitle } from '@/utils/session';

interface useChatSessionHeaderInput {
  displayTitle: string
  onRenameSession: (sessionId: string, name: string) => void
  sessionId: string
  onFlagSession: (sessionId: string) => void
  onUnflagSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
  onUnarchiveSession: (sessionId: string) => void
  onMarkSessionUnread: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: import("@craft-agent/shared/protocol").SessionStatus) => void
  onSessionLabelsChange: ((sessionId: string, labels: string[]) => void) | undefined
  sessionMeta: import("@/atoms/sessions").SessionMeta | undefined
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  t: import("i18next").TFunction<"translation", undefined>
  sharedUrl: string | null
  isCompactMode: boolean | undefined
  session: import("@craft-agent/shared/protocol").Session | null
  sessionStatuses: import("../config/session-status-config").SessionStatus[] | undefined
  labels: import("@craft-agent/shared/labels").LabelConfig[] | undefined
  isAsyncOperationOngoing: boolean
}

export function useChatSessionHeader({
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
}: useChatSessionHeaderInput) {
const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)

const [renameName, setRenameName] = React.useState('')

const handleRename = React.useCallback(() => {
    setRenameName(displayTitle)
    setRenameDialogOpen(true)
  }, [displayTitle])

const handleRenameSubmit = React.useCallback(() => {
    if (renameName.trim() && renameName.trim() !== displayTitle) {
      onRenameSession(sessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
  }, [sessionId, renameName, displayTitle, onRenameSession])

const handleFlag = React.useCallback(() => {
    onFlagSession(sessionId)
  }, [sessionId, onFlagSession])

const handleUnflag = React.useCallback(() => {
    onUnflagSession(sessionId)
  }, [sessionId, onUnflagSession])

const handleArchive = React.useCallback(() => {
    onArchiveSession(sessionId)
  }, [sessionId, onArchiveSession])

const handleUnarchive = React.useCallback(() => {
    onUnarchiveSession(sessionId)
  }, [sessionId, onUnarchiveSession])

const handleMarkUnread = React.useCallback(() => {
    onMarkSessionUnread(sessionId)
  }, [sessionId, onMarkSessionUnread])

const handleSessionStatusChange = React.useCallback((state: string) => {
    onSessionStatusChange(sessionId, state)
  }, [sessionId, onSessionStatusChange])

const handleLabelsChange = React.useCallback((newLabels: string[]) => {
    onSessionLabelsChange?.(sessionId, newLabels)
  }, [sessionId, onSessionLabelsChange])

const taskSlug = sessionMeta?.taskSlug

const isTaskOrchestrator = !!taskSlug && !sessionMeta?.parentSessionId

const setKanbanEditorTarget = useSetAtom(kanbanEditorTargetAtom)

const handleEditTask = React.useCallback(() => {
    if (!taskSlug) return
    setKanbanEditorTarget({
      mode: 'edit',
      sessionId,
      taskSlug,
      initialTitle: sessionMeta ? getSessionTitle(sessionMeta) : undefined,
    })
    navigate(routes.view.board())
  }, [taskSlug, sessionId, sessionMeta, setKanbanEditorTarget])

const handleDelete = React.useCallback(async () => {
    await onDeleteSession(sessionId)
  }, [sessionId, onDeleteSession])

const handleOpenInNewWindow = React.useCallback(async () => {
    const route = routes.view.allSessions(sessionId)
    const separator = route.includes('?') ? '&' : '?'
    const url = `craftagents://${route}${separator}window=focused`
    try {
      await window.electronAPI?.openUrl(url)
    } catch (error) {
      console.error('[ChatPage] openUrl failed:', error)
    }
  }, [sessionId])

const handleShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'shareToViewer' }) as { success: boolean; url?: string; error?: string } | undefined
    if (result?.success && result.url) {
      await navigator.clipboard.writeText(result.url)
      toast.success(t('toast.linkCopied'), {
        description: result.url,
        action: { label: t('sendToWorkspace.open'), onClick: () => window.electronAPI.openUrl(result.url!) },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

const handleOpenInBrowser = React.useCallback(() => {
    if (sharedUrl) window.electronAPI.openUrl(sharedUrl)
  }, [sharedUrl])

const handleCopyLink = React.useCallback(async () => {
    if (sharedUrl) {
      await navigator.clipboard.writeText(sharedUrl)
      toast.success(t('toast.linkCopied'))
    }
  }, [sharedUrl, t])

const handleUpdateShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' }) as { success: boolean; error?: string } | undefined
    if (result?.success) {
      toast.success(t('chat.shareUpdated'))
    } else {
      toast.error(t('chat.failedToUpdateShare'), { description: result?.error })
    }
  }, [sessionId, t])

const handleRevokeShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' }) as { success: boolean; error?: string } | undefined
    if (result?.success) {
      toast.success(t('chat.sharingStopped'))
    } else {
      toast.error(t('chat.failedToStopSharing'), { description: result?.error })
    }
  }, [sessionId, t])

const shareButton = React.useMemo(() => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={sharedUrl ? 'Shared session options' : 'Share session'}
          icon={sharedUrl
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.2383 10.2871C11.6481 10.0391 12.1486 10.0082 12.5811 10.1943L12.7617 10.2871L13.0088 10.4414C14.2231 11.227 15.1393 12.2124 15.8701 13.502C16.1424 13.9824 15.9736 14.5929 15.4932 14.8652C15.0127 15.1375 14.4022 14.9688 14.1299 14.4883C13.8006 13.9073 13.4303 13.417 13 12.9883V21C13 21.5523 12.5523 22 12 22C11.4477 22 11 21.5523 11 21V12.9883C10.5697 13.417 10.1994 13.9073 9.87012 14.4883C9.59781 14.9688 8.98732 15.1375 8.50684 14.8652C8.02643 14.5929 7.8576 13.9824 8.12988 13.502C8.90947 12.1264 9.90002 11.0972 11.2383 10.2871ZM11.5 3C14.2848 3 16.6594 4.75164 17.585 7.21289C20.1294 7.90815 22 10.235 22 13C22 16.3137 19.3137 19 16 19H15V16.9961C15.5021 16.9966 16.0115 16.8707 16.4795 16.6055C17.9209 15.7885 18.4272 13.9571 17.6104 12.5156C16.6661 10.8495 15.4355 9.56805 13.7969 8.57617C12.692 7.90745 11.308 7.90743 10.2031 8.57617C8.56453 9.56806 7.3339 10.8495 6.38965 12.5156C5.57277 13.957 6.07915 15.7885 7.52051 16.6055C7.98851 16.8707 8.49794 16.9966 9 16.9961V19H7C4.23858 19 2 16.7614 2 14C2 11.9489 3.23498 10.1861 5.00195 9.41504C5.04745 5.86435 7.93852 3 11.5 3Z" />
              </svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" />
              </svg>
          }
          className={sharedUrl ? 'text-accent' : undefined}
        />
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {sharedUrl ? (
          <>
            <StyledDropdownMenuItem onClick={handleOpenInBrowser}>
              <Globe className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.openInBrowser')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleCopyLink}>
              <Copy className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.copyLink')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleUpdateShare}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.updateShare')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleRevokeShare} variant="destructive">
              <Link2Off className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.stopSharing')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://agents.craft.do/docs/go-further/sharing')}>
              <Info className="h-3.5 w-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        ) : (
          <>
            <StyledDropdownMenuItem onClick={handleShare}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" />
              </svg>
              <span className="flex-1">{t('chat.shareOnline')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://agents.craft.do/docs/go-further/sharing')}>
              <Info className="h-3.5 w-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  ), [sharedUrl, handleShare, handleOpenInBrowser, handleCopyLink, handleUpdateShare, handleRevokeShare, t])

const compactInfoButton = React.useMemo(() => {
    if (!isCompactMode || !sessionMeta) return undefined

    return (
      <SessionInfoPopover
        sessionId={sessionId}
        sessionFolderPath={session?.sessionFolderPath}
        presentation="drawer"
        trigger={(
          <PanelHeaderCenterButton
            icon={<Info className="h-4 w-4" />}
            aria-label={t("chat.sessionInfo")}
          />
        )}
      />
    )
  }, [isCompactMode, sessionId, session?.sessionFolderPath, sessionMeta, t])

const editTaskButton = React.useMemo(() => {
    if (!isTaskOrchestrator) return undefined
    return (
      <PanelHeaderCenterButton
        icon={<Pencil className="h-4 w-4" />}
        tooltip={t('kanban.editTask')}
        onClick={handleEditTask}
      />
    )
  }, [isTaskOrchestrator, handleEditTask, t])

const primaryHeaderAction = isCompactMode ? compactInfoButton : shareButton

const headerActions = editTaskButton ? (
    <div className="flex items-center gap-1.5">
      {editTaskButton}
      {primaryHeaderAction}
    </div>
  ) : primaryHeaderAction

const titleMenu = React.useMemo(() => (sessionMeta && !isCompactMode) ? (
    <SessionMenu
      item={sessionMeta}
      sessionStatuses={sessionStatuses ?? []}
      labels={labels ?? []}
      onLabelsChange={handleLabelsChange}
      onRename={handleRename}
      onFlag={handleFlag}
      onUnflag={handleUnflag}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onMarkUnread={handleMarkUnread}
      onSessionStatusChange={handleSessionStatusChange}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    isCompactMode,
    sessionStatuses,
    labels,
    handleLabelsChange,
    handleRename,
    handleFlag,
    handleUnflag,
    handleArchive,
    handleUnarchive,
    handleMarkUnread,
    handleSessionStatusChange,
    handleOpenInNewWindow,
    handleDelete,
  ])

const compactTitleMenu = React.useMemo(() => (sessionMeta && isCompactMode) ? (
    <CompactSessionMenu
      title={displayTitle}
      badge={<AgentLifecyclePin item={sessionMeta} size="sm" />}
      isRegeneratingTitle={isAsyncOperationOngoing}
      item={sessionMeta}
      sessionStatuses={sessionStatuses ?? []}
      labels={labels ?? []}
      onLabelsChange={handleLabelsChange}
      onRename={handleRename}
      onFlag={handleFlag}
      onUnflag={handleUnflag}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onMarkUnread={handleMarkUnread}
      onSessionStatusChange={handleSessionStatusChange}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    isCompactMode,
    displayTitle,
    isAsyncOperationOngoing,
    sessionStatuses,
    labels,
    handleLabelsChange,
    handleRename,
    handleFlag,
    handleUnflag,
    handleArchive,
    handleUnarchive,
    handleMarkUnread,
    handleSessionStatusChange,
    handleOpenInNewWindow,
    handleDelete,
  ])
return { titleMenu, compactTitleMenu, headerActions, handleSessionStatusChange, renameDialogOpen, setRenameDialogOpen, renameName, setRenameName, handleRenameSubmit }
}
