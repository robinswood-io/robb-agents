/**
 * turn-utils.ts
 *
 * Utilities for grouping messages by turn for TurnCard rendering.
 * Converts the flat Message[] array into grouped turns for email-like display.
 */
import type { Message } from "@craft-agent/core";
import type { ActivityItem, ResponseContent, TodoItem } from "../TurnCard";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip error wrapper tags and prefixes from tool error messages.
 * The Claude Agent SDK wraps errors in tags like <error><tool_use_error>...</tool_use_error></error>
 * which aren't user-friendly. Additionally, errorResponse() and blockWithReason() prefix
 * messages with "[ERROR] " so the Codex model can detect failures (the OpenAI API has no
 * error signaling field). We strip that prefix here for clean UI display.
 */
export function stripErrorTags(content: string | undefined): string | undefined {
  if (!content) return content
  return content
    .replace(/<\/?error>/gi, '')
    .replace(/<\/?tool_use_error>/gi, '')
    .replace(/^\[ERROR]\s*/i, '')
    .trim()
}

// ============================================================================
// Types
// ============================================================================

/** Represents one complete assistant turn */
export interface AssistantTurn {
  type: 'assistant'
  turnId: string
  activities: ActivityItem[]
  response?: ResponseContent
  intent?: string
  isStreaming: boolean
  isComplete: boolean
  timestamp: number
  /** Extracted from TodoWrite tool - latest todo state in this turn */
  todos?: TodoItem[]
}

/** Represents a user message */
export interface UserTurn {
  type: 'user'
  message: Message
  timestamp: number
}

/** Represents a system/info/error message that stands alone */
export interface SystemTurn {
  type: 'system'
  message: Message
  timestamp: number
}

/** Represents an auth request (credential input, OAuth flow) */
export interface AuthRequestTurn {
  type: 'auth-request'
  message: Message
  timestamp: number
}

export type Turn = AssistantTurn | UserTurn | SystemTurn | AuthRequestTurn

/**
 * Build a stable UI identity key for an assistant turn card.
 *
 * Why this exists:
 * - Backend turnId can be reused across visually split assistant cards
 *   (e.g., steer/interruption boundaries).
 * - Expansion state must be keyed by UI-card identity, not raw backend turnId.
 */
export function getAssistantTurnUiKey(turn: AssistantTurn, index: number): string {
  if (turn.response?.messageId) {
    return `assistant:msg:${turn.response.messageId}`
  }
  return `assistant:turn:${turn.turnId}:${turn.timestamp}:${index}`
}

// ============================================================================
// Turn Lifecycle Phase
// ============================================================================

/**
 * TurnPhase represents the current lifecycle state of an assistant turn.
 *
 * State Machine:
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  PENDING ──(tool_start)──► TOOL_ACTIVE ──(all_tools_done)──► AWAITING      │
 * │     │                          │                                  │        │
 * │     │ text_delta               │ text_delta                       │        │
 * │     ▼                          ▼                                  │        │
 * │  STREAMING ◄───────────── STREAMING (intermediate) ◄──────────────┘        │
 * │     │                          │                                           │
 * │     │ text_complete            │ text_complete + more work coming          │
 * │     ▼                          ▼                                           │
 * │  COMPLETE                   AWAITING                                       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Key insight: The "awaiting" phase is the GAP between tool completion and
 * the next action. This was previously invisible, causing the turn card to
 * "disappear" after a tool completed.
 */
export type TurnPhase =
  | 'pending'      // Turn created, waiting for first activity
  | 'tool_active'  // At least one tool is currently running
  | 'awaiting'     // All tools done, waiting for next action (THE GAP!)
  | 'streaming'    // Final response text is actively streaming
  | 'complete'
