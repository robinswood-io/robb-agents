import * as React from 'react';
import { useTranslation } from "react-i18next";
import "motion/react";
import "lucide-react";
import "@craft-agent/ui";
import "@/lib/local-storage";
import "@/components/ui/button";
import "@/components/ui/slash-command-menu";
import "@/components/ui/mention-menu";
import "@/components/ui/label-menu";
import "@/lib/mentions";
import "@/components/ui/rich-text-input";
import "@craft-agent/ui";
import "@/components/ui/dropdown-menu";
import "@/components/ui/styled-dropdown";
import "@/lib/utils";
import { coerceInputText } from '@/lib/input-text';
import "@/lib/platform";
import "@/lib/smart-typography";
import "../AttachmentPreview";
import "./ImageSupportWarningBanner";
import "@config/models";
import "@config/llm-connections";
import "@/context/AppShellContext";
import "@/components/ui/EditPopover";
import "@/components/ui/CompactWorkingDirectorySelector";
import "@/components/icons/ConnectionIcon";
import "./FreeFormInputContextBadge";
import "./picker-mode";
import "@craft-agent/shared/agent/modes";
import "@craft-agent/shared/agent/thinking-levels";
import "@/context/EscapeInterruptContext";
import "@/lib/overlay-detection";
import "./ToolbarStatusSlot";
import "../plan-approval-message";
import "./input-event-guards";
import "./viewport-height";
import "./focus-input-events";
import "./working-directory-history";
import "./WorkingDirectorySelector";
import "./CompactPermissionModeSelector";
import "./CompactModelSelector";
import "./model-picker-helpers";
import "./useModelVisionToggle";

import { useInputLayout } from "./use-input-layout";













































import { useInputSubmission } from "./use-input-submission";

import { useInputAttachmentEvents } from "./use-input-attachment-events";

import { useInputInlineLabels } from "./use-input-inline-labels";

import { useInputEditorMenus } from "./use-input-editor-menus";

import { useInputUiState } from "./use-input-ui-state";

import { useInputAttachmentSync } from "./use-input-attachment-sync";

import { useInputPlaceholder } from "./use-input-placeholder";

import { useInputModelOptions } from "./use-input-model-options";

import { FreeFormInputView } from "./free-form-input-view";
import { type FreeFormInputProps } from "./free-form-input-contracts";

export { type FollowUpInputItem, type FreeFormInputProps } from "./free-form-input-contracts";































import type { FileAttachment } from '../../../../shared/types';
















/**
 * FreeFormInput - Self-contained textarea input with attachments and controls
 *
 * Features:
 * - Auto-growing textarea
 * - File attachments via button or drag-drop
 * - Slash commands menu
 * - Model selector
 * - Active option badges
 */
