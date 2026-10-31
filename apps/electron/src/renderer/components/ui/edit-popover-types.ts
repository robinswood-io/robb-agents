import * as React from 'react';









import type { ContentBadge, CreateSessionOptions } from "../../../shared/types";





/**
 * Context passed to the new chat session so the agent knows exactly
 * what is being edited and can execute quickly.
 *
 * Simplified structure: label for display, filePath for the agent to know
 * where to edit, and optional context for additional instructions.
 */
export interface EditContext {
  /** Human-readable label for badge display and agent context (e.g., "Permissions") */
  label: string
  /** Absolute path to the file being edited */
  filePath: string
  /** Optional additional context/instructions for the agent */
  context?: string
}


/* ============================================================================
 * EDIT CONTEXT REGISTRY - SINGLE SOURCE OF TRUTH
 * ============================================================================
 * ALL edit contexts MUST be defined here. This is the canonical location.
 *
 * DO NOT create EditContext objects inline elsewhere in the codebase.
 * Instead, use getEditConfig() exported from this file.
 *
 * To add a new edit context:
 * 1. Add a new key to EditContextKey type
 * 2. Add the config to EDIT_CONFIGS
 * 3. Use via getEditConfig(key, location)
 *
 * This pattern ensures:
 * - All edit prompts and examples are reviewed in one place
 * - Consistent messaging to the agent
 * - Easy updates when context format changes
 * ============================================================================ */

/** Available edit context keys - add new ones here */
export type EditContextKey =
  | 'workspace-permissions'
  | 'default-permissions'
  | 'skill-instructions'
  | 'skill-metadata'
  | 'source-guide'
  | 'source-config'
  | 'source-permissions'
  | 'source-tool-permissions'
  | 'preferences-notes'
  | 'add-source'
  | 'add-source-api'   // Filter-specific: user is viewing APIs
  | 'add-source-mcp'   // Filter-specific: user is viewing MCPs
  | 'add-source-local' // Filter-specific: user is viewing Local Folders
  | 'add-skill'
  | 'edit-statuses'
  | 'edit-labels'
  | 'edit-auto-rules'
  | 'add-label'
  | 'edit-views'
  | 'edit-tool-icons'
  | 'automation-config'


/**
 * Full edit configuration including context for agent and example for UI.
 * Returned by getEditConfig() for use in EditPopover.
 */
export interface EditConfig {
  /** Context passed to the agent */
  context: EditContext
  /** Example text shown in the popover placeholder */
  example: string
  /** Optional custom placeholder text - overrides the default "Describe what you'd like to change" */
  overridePlaceholder?: string
  /** Translated display label for UI (resolved from displayLabelKey, falls back to context.label) */
  displayLabel?: string
  /** i18n key for the display label (translated for UI, keeps context.label in English for agent) */
  displayLabelKey?: string
  /** i18n key for the example text */
  exampleKey?: string
  /** i18n key for overridePlaceholder */
  overridePlaceholderKey?: string
  /** Explicit model ID; omitted to inherit the workspace's configured model. */
  model?: string
  /** Optional system prompt preset for mini agent (e.g., 'mini' for focused edits) */
  systemPromptPreset?: 'default' | 'mini'
  /** When true, executes inline within the popover instead of opening a new window */
  inlineExecution?: boolean
}


/**
 * Optional secondary action button displayed on the left side of the popover footer.
 * Styled as plain text with underline on hover - typically used for "Edit File" actions.
 */
export interface SecondaryAction {
  /** Button label (e.g., "Edit File") */
  label: string
  /** File path to open directly in the system editor (bypasses link interceptor) */
  filePath: string
}


export interface EditPopoverProps {
  /** Trigger element that opens the popover */
  trigger: React.ReactNode
  /** Example text shown in placeholder (e.g., "Allow 'make build' command") */
  example?: string | undefined
  /** Context passed to the new chat session */
  context: EditContext
  /** Permission mode for the new session (default: 'allow-all' / canonical: execute for fast execution) */
  permissionMode?: CreateSessionOptions['permissionMode'] | undefined
  /**
   * Working directory for the new session:
   * - 'none' (default): No working directory (session folder only) - best for config edits
   * - 'user_default': Use workspace's configured default
   * - Absolute path string: Use this specific path
   */
  workingDirectory?: string | 'user_default' | 'none' | undefined
  /** Explicit model ID; omitted to inherit the workspace's configured model. */
  model?: string | undefined
  /** System prompt preset for mini agent (e.g., 'mini' for focused edits) */
  systemPromptPreset?: 'default' | 'mini' | undefined
  /** Width of the popover (default: 320) */
  width?: number | undefined
  /** Additional className for the trigger */
  triggerClassName?: string | undefined
  /** Side of the popover relative to trigger */
  side?: 'top' | 'right' | 'bottom' | 'left' | undefined
  /** Alignment of the popover */
  align?: 'start' | 'center' | 'end' | undefined
  /** Optional secondary action button on the left (e.g., "Edit File") */
  secondaryAction?: SecondaryAction | undefined
  /** Optional custom placeholder - overrides the default "Describe what you'd like to change" */
  overridePlaceholder?: string | undefined
  /** Translated display label for badges and empty state (falls back to context.label) */
  displayLabel?: string | undefined
  /**
   * Controlled open state - when provided, the popover becomes controlled.
   * Use this when opening the popover programmatically (e.g., from context menus).
   */
  open?: boolean | undefined
  /** Callback when open state changes (for controlled mode) */
  onOpenChange?: ((open: boolean) => void) | undefined
  /**
   * When true, prevents the popover from closing when clicking outside.
   * Useful for context menu triggered popovers where focus management is tricky.
   */
  modal?: boolean | undefined
  /**
   * Default value to pre-fill the input with.
   * Useful when the user types something (e.g., "#Test") and clicks "Add new label" -
   * the input can be pre-filled with "Add new label Test".
   */
  defaultValue?: string | undefined
  /**
   * When true, executes the mini agent inline within the popover instead of
   * opening a new window. Best for quick config edits with mini agents.
   */
  inlineExecution?: boolean | undefined
}


/**
 * Result from buildEditPrompt containing both the full prompt and badge metadata
 * for hiding the XML context in the UI while keeping it in the actual message.
 */
export interface EditPromptResult {
  /** Full prompt including XML metadata and user instructions */
  prompt: string
  /** Badge marking the hidden metadata section */
  badges: ContentBadge[]
}
