import * as React from 'react';

import { useInlineSlashCommand, type SlashCommandId } from '@/components/ui/slash-command-menu';
import { useInlineMention } from '@/components/ui/mention-menu';

import { type RichTextInputHandle } from '@/components/ui/rich-text-input';

import type { FileAttachment, LoadedSkill } from '../../../../shared/types';
import { permissionModeAfterPlanApproval, type PermissionMode } from '@craft-agent/shared/agent/modes';

import { buildPlanApprovalMessage } from '../plan-approval-message';
import { shouldHandleScopedInputEvent } from './input-event-guards';

import { clearPendingFocusForSession, consumePendingFocusForSession } from './focus-input-events';
import { getRecentWorkingDirs, addRecentWorkingDir } from './working-directory-history';

interface useInputEditorMenusInput {
  input: string
  clearInputDraft: () => void
  sessionId: string | undefined
  permissionMode: PermissionMode
  onPermissionModeChange: ((mode: PermissionMode) => void) | undefined
  onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  isFocusedPanel: boolean
  richInputRef: React.RefObject<RichTextInputHandle | null>
  lastCaretPositionRef: React.RefObject<number | null>
  disabled: boolean
  setLoadingCount: React.Dispatch<React.SetStateAction<number>>
  attachmentsRef: React.RefObject<FileAttachment[]>
  readFileAsAttachment: (file: File, overrideName?: string) => Promise<FileAttachment | null>
  setAttachments: React.Dispatch<React.SetStateAction<FileAttachment[]>>
  isProcessing: boolean
  onWorkingDirectoryChange: ((path: string) => void) | undefined
  workspaceId: string | undefined
  skills: LoadedSkill[]
  workingDirectory: string | undefined
  workspaceSlug: string | undefined
  onLabelAdd: ((labelId: string) => void) | undefined
}

export function useInputEditorMenus({
  input,
  clearInputDraft,
  sessionId,
  permissionMode,
  onPermissionModeChange,
  onSubmit,
  isFocusedPanel,
  richInputRef,
  lastCaretPositionRef,
  disabled,
  setLoadingCount,
  attachmentsRef,
  readFileAsAttachment,
  setAttachments,
  isProcessing,
  onWorkingDirectoryChange,
  workspaceId,
  skills,
  workingDirectory,
  workspaceSlug,
  onLabelAdd,
}: useInputEditorMenusInput) {
const consumeInputDraftSnapshot = React.useCallback((): string => {
    const snapshot = input.trim()
    clearInputDraft()
    return snapshot
  }, [input, clearInputDraft])

type PlanApprovalEventDetail = WindowEventMap['craft:approve-plan']['detail']

React.useEffect(() => {
    const handleApprovePlan = (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInput = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''
      const text = buildPlanApprovalMessage({
        planPath: e.detail?.planPath,
        draftInput,
      })

      const approvedMode = permissionModeAfterPlanApproval(permissionMode)
      if (approvedMode !== permissionMode) {
        onPermissionModeChange?.(approvedMode)
      }

      onSubmit(text, undefined)
    }

    window.addEventListener('craft:approve-plan', handleApprovePlan)
    return () => window.removeEventListener('craft:approve-plan', handleApprovePlan)
  }, [sessionId, permissionMode, onPermissionModeChange, onSubmit, consumeInputDraftSnapshot])

React.useEffect(() => {
    const handleApprovePlanWithCompact = async (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const planPath = e.detail?.planPath
      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInputSnapshot = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''

      const approvedMode = permissionModeAfterPlanApproval(permissionMode)
      if (approvedMode !== permissionMode) {
        onPermissionModeChange?.(approvedMode)
      }

      // Persist the pending plan execution state BEFORE sending /compact.
      // This allows reload recovery if CMD+R happens during compaction.
      if (sessionId) {
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'setPendingPlanExecution',
          planPath: planPath ?? '',
          draftInputSnapshot,
        })
      }

      // Send /compact to trigger compaction
      onSubmit('/compact', undefined)

      // Set up a one-time listener for compaction complete.
      // This handles the normal case (no reload during compaction).
      const handleCompactionComplete = async (compactEvent: CustomEvent<{ sessionId?: string }>) => {
        // Only handle if this is for our session
        if (compactEvent.detail?.sessionId !== sessionId) {
          return
        }

        // Remove the listener (one-time use)
        window.removeEventListener('craft:compaction-complete', handleCompactionComplete)

        const executionMessage = buildPlanApprovalMessage({
          planPath,
          draftInput: draftInputSnapshot,
        })
        onSubmit(executionMessage, undefined)

        // Clear the pending state since we just sent the execution message
        if (sessionId) {
          await window.electronAPI.sessionCommand(sessionId, {
            type: 'clearPendingPlanExecution',
          })
        }
      }

      window.addEventListener('craft:compaction-complete', handleCompactionComplete)
    }

    window.addEventListener('craft:approve-plan-with-compact', handleApprovePlanWithCompact)
    return () => window.removeEventListener('craft:approve-plan-with-compact', handleApprovePlanWithCompact)
  }, [sessionId, permissionMode, onPermissionModeChange, onSubmit, consumeInputDraftSnapshot])

