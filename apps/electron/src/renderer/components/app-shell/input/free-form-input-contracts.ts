import * as React from 'react';

import type { LabelConfig } from '@craft-agent/shared/labels';

import { type RichTextInputHandle } from '@/components/ui/rich-text-input';

import type { FileAttachment, LoadedSkill } from '../../../../shared/types';
import { type PermissionMode } from '@craft-agent/shared/agent/modes';
import { type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';

export interface FollowUpInputItem {
  id: string
  messageId: string
  annotationId: string
  index?: number
  noteLabel: string
  selectedText: string
  color?: string | undefined
}

export interface FreeFormInputProps {
  /** Placeholder text(s) for the textarea - can be array for rotation */
  placeholder?: string | string[] | undefined
  /** Whether input is disabled */
  disabled?: boolean | undefined
  /** Whether the session is currently processing */
  isProcessing?: boolean | undefined
  /** Callback when message is submitted (skillSlugs from @mentions) */
  onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  /** Callback to stop processing. Pass silent=true to skip "Response interrupted" message */
  onStop?: ((silent?: boolean) => void) | undefined
  /** External ref for the input */
  inputRef?: React.RefObject<RichTextInputHandle | null> | undefined
  /** Current model ID */
  currentModel: string
  /** Callback when model changes (includes connection slug for proper persistence) */
  onModelChange: (model: string | null, connection?: string) => void
  /** Whether the workspace allows returning this session to automatic selection. */
  /** Whether the current effective model was selected automatically. */
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel | undefined
  /** Callback when thinking level changes */
  onThinkingLevelChange?: ((level: ThinkingLevel) => void) | undefined
  // Advanced options
  permissionMode?: PermissionMode | undefined
  onPermissionModeChange?: ((mode: PermissionMode) => void) | undefined
  /** Enabled permission modes for Shift+Tab cycling (min 2 modes) */
  enabledModes?: PermissionMode[] | undefined
  // Controlled input value (for persisting across mode switches and conversation changes)
  /** Current input value - if provided, component becomes controlled */
  inputValue?: string | undefined
  /** Callback when input value changes */
  onInputChange?: ((value: string) => void) | undefined
  /** Persisted attachment draft for this session (seeds local state on session switch) */
  attachmentsValue?: FileAttachment[] | undefined
  /** Callback when attachment list changes (add, remove, clear on send) */
  onAttachmentsChange?: ((attachments: FileAttachment[]) => void) | undefined
  /** When true, removes container styling (shadow, bg, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean | undefined
  /** Callback when component height changes (for external animation sync) */
  onHeightChange?: ((height: number) => void) | undefined
  /** Callback when focus state changes */
  onFocusChange?: ((focused: boolean) => void) | undefined
  // Skill selection (for @mentions)
  /** Available skills for @mention autocomplete */
  skills?: LoadedSkill[] | undefined
  // Label selection (for #labels)
  /** Available labels for #label autocomplete */
  labels?: LabelConfig[] | undefined
  /** Currently applied session labels */
  sessionLabels?: string[] | undefined
  /** Callback when a label is added via # menu */
  onLabelAdd?: ((labelId: string) => void) | undefined
  /** Workspace ID for loading skill icons */
  workspaceId?: string | undefined
  /** Current working directory path */
  workingDirectory?: string | undefined
  /** Callback when working directory changes */
  onWorkingDirectoryChange?: ((path: string) => void) | undefined
  /** Session folder path (for "Reset to Session Root" option) */
  sessionFolderPath?: string | undefined
  /** Session ID for scoping events like approve-plan */
  sessionId?: string | undefined
  /** Current session status of the session (for # menu state selection) */
  currentSessionStatus?: string | undefined
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean | undefined
  /** Whether the session is empty (no messages yet) - affects context badge prominence */
  isEmptySession?: boolean | undefined
  /** Context status for showing compaction indicator and token usage */
  contextStatus?: {
    /** True when SDK is actively compacting the conversation */
    isCompacting?: boolean
    /** Input tokens used so far in this session */
    inputTokens?: number
    /** Model's context window size in tokens */
    contextWindow?: number
  } | undefined
  /** Follow-up annotations shown as context chips above the input */
  followUpItems?: FollowUpInputItem[] | undefined
  /** Callback when user clicks a follow-up chip body */
  onFollowUpClick?: ((item: FollowUpInputItem, anchor?: { x: number; y: number }) => void) | undefined
  /** Callback when user clicks the follow-up index badge */
  onFollowUpIndexClick?: ((item: FollowUpInputItem) => void) | undefined
  /**
   * Compact-footer layout. Used by EditPopover (popover embedding) and by
   * ChatPage in auto-compact / WebUI mobile mode. The popover case hides the
   * model picker; the auto-compact case opts the compact picker in via
   * `enableCompactModelPicker`.
   */
  compactMode?: boolean | undefined
  /**
   * When `compactMode` is true, render the compact (drawer-based) model
   * selector next to the permission-mode pill. Defaults to false so that
   * EditPopover (which has no use for a model picker) keeps its current
   * behavior.
   */
  enableCompactModelPicker?: boolean | undefined
  // Explicit connection, model, and reasoning choices.
  /** Current LLM connection slug. */
  currentConnection?: string | undefined
  /** Callback when the provider changes between idle turns. */
  onConnectionChange?: ((connectionSlug: string) => void) | undefined
  /** When true, the session's locked connection has been removed */
  connectionUnavailable?: boolean | undefined
  /**
   * True when the input is collapsed because the agent is processing in
   * compact mode and the user hasn't expanded it yet. Owned by
   * `InputContainer`; toggle back via `onRequestExpand`.
   */
  isCollapsedInCompact?: boolean | undefined
  /** Callback fired when the user clicks or hovers the collapsed-input strip. */
  onRequestExpand?: (() => void) | undefined
}
