import * as React from 'react';

import type { ToolDisplayMeta, AnnotationV1, ToolExecutionCheckpoint } from '@craft-agent/core';

import { parseDiffFromFile, type FileContents } from '@pierre/diffs';
import { getDiffStats, getUnifiedDiffStats } from '../code-viewer';

export function stripMarkdown(text: string): string {
  return stripFencedCodeMarkers(text)
    // Extract content from fenced code blocks (remove ``` and optional language)
    // Extract content from inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

export function stripFencedCodeMarkers(text: string): string {
  let result = ''
  let cursor = 0

  while (cursor < text.length) {
    const openingFence = text.indexOf('```', cursor)
    if (openingFence === -1) return result + text.slice(cursor)
    const closingFence = text.indexOf('```', openingFence + 3)
    if (closingFence === -1) return result + text.slice(cursor)

    const markerEnd = openingFence + 3
    const firstNewline = text.indexOf('\n', markerEnd)
    const languageMarker = firstNewline !== -1 && firstNewline < closingFence
      ? text.slice(markerEnd, firstNewline)
      : ''
    const hasLanguageMarker = [...languageMarker].every(character => (
      (character >= 'a' && character <= 'z')
      || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9')
      || character === '_'
    ))
    const contentStart = hasLanguageMarker && firstNewline !== -1 ? firstNewline + 1 : markerEnd

    result += text.slice(cursor, openingFence) + text.slice(contentStart, closingFence)
    cursor = closingFence + 3
  }

  return result
}

export function computeEditWriteDiffStats(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): { additions: number; deletions: number } | null {
  if (!toolInput) return null

  if (toolName === 'Edit') {
    // Check for Codex format: { changes: Array<{ path, kind, diff }> }
    if (toolInput.changes && Array.isArray(toolInput.changes)) {
      let totalAdditions = 0
      let totalDeletions = 0
      for (const change of toolInput.changes as Array<{ path?: string; diff?: string }>) {
        if (change.diff) {
          const stats = getUnifiedDiffStats(change.diff, change.path || 'file')
          if (stats) {
            totalAdditions += stats.additions
            totalDeletions += stats.deletions
          }
        }
      }
      if (totalAdditions === 0 && totalDeletions === 0) return null
      return { additions: totalAdditions, deletions: totalDeletions }
    }

    // Claude Code format: { file_path, old_string, new_string }
    const oldString = (toolInput.old_string as string) ?? ''
    const newString = (toolInput.new_string as string) ?? ''
    if (!oldString && !newString) return null

    const oldFile: FileContents = { name: 'file', contents: oldString, lang: 'text' }
    const newFile: FileContents = { name: 'file', contents: newString, lang: 'text' }
    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }

  if (toolName === 'Write') {
    const content = (toolInput.content as string) ?? ''
    if (!content) return null

    // For Write, everything is an addition (new file content)
    const oldFile: FileContents = { name: 'file', contents: '', lang: 'text' }
    const newFile: FileContents = { name: 'file', contents: content, lang: 'text' }
    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }

  return null
}

export const SIZE_CONFIG = {
  /** Base font size class for all text */
  fontSize: 'text-[13px]',
  /** Icon size class (width and height) */
  iconSize: 'w-3 h-3',
  /** Spinner text size class */
  spinnerSize: 'text-[10px]',
  /** Small spinner for header */
  spinnerSizeSmall: 'text-[8px]',
  /** Activity row height in pixels (approx for calculation) */
  activityRowHeight: 24,
  /** Max visible activities before scrolling (show ~15 items) */
  maxVisibleActivities: 15,
  /** Number of items before which we apply staggered animation */
  staggeredAnimationLimit: 10,
} as const

export type ActivityStatus = 'pending' | 'running' | 'completed' | 'error' | 'backgrounded' | 'checkpoint'

export type ActivityType = 'tool' | 'thinking' | 'intermediate' | 'status' | 'plan'

export type AnnotationInteractionMode = 'interactive' | 'tooltip-only'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'interrupted'

export interface TodoItem {
  /** Task content/description */
  content: string
  /** Current status */
  status: TodoStatus
  /** Present continuous form shown when in_progress (e.g., "Running tests") */
  activeForm?: string
}

export interface ActivityItem {
  id: string
  type: ActivityType
  status: ActivityStatus
  toolName?: string
  toolUseId?: string  // For matching parent-child relationships
  toolInput?: Record<string, unknown>
  content?: string
  intent?: string
  /** Optional backing message id (used by plan activities for branching/annotations) */
  messageId?: string
  /** Optional persisted annotations (used by plan activities) */
  annotations?: AnnotationV1[]
  displayName?: string  // LLM-generated human-friendly tool name (for MCP tools)
  toolDisplayMeta?: ToolDisplayMeta  // Embedded metadata with base64 icon (for viewer compatibility)
  timestamp: number
  error?: string
  /** False when the host closed the result envelope before invoking the tool. */
  executed?: boolean
  checkpoint?: ToolExecutionCheckpoint
  // Parent-child nesting for Task subagents
  parentId?: string  // Parent activity's toolUseId
  depth?: number     // Nesting level (0 = root, 1 = child, etc.)
  // Status activities (e.g., compacting)
  statusType?: string  // e.g., 'compacting'
  // Background task fields
  taskId?: string         // For background Task tools
  shellId?: string        // For background Bash shells
  elapsedSeconds?: number // Live progress updates
  isBackground?: boolean  // Flag for UI differentiation
}

export interface ResponseContent {
  text: string
  isStreaming: boolean
  streamStartTime?: number
  /** Whether this response is a plan (renders with plan variant) */
  isPlan?: boolean
  /** ID of the underlying message (for branching + annotations) */
  messageId?: string
  /** Persisted annotations attached to the response message */
  annotations?: AnnotationV1[]
}

export type OpenAnnotationRequest = {
  messageId: string
  annotationId: string
  mode: 'view' | 'edit'
  anchorX?: number
  anchorY?: number
  nonce: number
}

export interface TurnCardProps {
  /** Session ID for state persistence (optional in shared context) */
  sessionId?: string
  /** Turn ID for state persistence */
  turnId: string
  /** All activities in this turn (tools, thinking, intermediate text) */
  activities: ActivityItem[]
  /** Final response content (may be streaming) */
  response?: ResponseContent
  /** Primary intent/goal for this turn (shown in collapsed preview) */
  intent?: string
  /** Whether content is still being received */
  isStreaming: boolean
  /** Whether this turn is fully complete */
  isComplete: boolean
  /** Start in expanded state */
  defaultExpanded?: boolean
  /** Controlled expansion state (overrides internal state) */
  isExpanded?: boolean
  /** Callback when expansion state changes */
  onExpandedChange?: (expanded: boolean) => void
  /** Controlled expansion state for activity groups */
  expandedActivityGroups?: Set<string>
  /** Callback when activity group expansion changes */
  onExpandedActivityGroupsChange?: (groups: Set<string>) => void
  /** Callback when file path is clicked */
  onOpenFile?: (path: string) => void
  /** Callback when URL is clicked */
  onOpenUrl?: (url: string) => void
  /** Callback to open response in Monaco editor */
  onPopOut?: (text: string) => void
  /** Callback to open turn details in a new window */
  onOpenDetails?: () => void
  /** Callback to open individual activity details in Monaco */
  onOpenActivityDetails?: (activity: ActivityItem) => void
  /** Callback to open all edits/writes in multi-file diff view */
  onOpenMultiFileDiff?: () => void
  /** Whether this turn has any Edit or Write activities */
  hasEditOrWriteActivities?: boolean
  /** TodoWrite tool state - shown at bottom of turn */
  todos?: TodoItem[]
  /** Optional render prop for actions menu (Electron provides dropdown) */
  renderActionsMenu?: () => React.ReactNode
  /** Callback when user accepts the plan (plan responses only) */
  onAcceptPlan?: () => void
  /** Callback when user accepts the plan with compaction (compact conversation first, then execute) */
  onAcceptPlanWithCompact?: () => void
  /** Whether this is the last response in the session (shows Accept Plan button only for last response) */
  isLastResponse?: boolean
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed'
  /** Optional presentation variant. The default keeps the existing card-based UI. */
  presentation?: 'default' | 'codex'
  /** Animate response appearance (for playground demos) */
  animateResponse?: boolean
  /** Compact-footer layout. Used by EditPopover (popover embedding) and ChatPage in
   *  auto-compact / WebUI mobile. Hides Copy / Markdown / Branch actions; keeps the
   *  Accept Plan dropdown when a plan is the last response. */
  compactMode?: boolean
  /** Callback to branch the session from a specific message */
  onBranch?: (messageId: string, options?: { newPanel?: boolean }) => void
  /** Callback to add an annotation to a response message */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** Callback to remove a persisted annotation from a response message */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** Callback to update a persisted annotation */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Callback when follow-up is saved via "Save & Send" action */
  onSaveAndSendFollowUp?: (target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void
  /** Whether there are active pending follow-up annotations in the session */
  hasActiveFollowUpAnnotations?: boolean
  /** External request to open a specific annotation in the follow-up island */
  openAnnotationRequest?: OpenAnnotationRequest | null
  /** Annotation interaction mode (viewer uses tooltip-only to suppress the island) */
  annotationInteractionMode?: AnnotationInteractionMode
  /** Quick iteration action callback */
  onQuickAction?: (actionText: string) => void
}