React.useEffect(() => {
    if (!sessionId) return

    let hasExecuted = false

    const isExpectedReconnectError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('Connection closed')
        || message.includes('Client disconnected')
        || message.includes('transport')
        || message.includes('socket')
        || message.includes('Session not found')
    }

    const executePendingPlan = async () => {
      if (hasExecuted) return

      try {
        const pending = await window.electronAPI.getPendingPlanExecution(sessionId)
        if (!pending || pending.awaitingCompaction || pending.executionDispatched) return

        // Mark dispatched before sending so reload recovery does not double-submit
        // the same plan if onSubmit succeeds but cleanup fails during a reconnect.
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'markPendingPlanExecutionDispatched',
        })

        // Compaction completed but we never sent the execution message (page reloaded).
        // Send it now and clear the pending state.
        hasExecuted = true
        const executionMessage = buildPlanApprovalMessage({
          planPath: pending.planPath,
          draftInput: pending.draftInputSnapshot,
        })
        onSubmit(executionMessage, undefined)

        await window.electronAPI.sessionCommand(sessionId, {
          type: 'clearPendingPlanExecution',
        })
      } catch (error) {
        if (!isExpectedReconnectError(error)) {
          console.error('[FreeFormInput] Failed to resume pending plan execution:', error)
        }
      }
    }

    // Check immediately on mount (handles case where compaction already completed)
    executePendingPlan()

    // Also listen for compaction-complete in case CMD+R happened during compaction.
    // When compaction finishes after reload, this listener will trigger execution.
    const handleCompactionComplete = async (e: CustomEvent<{ sessionId: string }>) => {
      if (e.detail?.sessionId !== sessionId) return
      // Small delay to ensure markCompactionComplete has been called
      await new Promise(resolve => setTimeout(resolve, 100))
      executePendingPlan()
    }

    window.addEventListener('craft:compaction-complete', handleCompactionComplete)
    return () => {
      window.removeEventListener('craft:compaction-complete', handleCompactionComplete)
    }
  }, [sessionId, onSubmit])

React.useEffect(() => {
    const handleFocusInput = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail
      const targetSessionId = detail?.sessionId
      if (!shouldHandleScopedInputEvent({ ...(sessionId !== undefined ? { sessionId: sessionId } : {}), isFocusedPanel, ...(targetSessionId !== undefined ? { targetSessionId: targetSessionId } : {}) })) return

      if (targetSessionId) {
        clearPendingFocusForSession(targetSessionId)
      }

      richInputRef.current?.focus()
      // Restore caret position if saved, then clear it (one-shot)
      if (lastCaretPositionRef.current !== null) {
        richInputRef.current?.setSelectionRange(
          lastCaretPositionRef.current,
          lastCaretPositionRef.current
        )
        lastCaretPositionRef.current = null
      }
    }

    window.addEventListener('craft:focus-input', handleFocusInput)
    return () => window.removeEventListener('craft:focus-input', handleFocusInput)
  }, [sessionId, isFocusedPanel, richInputRef, lastCaretPositionRef])

React.useEffect(() => {
    if (!consumePendingFocusForSession(sessionId)) return

    setTimeout(() => {
      richInputRef.current?.focus()
    }, 0)
  }, [sessionId, richInputRef])

