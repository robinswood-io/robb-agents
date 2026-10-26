import * as React from 'react';

import { ArrowUp, Square, ChevronUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { InlineSlashCommand, type SlashCommandId } from '@/components/ui/slash-command-menu';
import { InlineMentionMenu, type MentionItem } from '@/components/ui/mention-menu';
import { InlineLabelMenu } from '@/components/ui/label-menu';

import { RichTextInput, type RichTextInputHandle } from '@/components/ui/rich-text-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui';

import { cn } from '@/lib/utils';

import { AttachmentPreview } from '../AttachmentPreview';
import { ImageSupportWarningBanner } from './ImageSupportWarningBanner';
import { getModelContextWindow, type ModelDefinition } from '@config/models';

import { EditPopover } from '@/components/ui/EditPopover';

import type { FileAttachment, LoadedSkill } from '../../../../shared/types';
import { type PermissionMode } from '@craft-agent/shared/agent/modes';
import { type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';

import { ToolbarStatusSlot } from './ToolbarStatusSlot';

import { FreeFormFollowUpChips } from "./FreeFormFollowUpChips";
import { FreeFormCompactToolbar } from "./FreeFormCompactToolbar";
import { FreeFormDesktopAttachmentBadge } from "./FreeFormDesktopAttachmentBadge";
import { FreeFormModelMenu } from "./FreeFormModelMenu";
import { type FollowUpInputItem } from "./free-form-input-contracts";

interface FreeFormInputViewProps {
  handleSubmit: (e: React.FormEvent) => Promise<void>; containerRef: React.RefObject<HTMLDivElement | null>; unstyled: boolean;
  isDraggingOver: boolean; handleDragEnter: (e: React.DragEvent) => void; handleDragLeave: (e: React.DragEvent) => void;
  handleDragOver: (e: React.DragEvent) => void; handleDrop: (e: React.DragEvent) => Promise<void>; inlineSlash: import("@/components/ui/slash-command-menu").UseInlineSlashCommandReturn;
  activeCommands: SlashCommandId[]; handleInlineSlashCommandSelect: (commandId: SlashCommandId) => void; handleInlineSlashFolderSelect: (path: string) => void;
  inlineMention: import("@/components/ui/mention-menu").UseInlineMentionReturn; handleInlineMentionSelect: (item: MentionItem) => void; workspaceId: string | undefined;
  inlineLabel: import("@/components/ui/label-menu").UseInlineLabelMenuReturn; handleInlineLabelSelect: (labelId: string) => void; handleAddLabel: (prefill: string) => void;
  handleInlineStateSelect: (stateId: string) => void; addLabelEditConfig: import("@/components/ui/EditPopover").EditConfig | null; addLabelPopoverOpen: boolean;
  setAddLabelPopoverOpen: React.Dispatch<React.SetStateAction<boolean>>; addLabelPrefill: string; workspaceRootPath: string | null;
  showVisionWarning: boolean; effectiveConnectionDetails: import("@config/llm-connections").LlmConnectionWithStatus | null; currentModelDisplayName: string;
  handleToggleModelVision: import("./useModelVisionToggle").ToggleModelVision; currentModel: string; attachments: FileAttachment[];
  handleRemoveAttachment: (index: number) => void; disabled: boolean; loadingCount: number;
  followUpItems: FollowUpInputItem[]; animateFollowUpLayout: boolean; t: import("i18next").TFunction<"translation", undefined>;
  onFollowUpClick: ((item: FollowUpInputItem, anchor?: { x: number; y: number; }) => void) | undefined; onFollowUpIndexClick: ((item: FollowUpInputItem) => void) | undefined; isCollapsedInCompact: boolean;
  richInputRef: React.RefObject<RichTextInputHandle | null>; input: string; handleInputChange: (value: string) => void;
  handleRichInput: (value: string, cursorPosition: number) => void; handleKeyDown: (e: React.KeyboardEvent) => void; handlePaste: (e: React.ClipboardEvent) => Promise<void>;
  handleLongTextPaste: (text: string) => void; setIsFocused: React.Dispatch<React.SetStateAction<boolean>>; onFocusChange: ((focused: boolean) => void) | undefined;
  lastCaretPositionRef: React.RefObject<number | null>; effectivePlaceholder: string | string[]; skills: LoadedSkill[];
  workspaceSlug: string | undefined; inputMaxHeight: number; spellCheck: boolean;
  isProcessing: boolean; showEscapeOverlay: boolean; sessionId: string | undefined;
  compactMode: boolean; fileInputRef: React.RefObject<HTMLInputElement | null>; handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onPermissionModeChange: ((mode: PermissionMode) => void) | undefined; permissionMode: PermissionMode; enableCompactModelPicker: boolean;
  currentConnection: string | undefined; onModelChange: (model: string | null, connection?: string) => void; onConnectionChange: ((connectionSlug: string) => void) | undefined;
  thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max"; onThinkingLevelChange: ((level: ThinkingLevel) => void) | undefined; isEmptySession: boolean;
  connectionUnavailable: boolean; contextStatus: { isCompacting?: boolean; inputTokens?: number; contextWindow?: number; } | undefined; handleAttachClick: () => void;
  onWorkingDirectoryChange: ((path: string) => void) | undefined; workingDirectory: string | undefined; sessionFolderPath: string | undefined;
  onRequestExpand: (() => void) | undefined; modelDropdownOpen: boolean; setModelDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectorDisplayName: string; llmConnections: import("@config/llm-connections").LlmConnectionWithStatus[]; pickerMode: import("./picker-mode").PickerMode;
  connectionDefaultModel: string | null; connectionsByProvider: [string, import("@config/llm-connections").LlmConnectionWithStatus[]][]; effectiveConnection: string | undefined;
  currentConnectionDetails: import("@config/llm-connections").LlmConnectionWithStatus | null; availableModels: (string | ModelDefinition)[]; availableThinkingLevels: readonly import("@craft-agent/shared/agent").ThinkingLevelDefinition[];
  thinkingDisabled: boolean; onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void; handleStop: (silent?: boolean) => void;
  hasContent: string | boolean; disableSend: boolean;
}

export function FreeFormInputView({
  handleSubmit, containerRef, unstyled,
  isDraggingOver, handleDragEnter, handleDragLeave,
  handleDragOver, handleDrop, inlineSlash,
  activeCommands, handleInlineSlashCommandSelect, handleInlineSlashFolderSelect,
  inlineMention, handleInlineMentionSelect, workspaceId,
  inlineLabel, handleInlineLabelSelect, handleAddLabel,
  handleInlineStateSelect, addLabelEditConfig, addLabelPopoverOpen,
  setAddLabelPopoverOpen, addLabelPrefill, workspaceRootPath,
  showVisionWarning, effectiveConnectionDetails, currentModelDisplayName,
  handleToggleModelVision, currentModel, attachments,
  handleRemoveAttachment, disabled, loadingCount,
  followUpItems, animateFollowUpLayout, t,
  onFollowUpClick, onFollowUpIndexClick, isCollapsedInCompact,
  richInputRef, input, handleInputChange,
  handleRichInput, handleKeyDown, handlePaste,
  handleLongTextPaste, setIsFocused, onFocusChange,
  lastCaretPositionRef, effectivePlaceholder, skills,
  workspaceSlug, inputMaxHeight, spellCheck,
  isProcessing, showEscapeOverlay, sessionId,
  compactMode, fileInputRef, handleFileInputChange,
  onPermissionModeChange, permissionMode, enableCompactModelPicker,
  currentConnection, onModelChange, onConnectionChange,
  thinkingLevel, onThinkingLevelChange, isEmptySession,
  connectionUnavailable, contextStatus, handleAttachClick,
  onWorkingDirectoryChange, workingDirectory, sessionFolderPath,
  onRequestExpand, modelDropdownOpen, setModelDropdownOpen,
  selectorDisplayName, llmConnections, pickerMode,
  connectionDefaultModel, connectionsByProvider, effectiveConnection,
  currentConnectionDetails, availableModels, availableThinkingLevels,
  thinkingDisabled, onSubmit, handleStop,
  hasContent, disableSend,
}: FreeFormInputViewProps) {

  return (
    <form onSubmit={handleSubmit}>
      <div
        ref={containerRef}
        className={cn(
          'overflow-hidden transition-all',
          // Container styling - only when not wrapped by InputContainer
          !unstyled && 'rounded-[16px] shadow-middle',
          !unstyled && 'bg-background',
          isDraggingOver && 'ring-2 ring-foreground ring-offset-2 ring-offset-background bg-foreground/5'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Inline Slash Command Autocomplete */}
        <InlineSlashCommand
          open={inlineSlash.isOpen}
          onOpenChange={(open) => !open && inlineSlash.close()}
          sections={inlineSlash.sections}
          activeCommands={activeCommands}
          onSelectCommand={handleInlineSlashCommandSelect}
          onSelectFolder={handleInlineSlashFolderSelect}
          filter={inlineSlash.filter}
          position={inlineSlash.position}
        />

        {/* Inline Mention Autocomplete (skills and files) */}
        <InlineMentionMenu
          open={inlineMention.isOpen}
          onOpenChange={(open) => !open && inlineMention.close()}
          sections={inlineMention.sections}
          onSelect={handleInlineMentionSelect}
          filter={inlineMention.filter}
          position={inlineMention.position}
          workspaceId={workspaceId}
          maxWidth={280}
          isSearching={inlineMention.isSearching}
        />

        {/* Inline Label & State Autocomplete (#labels / #states) */}
        <InlineLabelMenu
          open={inlineLabel.isOpen}
          onOpenChange={(open) => !open && inlineLabel.close()}
          items={inlineLabel.items}
          onSelect={handleInlineLabelSelect}
          onAddLabel={handleAddLabel}
          filter={inlineLabel.filter}
          position={inlineLabel.position}
          states={inlineLabel.states}
          activeStateId={inlineLabel.activeStateId}
          onSelectState={handleInlineStateSelect}
        />

        {/* Controlled EditPopover for "Add New Label" — opens when user selects
            the option from the # menu with no matches.
            Spread the full config so optional fields like `inlineExecution`,
            `displayLabel`, and `displayLabelKey` reach the popover. The previous
            cherry-pick dropped `inlineExecution: true`, which made the popover
            fall back to the same-window deep-link path; that worked inside
            Electron but launched the desktop app from the WebUI via `craftagents://`.
            Match the AppShell pattern (which already uses spread). */}
        {addLabelEditConfig && (
          <EditPopover
            trigger={<span className="absolute top-0 left-0 w-0 h-0 overflow-hidden" />}
            open={addLabelPopoverOpen}
            onOpenChange={setAddLabelPopoverOpen}
            {...addLabelEditConfig}
            defaultValue={addLabelPrefill}
            secondaryAction={workspaceRootPath ? {
              label: 'Edit File',
              filePath: `${workspaceRootPath}/labels/config.json`,
            } : undefined}
            side="top"
            align="start"
          />
        )}

        {/* Pre-flight image-support warning — only for pi_compat connections
            where the renderer can both detect text-only models and offer to
            flip the per-model supportsImages override on the spot. */}
        {showVisionWarning && effectiveConnectionDetails && (
          <ImageSupportWarningBanner
            modelName={currentModelDisplayName}
            onEnable={() => handleToggleModelVision(effectiveConnectionDetails.slug, currentModel, true)}
          />
        )}

        {/* Attachment Preview */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          disabled={disabled}
          loadingCount={loadingCount}
        />

        {/* Follow-up context chips */}
        <FreeFormFollowUpChips
  followUpItems={followUpItems}
  animateFollowUpLayout={animateFollowUpLayout}
  t={t}
  onFollowUpClick={onFollowUpClick}
  onFollowUpIndexClick={onFollowUpIndexClick}
/>

        {/* Rich Text Input with inline mention badges */}
        {/* In compact mode, hide input while the agent is processing — until the
            user clicks / hovers the collapsed bar to expand it back. */}
        {!isCollapsedInCompact && (
        <RichTextInput
          ref={richInputRef}
          value={input}
          onChange={handleInputChange}
          onInput={handleRichInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onLongTextPaste={handleLongTextPaste}
          onFocus={() => { setIsFocused(true); onFocusChange?.(true) }}
          onBlur={() => {
            // Save caret position before losing focus (for restoration via craft:focus-input)
            lastCaretPositionRef.current = richInputRef.current?.selectionStart ?? null
            setIsFocused(false)
            onFocusChange?.(false)
          }}
          placeholder={effectivePlaceholder}
          disabled={disabled}
          skills={skills}
          workspaceId={workspaceSlug}
          className="pl-5 pr-4 pt-4 pb-3 overflow-y-auto min-h-[88px]"
          style={{ maxHeight: inputMaxHeight }}
          data-tutorial="chat-input"
          spellCheck={spellCheck}
        />
        )}

        {/* Bottom Row: Controls - wrapped in relative container for status slot overlay */}
        <div className="relative">
          {/* Status slot overlay - escape interrupt (highest priority), browser status, etc. */}
          <ToolbarStatusSlot
            showEscapeOverlay={isProcessing && showEscapeOverlay}
            sessionId={sessionId}
          />

          <div className={cn(
            "flex items-center gap-1",
            compactMode ? "px-2.5 py-2" : "border-t border-border/50 px-2 py-2",
          )}>
          {/* Hidden file input for attach button (shared by compact and desktop) */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          {/* Compact mode: permission mode drawer + standard icon badges for attach/working dir.
              Wrapper absorbs all squeeze so the model label truncates first and the send button stays
              anchored to the right (craft-agents-oss#798). overflow-hidden is safe — Radix Drawer /
              dropdowns inside render via portals, so they aren't clipped. */}
          {compactMode && !isCollapsedInCompact && (
          <FreeFormCompactToolbar
  onPermissionModeChange={onPermissionModeChange}
  permissionMode={permissionMode}
  enableCompactModelPicker={enableCompactModelPicker}
  currentModel={currentModel}
  currentConnection={currentConnection}
  onModelChange={onModelChange}
  onConnectionChange={onConnectionChange}
  thinkingLevel={thinkingLevel}
  onThinkingLevelChange={onThinkingLevelChange}
  isEmptySession={isEmptySession}
  connectionUnavailable={connectionUnavailable}
  contextStatus={contextStatus}
  isProcessing={isProcessing}
  attachments={attachments}
  t={t}
  handleAttachClick={handleAttachClick}
  disabled={disabled}
  onWorkingDirectoryChange={onWorkingDirectoryChange}
  workingDirectory={workingDirectory}
  sessionFolderPath={sessionFolderPath}
  workspaceId={workspaceId}
/>
          )}

          {/* Desktop: full badges row with labels and working directory */}
          {!compactMode && (
          <FreeFormDesktopAttachmentBadge
  attachments={attachments}
  t={t}
  isEmptySession={isEmptySession}
  handleAttachClick={handleAttachClick}
  disabled={disabled}
  onWorkingDirectoryChange={onWorkingDirectoryChange}
  workingDirectory={workingDirectory}
  sessionFolderPath={sessionFolderPath}
  workspaceId={workspaceId}
/>
          )}

          {/* Spacer — doubles as a tap / hover target while the input is
              collapsed during processing in compact mode, so the user can
              type a follow-up without waiting for the agent to finish. */}
          {isCollapsedInCompact ? (
            <button
              type="button"
              onClick={onRequestExpand}
              onMouseEnter={onRequestExpand}
              aria-label={t('chat.tapToType')}
              className="flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-medium text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ChevronUp className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t('chat.tapToType')}</span>
            </button>
          ) : (
            <div className="flex-1" />
          )}

          {/* Right side: Model + Send - never shrink so they're always visible */}
          <div className="flex items-center shrink-0">
          {/* 5. Model/Connection Selector - Hidden in compact mode (EditPopover embedding) */}
          {!compactMode && (
          <FreeFormModelMenu
  modelDropdownOpen={modelDropdownOpen}
  setModelDropdownOpen={setModelDropdownOpen}
  isProcessing={isProcessing}
  connectionUnavailable={connectionUnavailable}
  t={t}
  selectorDisplayName={selectorDisplayName}
  effectiveConnectionDetails={effectiveConnectionDetails}
  llmConnections={llmConnections}
  pickerMode={pickerMode}
  connectionDefaultModel={connectionDefaultModel}
  handleToggleModelVision={handleToggleModelVision}
  connectionsByProvider={connectionsByProvider}
  effectiveConnection={effectiveConnection}
  currentModel={currentModel}
  onConnectionChange={onConnectionChange}
  onModelChange={onModelChange}
  isEmptySession={isEmptySession}
  currentConnectionDetails={currentConnectionDetails}
  availableModels={availableModels}
  availableThinkingLevels={availableThinkingLevels}
  thinkingDisabled={thinkingDisabled}
  thinkingLevel={thinkingLevel}
  onThinkingLevelChange={onThinkingLevelChange}
  contextStatus={contextStatus}
/>
          )}

          {/* 5.5 Context Usage Warning Badge - shows when approaching auto-compaction threshold */}
          {(() => {
            // Calculate usage percentage based on compaction threshold (~77.5% of context window),
            // not the full context window - this gives users meaningful warnings before compaction kicks in.
            // SDK triggers compaction at ~155k tokens for a 200k context window.
            // Falls back to known per-model context window when SDK hasn't reported usage yet.
            const effectiveContextWindow = contextStatus?.contextWindow || getModelContextWindow(currentModel)
            const compactionThreshold = effectiveContextWindow
              ? Math.round(effectiveContextWindow * 0.775)
              : null
            const usagePercent = contextStatus?.inputTokens && compactionThreshold
              ? Math.min(99, Math.round((contextStatus.inputTokens / compactionThreshold) * 100))
              : null
            // Show badge when >= 80% of compaction threshold AND not currently compacting
            // Hide for Codex and Copilot models which don't support context compaction
            const showWarning = usagePercent !== null && usagePercent >= 80 && !contextStatus?.isCompacting

            if (!showWarning) return null

            const handleCompactClick = () => {
              if (!isProcessing) {
                onSubmit('/compact', [])
              }
            }

            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCompactClick}
                    disabled={isProcessing}
                    className="inline-flex items-center h-6 px-2 text-[12px] font-medium bg-info/10 rounded-[6px] shadow-tinted select-none cursor-pointer hover:bg-info/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      '--shadow-color': 'var(--info-rgb)',
                      color: 'color-mix(in oklab, var(--info) 30%, var(--foreground))',
                    } as React.CSSProperties}
                  >
                    {usagePercent}%
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isProcessing
                    ? `${usagePercent}% context used — wait for current operation`
                    : `${usagePercent}% context used — click to compact`
                  }
                </TooltipContent>
              </Tooltip>
            )
          })()}

          {/* 6. Send/Stop Button - Always show stop when processing */}
          {isProcessing ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label={t('chat.stopResponse')}
              className="send-btn h-7 w-7 rounded-full shrink-0 hover:bg-foreground/15 active:bg-foreground/20 active:scale-95 ml-2 shadow-minimal transition-transform"
              onClick={() => handleStop(false)}
            >
              <Square className="h-3 w-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              aria-label={t('shortcuts.sendMessage')}
              className="send-btn h-7 w-7 rounded-full shrink-0 ml-2 shadow-minimal transition-transform active:scale-95"
              disabled={!hasContent || disabled || disableSend}
              data-tutorial="send-button"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
          </div>
          </div>
        </div>
      </div>
    </form>
  )
}
