import * as React from "react";

import { type ActivityItem, type FileChange } from "@craft-agent/ui";

import type { Session, FileAttachment, PermissionRequest, CredentialRequest, CredentialResponse, LoadedSkill } from "../../../shared/types";
import type { PermissionMode } from "@craft-agent/shared/agent/modes";
import type { ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";
import { type UserInputCardProps, type Turn } from "@craft-agent/ui";

import type { RichTextInputHandle } from "@/components/ui/rich-text-input";

export function getCSSHighlights(): Map<string, Highlight> | undefined {
  try {
    return ((CSS) as { highlights?: Map<string, Highlight> }).highlights
  } catch {
    return undefined
  }
}

export interface MultiDiffOverlayState {
  type: 'multi-diff'
  changes: FileChange[]
  consolidated: boolean
  focusedChangeId?: string
}

export interface MarkdownOverlayState {
  type: 'markdown'
  content: string
  title: string
  /** When true, show raw markdown source in code viewer instead of rendered preview */
  forceCodeView?: boolean
}

export type OverlayState =
  | { type: 'activity'; activity: ActivityItem }
  | MultiDiffOverlayState
  | MarkdownOverlayState
  | null

export function isStackedActivityTool(activity: ActivityItem): boolean {
  const toolName = activity.toolName?.toLowerCase() || ''
  return toolName === 'bash' || toolName.startsWith('mcp__') || toolName.startsWith('browser_')
}

export function getTurnKey(turn: Turn): string {
  if (turn.type === 'user') return `user-${turn.message.id}`
  if (turn.type === 'system') return `system-${turn.message.id}`
  if (turn.type === 'auth-request') return `auth-${turn.message.id}`
  return `turn-${turn.turnId}-${turn.timestamp}`
}

export interface ChatDisplayProps {
  session: Session | null
  onSendMessage: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  // Model selection
  currentModel: string
  onModelChange: (model: string | null, connection?: string) => void
  /** Whether the workspace allows the model to be selected automatically. */
  // Connection selection (locked after first message)
  /** Callback when LLM connection changes (only works when session is empty) */
  onConnectionChange?: ((connectionSlug: string) => void) | undefined
  /** Ref for the input, used for external focus control */
  textareaRef?: React.RefObject<RichTextInputHandle | null> | undefined
  /** When true, disables input (e.g., when agent needs activation) */
  disabled?: boolean | undefined
  /** Pending permission request for this session */
  pendingPermission?: PermissionRequest | undefined
  /** Callback to respond to permission request */
  onRespondToPermission?: ((
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../../shared/types').PermissionResponseOptions
  ) => void) | undefined
  onRespondToUserInput?: UserInputCardProps['onRespond'] | undefined
  /** Pending credential request for this session */
  pendingCredential?: CredentialRequest | undefined
  /** Callback to respond to credential request */
  onRespondToCredential?: ((sessionId: string, requestId: string, response: CredentialResponse) => void | Promise<void>) | undefined
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel | undefined
  /** Callback when thinking level changes */
  onThinkingLevelChange?: ((level: ThinkingLevel) => void) | undefined
  // Advanced options
  /** Current permission mode */
  permissionMode?: PermissionMode | undefined
  onPermissionModeChange?: ((mode: PermissionMode) => void) | undefined
  /** Enabled permission modes for Shift+Tab cycling */
  enabledModes?: PermissionMode[] | undefined
  // Input value preservation (controlled from parent)
  /** Current input value - preserved across mode switches and conversation changes */
  inputValue?: string | undefined
  /** Callback when input value changes */
  onInputChange?: ((value: string) => void) | undefined
  /** Persisted attachment draft for this session (hydrated from disk in ChatPage) */
  attachmentsValue?: FileAttachment[] | undefined
  /** Callback when attachment draft changes (add, remove, clear on send) */
  onAttachmentsChange?: ((attachments: FileAttachment[]) => void) | undefined
  // Skill selection (for @mentions)
  /** Available skills for @mention autocomplete */
  skills?: LoadedSkill[] | undefined
  // Label selection (for #labels)
  /** Available label configs (tree) for label menu and badge display */
  labels?: import('@craft-agent/shared/labels').LabelConfig[] | undefined
  /** Callback when labels change */
  onLabelsChange?: ((labels: string[]) => void) | undefined
  // State/status selection (for # menu and ActiveOptionBadges)
  /** Available workflow states */
  sessionStatuses?: import('@/config/session-status-config').SessionStatus[] | undefined
  /** Callback when session state changes */
  onSessionStatusChange?: ((stateId: string) => void) | undefined
  /** Workspace ID for loading skill icons */
  workspaceId?: string | undefined
  // Working directory (per session)
  /** Current working directory for this session */
  workingDirectory?: string | undefined
  /** Callback when working directory changes */
  onWorkingDirectoryChange?: ((path: string) => void) | undefined
  /** Session folder path (for "Reset to Session Root" option) */
  sessionFolderPath?: string | undefined
  // Lazy loading
  /** When true, messages are still loading - show spinner in messages area */
  messagesLoading?: boolean | undefined
  /** Message load failure shown instead of an infinite spinner */
  messagesLoadError?: string | null | undefined
  /** Whether a retry is currently in flight */
  messagesRetrying?: boolean | undefined
  /** Retry lazy-loading the session transcript */
  onRetryMessagesLoad?: (() => void) | undefined
  // Tutorial
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean | undefined
  // Search highlighting (from session list search)
  /** Search query for highlighting matches - passed from session list */
  searchQuery?: string | undefined
  /** Whether search mode is active (prevents focus stealing to chat input) */
  isSearchModeActive?: boolean | undefined
  /** Callback when match info changes - for immediate UI updates */
  onMatchInfoChange?: ((info: { count: number; index: number; isHighlighting: boolean; sessionId: string | null }) => void) | undefined
  // Compact mode (for EditPopover embedding and auto-compact / WebUI mobile)
  /** Enable compact mode - hides non-essential UI elements for popover embedding */
  compactMode?: boolean | undefined
  /**
   * When compactMode is true, enable the compact (drawer-based) model selector
   * next to the permission-mode pill. Defaults to false so EditPopover keeps
   * its current behavior; ChatPage opts in when in auto-compact / mobile.
   */
  enableCompactModelPicker?: boolean | undefined
  /** Custom placeholder for input (used in compact mode for edit context) */
  placeholder?: string | string[] | undefined
  /** Label shown as empty state in compact mode (e.g., "Permission Settings") */
  emptyStateLabel?: string | undefined
  /** When true, the session's locked connection has been removed - disables send and shows unavailable state */
  connectionUnavailable?: boolean | undefined
}

export interface ChatDisplayHandle {
  goToNextMatch: () => void
  goToPrevMatch: () => void
  matchCount: number
  currentMatchIndex: number
  isHighlighting: boolean
}

export function ScrollOnMount({
  viewportRef,
  resetKey,
  onScroll,
  skip = false
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>
  resetKey: string
  onScroll?: (() => void) | undefined
  skip?: boolean | undefined
}) {
  const skippedResetKeyRef = React.useRef<string | null>(null)

  React.useLayoutEffect(() => {
    // If search consumed this session reset, a follow-up render where `skip`
    // becomes false must not override the selected match. Normal resets remain
    // repeatable so React StrictMode's second layout pass can settle at bottom.
    if (skip) {
      skippedResetKeyRef.current = resetKey
      return
    }
    if (skippedResetKeyRef.current === resetKey) return
    const viewport = viewportRef.current
    if (!viewport) return

    // Target the Radix viewport directly. scrollIntoView() can also move
    // scrollable ancestors and is less reliable while mobile layout settles.
    viewport.scrollTop = viewport.scrollHeight
    onScroll?.()
  }, [onScroll, resetKey, skip, viewportRef])
  return null
}
