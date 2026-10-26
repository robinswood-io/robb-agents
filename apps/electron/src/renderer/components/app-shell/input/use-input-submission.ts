import * as React from 'react';

import { type SlashCommandId } from '@/components/ui/slash-command-menu';
import { type MentionItem } from '@/components/ui/mention-menu';

import { parseMentions } from '@/lib/mentions';
import { type RichTextInputHandle } from '@/components/ui/rich-text-input';

import { coerceInputText } from '@/lib/input-text';

import { applySmartTypography } from '@/lib/smart-typography';

import type { FileAttachment, LoadedSkill } from '../../../../shared/types';

import { hasOpenOverlay } from '@/lib/overlay-detection';

import { shouldHandleScopedInputEvent } from './input-event-guards';

import { type FollowUpInputItem } from "./free-form-input-contracts";

interface useInputSubmissionInput {
  input: string
  attachments: FileAttachment[]
  followUpItems: FollowUpInputItem[]
  disabled: boolean
  disableSend: boolean
  skills: LoadedSkill[]
  onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  setInput: React.Dispatch<React.SetStateAction<string>>
  setAttachments: React.Dispatch<React.SetStateAction<FileAttachment[]>>
  syncTimeoutRef: React.RefObject<NodeJS.Timeout | null>
  onInputChange: ((value: string) => void) | undefined
  onAttachmentsChange: ((attachments: FileAttachment[]) => void) | undefined
  prevInputValueRef: React.RefObject<string>
  richInputRef: React.RefObject<RichTextInputHandle | null>
  onWorkingDirectoryChange: ((path: string) => void) | undefined
  homeDir: string
  sessionId: string | undefined
  isFocusedPanel: boolean
  onStop: ((silent?: boolean) => void) | undefined
  inlineMention: import("@/components/ui/mention-menu").UseInlineMentionReturn
  inlineSlash: import("@/components/ui/slash-command-menu").UseInlineSlashCommandReturn
  inlineLabel: import("@/components/ui/label-menu").UseInlineLabelMenuReturn
  sendMessageKey: "enter" | "cmd-enter"
  inputRef: React.RefObject<string>
  syncToParent: (value: string) => void
  autoCapitalisation: boolean
  onSessionStatusChange: ((sessionId: string, state: import("@craft-agent/shared/protocol").SessionStatus) => void) | undefined
}

export function useInputSubmission({
  input,
  attachments,
  followUpItems,
  disabled,
  disableSend,
  skills,
  onSubmit,
  setInput,
  setAttachments,
  syncTimeoutRef,
  onInputChange,
  onAttachmentsChange,
  prevInputValueRef,
  richInputRef,
  onWorkingDirectoryChange,
  homeDir,
  sessionId,
  isFocusedPanel,
  onStop,
  inlineMention,
  inlineSlash,
  inlineLabel,
  sendMessageKey,
  inputRef,
  syncToParent,
  autoCapitalisation,
  onSessionStatusChange,
}: useInputSubmissionInput) {
const submitMessage = React.useCallback(() => {
    const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0
    if (!hasContent || disabled) return false

    // Tutorial may disable sending to guide user through specific steps
    if (disableSend) return false

    // Parse explicit @mentions (skills and folders). Sources are activated by
    // the runtime when the agent needs them, not by a composer selection.
    const skillSlugs = skills.map(s => s.slug)
    const mentions = parseMentions(input, skillSlugs, [])

    const attachmentSnapshot = attachments

    onSubmit(
      input.trim(),
      attachmentSnapshot.length > 0 ? attachmentSnapshot : undefined,
      mentions.skills.length > 0 ? mentions.skills : undefined
    )
    setInput('')
    setAttachments([])
    // Clear draft immediately (cancel any pending debounced sync)
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    onAttachmentsChange?.([])
    prevInputValueRef.current = ''

    // Restore focus after state updates
    requestAnimationFrame(() => {
      richInputRef.current?.focus()
    })

    return true
  }, [input, attachments, followUpItems, disabled, disableSend, onInputChange, onAttachmentsChange, onSubmit, skills, prevInputValueRef, richInputRef, setAttachments, setInput, syncTimeoutRef])

React.useEffect(() => {
    const handleSubmitInput = (e: CustomEvent<{ sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return
      submitMessage()
    }

    window.addEventListener('craft:submit-input', handleSubmitInput as EventListener)
    return () => window.removeEventListener('craft:submit-input', handleSubmitInput as EventListener)
  }, [sessionId, isFocusedPanel, submitMessage])

const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    submitMessage()
  }

const handleStop = (silent = false) => {
    onStop?.(silent)
  }

const handleKeyDown = (e: React.KeyboardEvent) => {
    // During IME composition, ESC should cancel composition, not trigger app/menu ESC behavior.
    if (e.key === 'Escape' && e.nativeEvent.isComposing) {
      return
    }

    // Don't submit when mention menu is open AND has visible content
    if (inlineMention.isOpen) {
      // Only intercept navigation/selection keys if menu actually shows items or is loading
      const hasVisibleContent = inlineMention.sections.some(s => s.items.length > 0) || inlineMention.isSearching
      if (hasVisibleContent && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // These keys are handled by the InlineMentionMenu component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineMention.close()
        return
      }
    }

    // Don't submit when slash command menu is open - let it handle the Enter key
    if (inlineSlash.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // These keys are handled by the InlineSlashCommand component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineSlash.close()
        return
      }
    }

    // Don't submit when label menu is open - let it handle navigation keys
    if (inlineLabel.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineLabel.close()
        return
      }
    }

    // Skip submission during IME composition - user is confirming composed characters, not sending
    // Handle send key based on user preference:
    // - 'enter': Enter sends (Shift+Enter for newline)
    // - 'cmd-enter': ⌘/Ctrl+Enter sends (Enter for newline)
    if (sendMessageKey === 'enter') {
      // Enter sends, Shift+Enter adds newline
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // Also allow Cmd/Ctrl+Enter to send (power user shortcut)
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
    } else {
      // cmd-enter mode: ⌘/Ctrl+Enter sends, plain Enter adds newline
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // Plain Enter is allowed to pass through (adds newline)
    }
    if (e.key === 'Escape') {
      // Skip blur if a popover/overlay is open — let the overlay handle ESC instead.
      // This prevents the input from consuming ESC when focus gets pulled back here
      // while a popover is still visible (portal DOM isolation means the event won't
      // reach the popover's DismissableLayer otherwise).
      if (!hasOpenOverlay()) {
        richInputRef.current?.blur()
      }
    }
  }