const getNextPastedNumber = (
    prefix: 'image' | 'text' | 'file',
    existingAttachments: FileAttachment[]
  ): number => {
    const pattern = new RegExp(`^pasted-${prefix}-(\\d+)\\.`)
    let maxNum = 0
    for (const att of existingAttachments) {
      const match = att.name.match(pattern)
      if (match?.[1]) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
    return maxNum + 1
  }

React.useEffect(() => {
    const handlePasteFiles = async (e: WindowEventMap['craft:paste-files']) => {
      if (disabled) return

      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ ...(sessionId !== undefined ? { sessionId: sessionId } : {}), isFocusedPanel, ...(targetSessionId !== undefined ? { targetSessionId: targetSessionId } : {}) })) return

      const { files } = e.detail
      if (!files || files.length === 0) return

      setLoadingCount(prev => prev + files.length)

      // Pre-assign sequential names using ref to avoid race conditions
      let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
      const fileNames: string[] = files.map(file => {
        if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
          const ext = file.type.split('/')[1] || 'png'
          return `pasted-image-${nextImageNum++}.${ext}`
        }
        return file.name
      })

      for (const [i, file] of files.entries()) {
        try {
          const attachment = await readFileAsAttachment(file, fileNames[i])
          if (attachment) {
            setAttachments(prev => [...prev, attachment])
          }
        } catch (error) {
          console.error('[FreeFormInput] Failed to process pasted file:', error)
        }
        setLoadingCount(prev => prev - 1)
      }

      // Focus the input after adding attachments
      richInputRef.current?.focus()
    }

    window.addEventListener('craft:paste-files', handlePasteFiles)
    return () => window.removeEventListener('craft:paste-files', handlePasteFiles)
  }, [disabled, sessionId, isFocusedPanel, richInputRef, attachmentsRef, readFileAsAttachment, setAttachments, setLoadingCount])

const activeCommands = React.useMemo(() => {
    const active: SlashCommandId[] = []
    // Add the currently active permission mode
    if (permissionMode === 'safe') active.push('safe')
    else if (permissionMode === 'ask') active.push('ask')
    else if (permissionMode === 'allow-all') active.push('allow-all')
    return active
  }, [permissionMode])

const handleSlashCommand = React.useCallback((commandId: SlashCommandId) => {
    if (commandId === 'safe') onPermissionModeChange?.('safe')
    else if (commandId === 'ask') onPermissionModeChange?.('ask')
    else if (commandId === 'allow-all') onPermissionModeChange?.('allow-all')
    else if (commandId === 'compact' && !isProcessing) onSubmit('/compact', undefined)
  }, [onPermissionModeChange, isProcessing, onSubmit])

const handleSlashFolderSelect = React.useCallback((path: string) => {
    if (onWorkingDirectoryChange) {
      setRecentFolders(addRecentWorkingDir(path, workspaceId))
      onWorkingDirectoryChange(path)
    }
  }, [onWorkingDirectoryChange, workspaceId])

const [recentFolders, setRecentFolders] = React.useState<string[]>([])

const [homeDir, setHomeDir] = React.useState<string>('')

React.useEffect(() => {
    setRecentFolders(getRecentWorkingDirs(workspaceId))
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir)
    })
  }, [workspaceId])

const inlineSlash = useInlineSlashCommand({
    inputRef: richInputRef,
    onSelectCommand: handleSlashCommand,
    onSelectFolder: handleSlashFolderSelect,
    activeCommands,
    recentFolders,
    homeDir,
  })

const handleInlineMentionSideEffect = React.useCallback(() => undefined, [])

const inlineMention = useInlineMention({
    inputRef: richInputRef,
    skills,
    sources: [],
    ...(workingDirectory !== undefined ? { basePath: workingDirectory } : {}),
    onSelect: handleInlineMentionSideEffect,
    // Use workspace slug (not UUID) for SDK skill qualification
    ...(workspaceSlug !== undefined ? { workspaceId: workspaceSlug } : {}),
  })

const handleLabelSelect = React.useCallback((labelId: string) => {
    onLabelAdd?.(labelId)
  }, [onLabelAdd])
return { handleLabelSelect, getNextPastedNumber, homeDir, inlineMention, inlineSlash, activeCommands }
}