export function FreeFormInput({
  placeholder,
  disabled = false,
  isProcessing = false,
  onSubmit,
  onStop,
  inputRef: externalInputRef,
  currentModel,
  onModelChange,
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  permissionMode = 'ask',
  onPermissionModeChange,
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  unstyled = false,
  onHeightChange,
  onFocusChange,
  skills = [],
  labels = [],
  sessionLabels = [],
  onLabelAdd,
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  sessionId,
  currentSessionStatus,
  disableSend = false,
  isEmptySession = false,
  contextStatus,
  followUpItems = [],
  onFollowUpClick,
  onFollowUpIndexClick,
  compactMode = false,
  enableCompactModelPicker = false,
  currentConnection,
  onConnectionChange,
  connectionUnavailable = false,
  isCollapsedInCompact = false,
  onRequestExpand,
}: FreeFormInputProps) {
  const { t } = useTranslation()

  // Default rotating placeholders for onboarding/empty state (i18n-aware)
  const {
    appShellCtx,
    effectivePlaceholderProp,
    effectiveConnectionDetails,
    currentModelDisplayName,
    selectorDisplayName,
    llmConnections,
    pickerMode,
    connectionDefaultModel,
    connectionsByProvider,
    effectiveConnection,
    currentConnectionDetails,
    availableModels,
    availableThinkingLevels,
    thinkingDisabled,
  } = useInputModelOptions({
    t, placeholder, currentConnection,
    connectionUnavailable, isEmptySession, currentModel,
  })

  // Access sessionStatuses and onSessionStatusChange from context for the # menu state picker
  const {
    isFocusedPanel,
    workspaceSlug,
    sessionStatuses,
    workspaceRootPath,
    onSessionStatusChange,
    effectivePlaceholder,
  } = useInputPlaceholder({
    appShellCtx, workspaceId, placeholder,
    compactMode, effectivePlaceholderProp,
  })

  // Performance optimization: Always use internal state for typing to avoid parent re-renders
  // Sync FROM parent on mount/change (for restoring drafts)
  // Sync TO parent on blur/submit (debounced persistence)
  const [input, setInput] = React.useState(() => coerceInputText(inputValue))
  const [attachments, setAttachments] = React.useState<FileAttachment[]>(attachmentsValue ?? [])

  // Ref to track current attachments for use in event handlers (avoids stale closure issues)
  const {
    syncTimeoutRef,
    prevInputValueRef,
    syncToParent,
    attachmentsRef,
  } = useInputAttachmentSync({
    attachments, attachmentsValue, setAttachments,
    onAttachmentsChange, inputValue, setInput,
    onInputChange,
  })

  // Sync immediately on unmount to preserve input across mode switches
  // Also cleanup any pending debounced sync
  const {
    clearInputDraft,
    richInputRef,
    lastCaretPositionRef,
    setLoadingCount,
    containerRef,
    fileInputRef,
    dragCounterRef,
    setIsDraggingOver,
    sendMessageKey,
    inputRef,
    autoCapitalisation,
    isDraggingOver,
    handleToggleModelVision,
    loadingCount,
    setIsFocused,
    inputMaxHeight,
    spellCheck,
    showEscapeOverlay,
    modelDropdownOpen,
    setModelDropdownOpen,
  } = useInputUiState({
    input, syncTimeoutRef, onInputChange,
    prevInputValueRef, externalInputRef, sessionId,
    isFocusedPanel, setInput, syncToParent,
  })

  const {
    handleLabelSelect,
    getNextPastedNumber,
    homeDir,
    inlineMention,
    inlineSlash,
    activeCommands,
  } = useInputEditorMenus({
    input, clearInputDraft, sessionId,
    permissionMode, onPermissionModeChange, onSubmit,
    isFocusedPanel, richInputRef, lastCaretPositionRef,
    disabled, setLoadingCount, attachmentsRef,
    readFileAsAttachment: (...args) => readFileAsAttachment(...args), setAttachments, isProcessing,
    onWorkingDirectoryChange, workspaceId, skills,
    workingDirectory, workspaceSlug, onLabelAdd,
  })

  const {
    inlineLabel,
    handleAddLabel,
    addLabelEditConfig,
    addLabelPopoverOpen,
    setAddLabelPopoverOpen,
    addLabelPrefill,
  } = useInputInlineLabels({
    richInputRef, labels, sessionLabels,
    handleLabelSelect, sessionStatuses, currentSessionStatus,
    workspaceRootPath, setInput, syncToParent,
    t,
  })

  // Report height changes to parent (for external animation sync)
  React.useLayoutEffect(() => {
    if (!onHeightChange || !containerRef.current) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(entry.contentRect.height)
      }
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [onHeightChange, containerRef])

  // In compact mode, immediately report collapsed height when the input is
  // collapsed during processing. This ensures smooth animation timing.
  // When the user expands (or processing ends), the ResizeObserver takes
  // over and reports the actual rendered height.
  React.useEffect(() => {
    if (!onHeightChange) return
    if (isCollapsedInCompact) {
      // Collapsed state - only bottom bar visible (~44px)
      onHeightChange(44)
    }
  }, [isCollapsedInCompact, onHeightChange])

  // Check if running in Electron environment (has electronAPI)
  const {
    readFileAsAttachment,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleRemoveAttachment,
    handlePaste,
    handleLongTextPaste,
    handleFileInputChange,
    handleAttachClick,
  } = useInputAttachmentEvents({
    setAttachments, setLoadingCount, disabled,
    fileInputRef, dragCounterRef, setIsDraggingOver,
    getNextPastedNumber, attachmentsRef, richInputRef,
  })

  // Submit message - backend handles queueing and interruption
  const {
    handleSubmit,
    handleInlineSlashCommandSelect,
    handleInlineSlashFolderSelect,
    handleInlineMentionSelect,
    handleInlineLabelSelect,
    handleInlineStateSelect,
    handleInputChange,
    handleRichInput,
    handleKeyDown,
    handleStop,
  } = useInputSubmission({
    input, attachments, followUpItems,
    disabled, disableSend, skills,
    onSubmit, setInput, setAttachments,
    syncTimeoutRef, onInputChange, onAttachmentsChange,
    prevInputValueRef, richInputRef, onWorkingDirectoryChange,
    homeDir, sessionId, isFocusedPanel,
    onStop, inlineMention, inlineSlash,
    inlineLabel, sendMessageKey, inputRef,
    syncToParent, autoCapitalisation, onSessionStatusChange,
  })

  const {
    showVisionWarning,
    animateFollowUpLayout,
    hasContent,
  } = useInputLayout({
    followUpItems, input, attachments,
    effectiveConnectionDetails, currentModel,
  })

  return (
    <FreeFormInputView
      handleSubmit={handleSubmit} containerRef={containerRef} unstyled={unstyled}
      isDraggingOver={isDraggingOver} handleDragEnter={handleDragEnter} handleDragLeave={handleDragLeave}
      handleDragOver={handleDragOver} handleDrop={handleDrop} inlineSlash={inlineSlash}
      activeCommands={activeCommands} handleInlineSlashCommandSelect={handleInlineSlashCommandSelect} handleInlineSlashFolderSelect={handleInlineSlashFolderSelect}
      inlineMention={inlineMention} handleInlineMentionSelect={handleInlineMentionSelect} workspaceId={workspaceId}
      inlineLabel={inlineLabel} handleInlineLabelSelect={handleInlineLabelSelect} handleAddLabel={handleAddLabel}
      handleInlineStateSelect={handleInlineStateSelect} addLabelEditConfig={addLabelEditConfig} addLabelPopoverOpen={addLabelPopoverOpen}
      setAddLabelPopoverOpen={setAddLabelPopoverOpen} addLabelPrefill={addLabelPrefill} workspaceRootPath={workspaceRootPath}
      showVisionWarning={showVisionWarning} effectiveConnectionDetails={effectiveConnectionDetails} currentModelDisplayName={currentModelDisplayName}
      handleToggleModelVision={handleToggleModelVision} currentModel={currentModel} attachments={attachments}
      handleRemoveAttachment={handleRemoveAttachment} disabled={disabled} loadingCount={loadingCount}
      followUpItems={followUpItems} animateFollowUpLayout={animateFollowUpLayout} t={t}
      onFollowUpClick={onFollowUpClick} onFollowUpIndexClick={onFollowUpIndexClick} isCollapsedInCompact={isCollapsedInCompact}
      richInputRef={richInputRef} input={input} handleInputChange={handleInputChange}
      handleRichInput={handleRichInput} handleKeyDown={handleKeyDown} handlePaste={handlePaste}
      handleLongTextPaste={handleLongTextPaste} setIsFocused={setIsFocused} onFocusChange={onFocusChange}
      lastCaretPositionRef={lastCaretPositionRef} effectivePlaceholder={effectivePlaceholder} skills={skills}
      workspaceSlug={workspaceSlug} inputMaxHeight={inputMaxHeight} spellCheck={spellCheck}
      isProcessing={isProcessing} showEscapeOverlay={showEscapeOverlay} sessionId={sessionId}
      compactMode={compactMode} fileInputRef={fileInputRef} handleFileInputChange={handleFileInputChange}
      onPermissionModeChange={onPermissionModeChange} permissionMode={permissionMode} enableCompactModelPicker={enableCompactModelPicker}
      currentConnection={currentConnection} onModelChange={onModelChange} onConnectionChange={onConnectionChange}
      thinkingLevel={thinkingLevel} onThinkingLevelChange={onThinkingLevelChange} isEmptySession={isEmptySession}
      connectionUnavailable={connectionUnavailable} contextStatus={contextStatus} handleAttachClick={handleAttachClick}
      onWorkingDirectoryChange={onWorkingDirectoryChange} workingDirectory={workingDirectory} sessionFolderPath={sessionFolderPath}
      onRequestExpand={onRequestExpand} modelDropdownOpen={modelDropdownOpen} setModelDropdownOpen={setModelDropdownOpen}
      selectorDisplayName={selectorDisplayName} llmConnections={llmConnections} pickerMode={pickerMode}
      connectionDefaultModel={connectionDefaultModel} connectionsByProvider={connectionsByProvider} effectiveConnection={effectiveConnection}
      currentConnectionDetails={currentConnectionDetails} availableModels={availableModels} availableThinkingLevels={availableThinkingLevels}
      thinkingDisabled={thinkingDisabled} onSubmit={onSubmit} handleStop={handleStop}
      hasContent={hasContent} disableSend={disableSend}
    />
  )
}