const handleInputChange = React.useCallback((value: string) => {
    const nextValue = coerceInputText(value)
    // Get previous input value before updating state
    const prevValue = inputRef.current

    setInput(nextValue)
    syncToParent(nextValue) // Debounced sync to parent for draft persistence

  }, [syncToParent, inputRef, setInput])

const handleRichInput = React.useCallback((value: string, cursorPosition: number) => {
    const nextValue = coerceInputText(value)

    // Update inline slash command state
    inlineSlash.handleInputChange(nextValue, cursorPosition)

    // Update inline mention state (for @mentions - skills and folders)
    inlineMention.handleInputChange(nextValue, cursorPosition)

    // Update inline label state (for #labels)
    inlineLabel.handleInputChange(nextValue, cursorPosition)

    // Auto-capitalize first letter (but not for slash commands, @mentions, or #labels)
    // Only if autoCapitalisation setting is enabled
    let newValue = nextValue
    if (autoCapitalisation && nextValue.length > 0 && nextValue.charAt(0) !== '/' && nextValue.charAt(0) !== '@' && nextValue.charAt(0) !== '#') {
      const capitalizedFirst = nextValue.charAt(0).toUpperCase()
      if (capitalizedFirst !== nextValue.charAt(0)) {
        newValue = capitalizedFirst + nextValue.slice(1)
        // Set cursor position BEFORE state update so it's used when useEffect syncs the value
        richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
        setInput(newValue)
        syncToParent(newValue)
        return
      }
    }

    // Apply smart typography (-> to →, etc.)
    const typography = applySmartTypography(nextValue, cursorPosition)
    if (typography.replaced) {
      newValue = typography.text
      // Set cursor position BEFORE state update so it's used when useEffect syncs the value
      richInputRef.current?.setSelectionRange(typography.cursor, typography.cursor)
      setInput(newValue)
      syncToParent(newValue)
    }
  }, [inlineSlash, inlineMention, inlineLabel, syncToParent, autoCapitalisation, richInputRef, setInput])

const handleInlineSlashCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    const newValue = inlineSlash.handleSelectCommand(commandId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent, richInputRef, setInput])

const handleInlineSlashFolderSelect = React.useCallback((path: string) => {
    const newValue = inlineSlash.handleSelectFolder(path)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent, richInputRef, setInput])

const handleInlineMentionSelect = React.useCallback((item: MentionItem) => {
    const { value: newValue, cursorPosition } = inlineMention.handleSelect(item)
    setInput(newValue)
    syncToParent(newValue)
    // Focus input and restore cursor position after badge renders
    setTimeout(() => {
      richInputRef.current?.focus()
      richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    }, 0)
  }, [inlineMention, syncToParent, richInputRef, setInput])

const handleInlineLabelSelect = React.useCallback((labelId: string) => {
    const newValue = inlineLabel.handleSelect(labelId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineLabel, syncToParent, richInputRef, setInput])

const handleInlineStateSelect = React.useCallback((stateId: string) => {
    const newValue = inlineLabel.handleSelect('')
    setInput(newValue)
    syncToParent(newValue)
    if (sessionId) {
      onSessionStatusChange?.(sessionId, stateId)
    }
    richInputRef.current?.focus()
  }, [inlineLabel, syncToParent, sessionId, onSessionStatusChange, richInputRef, setInput])
return { handleSubmit, handleInlineSlashCommandSelect, handleInlineSlashFolderSelect, handleInlineMentionSelect, handleInlineLabelSelect, handleInlineStateSelect, handleInputChange, handleRichInput, handleKeyDown, handleStop }
}
